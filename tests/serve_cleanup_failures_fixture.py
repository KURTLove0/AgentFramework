"""A model times out and cannot be signalled until explicit fixture inspection."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport
from agent_framework.model_catalog import ModelCatalog
from agent_framework.processes import stop_process_group
from agent_framework.web import Application,Handler,WebServer
from agent_framework.task_conversations import TaskConversations
from tests.test_codex_rpc_writes import HANDSHAKE

children=[];calls=[];denials=[];original_popen=subprocess.Popen;original_generate=CodexTransport.generate
FRAGMENT='已保存的公开片段：本轮尚未完成。'

def launch(command,**kwargs):
    if command[:2]!=['codex','app-server']:return original_popen(command,**kwargs)
    script=HANDSHAKE+r'''
import time
request=json.loads(sys.stdin.readline());assert request['method']=='turn/start'
emit({'id':request['id'],'result':{}})
emit({'method':'item/completed','params':{'threadId':'thread-1','item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':sys.argv[2]}}})
sys.stderr.write('PRIVATE_CLEANUP_DETAIL');sys.stderr.flush();time.sleep(30)
'''
    child=original_popen([sys.executable,'-u','-c',script,str(Path(root)/'ready'),FRAGMENT],**kwargs);children.append(child);return child

def denied(child):
    denials.append(child.pid);raise PermissionError('PRIVATE_DENIAL_DETAIL')

def generate(transport,prompt,*args):
    calls.append(1)
    if len(calls)==1:return original_generate(transport,prompt,*args)
    return json.dumps({'kind':'result','summary':'已完成新轮次。','result':{'title':'整理结果','content':'检查运行环境后，本次显式重试已完成。','citations':[],'limitations':[]}},ensure_ascii=False),{'usage':{'input_tokens':5,'output_tokens':5}}

class CleanupHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path=='/__test/cleanup-queue':
            self.guard(mutation)
            if not mutation:return self.reply(405,{'error':'POST required'})
            app=self.server.application
            run=app.start_task({'goal':'检查清理暂停后的队列','agent_id':agent['id'],'agent_revision':1,'request_id':'cleanup-queue'},start=False)['run']
            with patch.object(TaskConversations,'dispatch',return_value=False):
                service=TaskConversations(app)
                service.append(run['run_id'],{'content':'环境检查后才执行的消息','request_id':'queued-next','revision':1})
                service.append(run['run_id'],{'content':'准备取消的排队消息','request_id':'queued-cancel','revision':2})
            app.schedule(run['run_id'])
            return self.reply(200,{'root':run['run_id']})
        if urlsplit(self.path).path!='/__test/cleanup-failures':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:
            for child in children:stop_process_group(child)
        return self.reply(200,{'agent_id':agent['id'],'model_calls':len(calls),'denials':len(denials),'children':[
            {'running':p.poll() is None,'pipes_closed':all(pipe.closed for pipe in (p.stdin,p.stdout,p.stderr))} for p in children]})

if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='cleanup-failure-browser-',dir='/private/tmp') as root:
        catalog={'models':[{'id':'cleanup-fixture','name':'Cleanup fixture','efforts':['low']}],'source':'isolated fixture'}
        with patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.codex_stream.subprocess.Popen',launch),patch.object(CodexTransport,'generate',generate),patch('agent_framework.codex_stream.stop_process_group',denied):
            app=Application(root)
            agent=app.agents.save({'name':'进程清理验收助手','description':'隔离的清理拒绝验收','runtime':'codex','model':'cleanup-fixture',
                'options':{'timeout':3,'max_attempts':2,'reasoning_effort':'low'},'prompt':'按目标整理材料。','skills':[],'mcp_servers':[],
                'revision':0,'definition':default_definition('进程清理验收助手','general-assistant@1.0.0')})
            server=WebServer(('127.0.0.1',int(os.environ.get('PROCESS_CLEANUP_PORT','8799'))),app);server.RequestHandlerClass=CleanupHandler
            try:server.serve_forever()
            except KeyboardInterrupt:pass
            finally:
                server.server_close();app.close()
                for child in children:stop_process_group(child)
