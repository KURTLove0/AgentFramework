"""A real RPC child exits after a public fragment; retry uses fixed output."""
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
from agent_framework.web import Application,Handler,WebServer
from tests.test_codex_rpc_writes import HANDSHAKE


children=[];calls=[];original_popen=subprocess.Popen;original_generate=CodexTransport.generate
FRAGMENT='已保留的公开片段：第一项材料已整理，尚未完成本轮。'

def launch(command,**kwargs):
    if command[:2]!=['codex','app-server']:return original_popen(command,**kwargs)
    script=HANDSHAKE+r'''
import os
request=json.loads(sys.stdin.readline());assert request['method']=='turn/start'
emit({'id':request['id'],'result':{}})
emit({'method':'item/completed','params':{'threadId':'thread-1','item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':sys.argv[2]}}})
sys.stderr.write('PRIVATE_RAW_EXIT_DETAIL');sys.stderr.flush();os._exit(23)
'''
    child=original_popen([sys.executable,'-u','-c',script,str(Path(root)/'ready'),FRAGMENT],**kwargs);children.append(child);return child

def generate(transport,prompt,*args):
    calls.append(1)
    if len(calls)==1:return original_generate(transport,prompt,*args)
    return json.dumps({'kind':'result','summary':'已完成重试。','result':{'title':'整理结果','content':'重试成功，原先的失败记录和公开片段仍然保留。','citations':[],'limitations':[]}},ensure_ascii=False),{'usage':{'input_tokens':5,'output_tokens':5}}

class CleanupHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/process-cleanup':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:return self.reply(405,{'error':'GET required'})
        return self.reply(200,{'agent_id':agent['id'],'model_calls':len(calls),'children':[
            {'returncode':p.returncode,'pipes_closed':all(pipe.closed for pipe in (p.stdin,p.stdout,p.stderr))} for p in children]})

if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='process-cleanup-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'cleanup-fixture','name':'Cleanup fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.codex_stream.subprocess.Popen',launch),patch.object(CodexTransport,'generate',generate):
        app=Application(root)
        agent=app.agents.save({'name':'异常退出恢复助手','description':'隔离的进程收尾验收','runtime':'codex','model':'cleanup-fixture',
            'options':{'timeout':60,'max_attempts':2,'reasoning_effort':'low'},'prompt':'按目标整理材料。','skills':[],'mcp_servers':[],
            'revision':0,'definition':default_definition('异常退出恢复助手','general-assistant@1.0.0')})
        server=WebServer(('127.0.0.1',int(os.environ.get('PROCESS_CLEANUP_PORT','8799'))),app);server.RequestHandlerClass=CleanupHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            server.server_close();app.close()
            from agent_framework.processes import stop_process_group
            for child in children:stop_process_group(child)
