"""A real silent cognition loses its lease, then resumes with fixed model output."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport,SYSTEM
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,Handler,WebServer
from tests.test_llm import FixtureTransport


children=[];calls=[]
original_popen=subprocess.Popen
original_generate=CodexTransport.generate
fixture=FixtureTransport()

def launch(command,**kwargs):
    if command[:2]!=['codex','exec']:return original_popen(command,**kwargs)
    script='import sys,time;from pathlib import Path;sys.stdin.read();Path(sys.argv[1]).write_text("ready");time.sleep(60)'
    child=original_popen([sys.executable,'-u','-c',script,str(ready)],**kwargs);children.append(child);return child

def generate(transport,prompt,*args):
    calls.append(1)
    if len(calls)==1:return original_generate(transport,prompt,*args)
    return fixture.generate(SYSTEM+'\n'+prompt[prompt.index('\n{')+1:],*args)


class LeaseLossHandler(Handler):
    def dispatch(self,mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/cognition-lease-state','/__test/cognition-lease-expire'):return super().dispatch(mutation)
        self.guard(mutation)
        if path.endswith('state') and not mutation:
            return self.reply(200,{'task_id':task['run_id'],'ready':ready.exists(),'model_calls':len(calls),'children_running':sum(p.poll() is None for p in children)})
        if path.endswith('expire') and mutation:
            data=self.read_json_body(path)
            if data!={}:raise ValueError('empty object required')
            with app.control_store.transaction() as db:
                db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',(app.tenant,task['run_id']))
            return self.reply(200,{'ok':True})
        return self.reply(405,{'error':'method not allowed'})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='cognition-lease-browser-',dir='/private/tmp');ready=Path(root)/'child-ready'
    catalog={'models':[{'id':'lease-fixture','name':'Lease fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.llm.subprocess.Popen',launch),patch.object(CodexTransport,'generate',generate):
        app=Application(root)
        agent=app.agents.save({'name':'租约恢复助手','description':'隔离的执行交接验收','runtime':'codex','model':'lease-fixture',
            'options':{'timeout':60,'max_attempts':2,'reasoning_effort':'low'},'prompt':'核对变更证据。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('租约恢复助手')})
        task=app.create({'goal':'评估 change-demo-001 并创建草稿','change_id':'change-demo-001','agent_id':agent['id'],'agent_revision':1,'consent':True,'grant':True,'start':False})['run']
        TaskConversations(app).register(task)
        server=WebServer(('127.0.0.1',int(os.environ.get('COGNITION_LEASE_PORT','8799'))),app);server.RequestHandlerClass=LeaseLossHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            server.server_close();app.close()
            from agent_framework.processes import stop_process_group
            for child in children:stop_process_group(child)
