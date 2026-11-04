"""A real app-server handshake followed by stdin backpressure, without a model."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,Handler,WebServer
from tests.test_codex_rpc_writes import HANDSHAKE


records={};active=threading.local();original_popen=subprocess.Popen;original_generate=CodexTransport.generate

def launch(command,**kwargs):
    if command[:2]!=['codex','app-server']:return original_popen(command,**kwargs)
    record=active.record
    # Mark ready only after the beginning of turn/start reaches the pipe. The
    # remainder is larger than the pipe capacity and is intentionally unread.
    script=HANDSHAKE.replace("Path(sys.argv[1]).write_text('ready')",'')+"import os;os.read(0,1);Path(sys.argv[1]).write_text('ready');time.sleep(60)"
    child=original_popen([sys.executable,'-u','-c',script,str(record['ready'])],**kwargs);record['children'].append(child);return child

def generate(transport,prompt,*args):
    request=json.loads(prompt[prompt.index('\n{')+1:]);task=request['context']['task'];identity=task['conversation_context']['task_id']
    if task['conversation_context']['turn']==1:return reply()
    record=records.setdefault(identity,{'task_id':identity,'model_calls':0,'children':[],'ready':Path(root)/(identity+'-ready'),'prompt_bytes':len(prompt.encode())})
    record['model_calls']+=1
    if record['model_calls']==1:
        active.record=record
        try:return original_generate(transport,prompt,*args)
        finally:active.record=None
    return reply()

def reply():
    return json.dumps({'kind':'result','summary':'本轮已完成。','result':{'title':'后续回复','content':'已继续处理保留的任务。','citations':[],'limitations':[]}},ensure_ascii=False),{'usage':{'input_tokens':5,'output_tokens':5}}

class RPCWriteHandler(Handler):
    def dispatch(self,mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/rpc-write-state','/__test/rpc-write-expire'):return super().dispatch(mutation)
        self.guard(mutation)
        if path.endswith('state') and not mutation:
            return self.reply(200,{'agents':agents,'records':[{k:v for k,v in r.items() if k not in ('children','ready')}|{'ready':r['ready'].exists(),'children_running':sum(p.poll() is None for p in r['children'])} for r in records.values()]})
        if path.endswith('expire') and mutation:
            data=self.read_json_body(path);identity=data['task_id'];assert identity in records
            with app.control_store.transaction() as db:
                run_id=db.execute('SELECT run_id FROM task_conversation_turns WHERE tenant=? AND task_id=? AND number=2',(app.tenant,identity)).fetchone()['run_id']
                db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',(app.tenant,run_id))
            return self.reply(200,{'ok':True})
        return self.reply(405,{'error':'method not allowed'})

if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='rpc-write-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'rpc-write-fixture','name':'RPC write fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.codex_stream.subprocess.Popen',launch),patch.object(CodexTransport,'generate',generate):
        app=Application(root);agents={}
        for mode,timeout in (('stop',60),('lease',60),('timeout',2)):
            agent=app.agents.save({'name':'输入恢复助手 '+mode,'description':'隔离的管道背压验收','runtime':'codex','model':'rpc-write-fixture',
                'options':{'timeout':timeout,'max_attempts':2,'reasoning_effort':'low'},'prompt':'按要求处理。'+'材料😀'*2600,
                'skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('输入恢复助手 '+mode,'general-assistant@1.0.0')})
            agents[mode]=agent['id']
        server=WebServer(('127.0.0.1',int(os.environ.get('RPC_WRITE_PORT','8799'))),app);server.RequestHandlerClass=RPCWriteHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            server.server_close();app.close()
            from agent_framework.processes import stop_process_group
            for record in records.values():
                for child in record['children']:stop_process_group(child)
