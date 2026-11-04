"""Disposable browser fixture for real citation validation and synthetic model inputs."""
from copy import deepcopy
import json
import os
import tempfile
import threading
import time
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.contracts import canonical,digest
from agent_framework.definitions import default_definition
from agent_framework.knowledge import Library
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.read_proxy import ReadCapabilityProxy
from agent_framework.web import Application,Handler,WebServer

source_text='会议规则'*997
report_text='上一轮已确认会议规则，后续请保留这份结论。'
rewrite_text='沿用此前资料的改写结论：会议安排按原规则执行。'
native_source_text='NATIVE_TOOL_ONLY_TEXT: confidential synthetic note.'
paused=threading.Event()
retry_waiting=threading.Event()
retry_release=threading.Event()
inputs=[]


def generate(transport,prompt,schema,config,timeout):
    request=json.loads(prompt[prompt.index('\n{')+1:]);context=request['context'];history=context['task']['conversation_context']
    inputs.append({'task_id':history['task_id'],'turn':history['turn'],'phase':request['phase'],'context_hash':digest(history),
        'manifest_id':context['context_manifest']['id'],'messages':deepcopy(history['messages']),'goal':context['task']['goal'],
        'has_previous_reply':any(m['content']==report_text for m in history['messages']),
        'has_rewrite':any(m['content']==rewrite_text for m in history['messages']),
        'knowledge_refs':[d['ref'] for d in context['knowledge']],
        'has_source_content':source_text in canonical(context),
        'has_duplicate_quote':source_text in canonical(history)})
    if history['turn']==1 and '重试资料验收' in context['task']['goal']:
        if sum(i['task_id']==history['task_id'] for i in inputs)==1:
            retry_waiting.set()
            if transport.progress:transport.progress({'kind':'summary','text':'正在核对当前资料。','source':'fixture'})
            deadline=time.monotonic()+min(timeout,25)
            while not retry_release.wait(.02):
                if transport.should_cancel and transport.should_cancel():raise ModelError('task_cancelled')
                if time.monotonic()>=deadline:raise ModelError('model_timeout')
            return '{"broken":',{'usage':{'input_tokens':20,'output_tokens':10}}
        result={'title':'重新核对结果','content':'已重新核对，原资料已撤回，请提供当前有效资料。','citations':[],'limitations':[]}
    elif history['turn']==1 and '原生读取验收' in context['task']['goal']:
        proxy=ReadCapabilityProxy(root);token=transport.governed_profile['mcp_servers'][0]['args'][-1]
        proxy.call(token,'knowledge_search',{'project_id':app.workspace['project_id'],'query':'nativebrowserneedle'})
        observed=proxy.call(token,'knowledge_read',{'project_id':app.workspace['project_id'],'asset_refs':[native_source['ref']]})
        result={'title':'工具读取结果','content':observed['data']['documents'][0]['content']['text'],'citations':[],'limitations':[]}
    elif history['turn']==1 and '无引用资料验收' in context['task']['goal']:
        doc=next(d for d in context['knowledge'] if d['ref']==source['ref'])
        result={'title':'资料整理结果','content':doc['content']['text'],'citations':[],'limitations':[]}
    elif history['turn']==1:
        doc=next(d for d in context['knowledge'] if d['ref']==source['ref'])
        citation={'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'quote':doc['content']['text'],'evidence_ref':context['context_manifest']['id']}
        result={'title':'会议规则结论','content':report_text,'citations':[dict(citation) for _ in range(8)],'limitations':[]}
    elif len(context['task']['goal'])>2000:
        result={'title':'长消息接收结果','content':'已完整收到 '+str(len(context['task']['goal']))+' 字消息，可以继续处理。','citations':[],'limitations':[]}
    elif '换一种说法' in context['task']['goal']:
        result={'title':'改写结果','content':rewrite_text,'citations':[],'limitations':[]}
    else:
        redacted=any('来源已失效' in m['content'] for m in history['messages'])
        result={'title':'续问结果','content':'历史来源已失效，请提供当前有效资料。' if redacted else '已保留上一轮结论继续处理。', 'citations':[],'limitations':[]}
    return json.dumps({'kind':'result','summary':'已检查实际收到的历史。','result':result},ensure_ascii=False),{'usage':{'input_tokens':20,'output_tokens':10}}


class HistoryHandler(Handler):
    def dispatch(self,mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/history-state','/__test/history-pause','/__test/history-release','/__test/history-withdraw','/__test/retry-release'):return super().dispatch(mutation)
        self.guard(mutation)
        if path.endswith('history-state') and not mutation:return self.reply(200,{'agent_id':agent['id'],'native_agent_id':native_agent['id'],'retry_agent_id':retry_agent['id'],'retry_waiting':retry_waiting.is_set(),'native_source_ref':native_source['ref'],'inputs':inputs,'paused':paused.is_set(),'source_ref':source['ref']})
        if not mutation:return self.reply(405,{'error':'POST required'})
        data=self.read_json_body(path)
        if path.endswith('history-pause'):paused.set()
        elif path.endswith('history-release'):paused.clear()
        elif path.endswith('retry-release'):retry_release.set()
        elif path.endswith('history-withdraw'):
            ref=data.get('source_ref',source['ref'])
            if ref not in (source['ref'],native_source['ref']):raise ValueError('unknown fixture source')
            library.transition(app.library_access(),ref,'WITHDRAWN')
        return self.reply(200,{'ok':True})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='history-context-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'history-fixture','name':'History fixture','efforts':['low'],'default_effort':'low'}],'source':'isolated fixture','cached':False}
    original_schedule=Application.schedule
    def schedule(application,*args,**kwargs):
        if paused.is_set():return
        return original_schedule(application,*args,**kwargs)
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(Application,'schedule',schedule):
        app=Application(root);library=Library(app.control_store)
        source=library.create(app.library_access(),{'kind':'KNOWLEDGE','title':'会议规则','content':{'text':source_text}})
        library.transition(app.library_access(),source['ref'],'REVIEW');library.transition(app.library_access(),source['ref'],'PUBLISHED')
        agent=app.agents.save({'name':'历史上下文助手','description':'隔离的引用与续问验收','runtime':'codex','model':'history-fixture','options':{'timeout':30,'max_attempts':1,'reasoning_effort':'low'},'prompt':'根据有效来源回答。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('历史上下文助手','general-assistant@1.0.0')})
        retry_agent=app.agents.save({'name':'重试上下文助手','description':'隔离的格式重试验收','runtime':'codex','model':'history-fixture','options':{'timeout':30,'max_attempts':2,'reasoning_effort':'low'},'prompt':'根据当前有效来源回答。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('重试上下文助手','general-assistant@1.0.0')})
        native_source=library.create(app.library_access(),{'kind':'KNOWLEDGE','title':'nativebrowserneedle','content':{'text':native_source_text}})
        library.transition(app.library_access(),native_source['ref'],'REVIEW');library.transition(app.library_access(),native_source['ref'],'PUBLISHED')
        definition=default_definition('原生读取助手','general-assistant@1.0.0');definition['native_read_refs']=['knowledge.search@1.0.0','knowledge.read@1.0.0']
        native_agent=app.agents.save({'name':'原生读取助手','description':'隔离读取验收','runtime':'codex','model':'history-fixture','options':{'timeout':30,'max_attempts':1,'reasoning_effort':'low'},'prompt':'按需读取有效资料。','skills':[],'mcp_servers':[],'revision':0,'definition':definition})
        server=WebServer(('127.0.0.1',int(os.environ.get('HISTORY_CONTEXT_PORT','8799'))),app);server.RequestHandlerClass=HistoryHandler
        print('Fixture data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:paused.clear();retry_release.set();server.server_close();app.close()
