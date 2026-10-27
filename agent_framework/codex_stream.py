"""Codex app-server inference with actual public summary and answer deltas."""
import json
import os
import queue
import signal
import subprocess
import tempfile
import threading
import time

from .agent_extensions import allowed_mcp_call, codex_mcp_args
from .contracts import canonical
from .model_stream import LIMIT, PublicProgress


def generate(transport,prompt,schema,config,timeout,profile):
    from .llm import ModelError
    with tempfile.TemporaryDirectory(prefix='agent-codex-stream-') as directory:
        command=['codex','app-server','--stdio']
        settings={'approval_policy':'never','sandbox_mode':'read-only','web_search':'disabled',
                  'model':config.model,'model_reasoning_effort':config.reasoning_effort,
                  'model_reasoning_summary':'auto','mcp_servers':{}}
        for feature in ('shell_tool','apps','plugins','hooks','multi_agent','multi_agent_v2','browser_use',
                        'computer_use','image_generation','skill_search','tool_suggest'):
            settings['features.'+feature]=False
        settings['features.skip_host_skill_discovery']=True
        # Replace the inherited MCP map before installing this task's governed
        # proxy. Login and routing remain owned by the user's CLI.
        for key,value in settings.items():command+=['-c',key+'='+json.dumps(value)]
        command+=codex_mcp_args(profile)
        try:process=subprocess.Popen(command,cwd=directory,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE,text=True,start_new_session=True)
        except OSError as exc:raise ModelError('codex_unavailable') from exc
        messages=queue.Queue(maxsize=64);stopped=threading.Event();deadline=time.monotonic()+timeout
        progress=PublicProgress('codex',getattr(transport,'progress',None) or (lambda data:None),profile)
        usage=None;answer='';calls=[];completed=False;thread_id=None;phases={};size=0;pending=''
        def reader(pipe,label):
            try:
                while not stopped.is_set():
                    line=pipe.readline(65536)
                    if not line:break
                    while not stopped.is_set():
                        try:messages.put((label,line),timeout=.1);break
                        except queue.Full:pass
            finally:
                if not stopped.is_set():
                    try:messages.put((label,None),timeout=.2)
                    except queue.Full:pass
        readers=[threading.Thread(target=reader,args=(getattr(process,label),label),daemon=True) for label in ('stdout','stderr')]
        for thread in readers:thread.start()
        def send(data):process.stdin.write(canonical(data)+'\n');process.stdin.flush()
        def handle(message):
            nonlocal usage,answer,completed
            method=message.get('method');data=message.get('params',{})
            if not isinstance(data,dict):raise ModelError('invalid_model_envelope')
            if message.get('id') is not None and method:
                send({'id':message['id'],'error':{'code':-32601,'message':'Unsupported operation'}})
                raise ModelError('unexpected_model_tool_request')
            if thread_id and data.get('threadId') not in (None,thread_id):return
            if method=='item/agentMessage/delta':
                identity=data.get('itemId','answer')
                if phases.get(identity)=='commentary':progress.summary(data.get('delta'),identity,delta=True)
                else:progress.feed({'type':'agent_message_delta','item_id':identity,'delta':data.get('delta')})
            elif method=='item/reasoning/summaryTextDelta':
                progress.feed({'type':'reasoning_summary_delta','item_id':data.get('itemId','summary')+':'+str(data.get('summaryIndex',0)),'delta':data.get('delta')})
            elif method in ('item/started','item/completed'):
                item=data.get('item',{});kind=item.get('type');identity=item.get('id','answer')
                if kind=='agentMessage':
                    phases[identity]=item.get('phase')
                    if method=='item/completed':
                        if item.get('phase')=='commentary':progress.summary(item.get('text'),identity)
                        else:answer=item.get('text','');progress.message(answer,identity)
                elif kind=='reasoning':
                    for index,text in enumerate(item.get('summary',[])):
                        progress.summary(text,identity+':'+str(index))
                    # item.content and reasoning/textDelta are private, ignored.
                elif kind=='mcpToolCall':
                    normalized={**item,'type':'mcp_tool_call'}
                    call=allowed_mcp_call(normalized,profile)
                    if not call:raise ModelError('unexpected_model_item_mcpToolCall')
                    progress.feed({'type':'item.started' if method=='item/started' else 'item.completed','item':normalized})
                    if method=='item/completed':calls.append(call)
                elif kind not in ('userMessage','plan'):raise ModelError('unexpected_model_item_'+str(kind))
            elif method=='thread/tokenUsage/updated':
                total=data.get('tokenUsage',{}).get('total',{})
                if any(type(total.get(key)) is not int or total[key]<0 for key in ('inputTokens','outputTokens')):raise ModelError('invalid_model_usage')
                usage={'input_tokens':total['inputTokens'],'output_tokens':total['outputTokens']}
            elif method=='turn/completed':
                if data.get('turn',{}).get('status')!='completed':raise ModelError('codex_turn_failed')
                completed=True;progress.flush()
            elif method=='turn/started':progress.feed({'type':'turn.started'})
            elif method=='error' and not data.get('willRetry'):raise ModelError('codex_turn_failed')
        def receive():
            nonlocal size,pending
            while True:
                if callable(getattr(transport,'should_cancel',None)) and transport.should_cancel():raise ModelError('task_cancelled')
                if time.monotonic()>=deadline:raise ModelError('model_timeout')
                try:label,line=messages.get(timeout=.05)
                except queue.Empty:
                    progress.flush()
                    if process.poll() is not None:raise ModelError('codex_exit_'+str(process.returncode))
                    continue
                if line is None:
                    if label=='stdout':raise ModelError('incomplete_model_turn')
                    continue
                size+=len(line.encode())
                if size>LIMIT:raise ModelError('invalid_model_envelope')
                if label=='stderr':continue
                pending+=line
                if '\n' not in pending:continue
                line,pending=pending.split('\n',1)
                try:value=json.loads(line)
                except (ValueError,RecursionError) as exc:raise ModelError('invalid_model_envelope') from exc
                if not isinstance(value,dict):raise ModelError('invalid_model_envelope')
                handle(value);return value
        def response(identity):
            while True:
                message=receive()
                if message.get('id')==identity:
                    if 'error' in message:raise ModelError('codex_request_rejected')
                    return message.get('result',{})
        try:
            send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'agent-framework-stream','version':'1.0.0'}}})
            response(1);send({'method':'initialized'})
            send({'id':2,'method':'thread/start','params':{'model':config.model,'cwd':directory,'approvalPolicy':'never',
                'sandbox':'read-only','ephemeral':True,'baseInstructions':'Follow the supplied bounded task contract. Use only configured read tools. Return the requested result, never private reasoning.'}})
            thread_id=response(2)['thread']['id']
            send({'id':3,'method':'turn/start','params':{'threadId':thread_id,'input':[{'type':'text','text':prompt}],
                'effort':config.reasoning_effort,'summary':'auto','outputSchema':schema}})
            response(3)
            while not completed:receive()
            if not answer or len(answer.encode())>1024*1024:raise ModelError('incomplete_model_turn')
            if usage is None:raise ModelError('invalid_model_usage')
            return answer,{'usage':usage,'model':config.model,'mcp_calls':calls}
        finally:
            stopped.set()
            if process.poll() is None:
                try:os.killpg(process.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:process.wait(timeout=1)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=1)
            for pipe in (process.stdin,process.stdout,process.stderr):pipe.close()
            for thread in readers:thread.join(timeout=1)
