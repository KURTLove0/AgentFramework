"""Legacy plan-stage task using real local pipes instead of a model service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,Handler,WebServer


children=[]
original_popen=subprocess.Popen

def launch(command,**kwargs):
    if command[:2]!=['codex','exec']:return original_popen(command,**kwargs)
    script='import sys,time;from pathlib import Path;sys.stdin.read();Path(sys.argv[1]).write_text("ready");time.sleep(60)'
    child=original_popen([sys.executable,'-u','-c',script,str(ready)],**kwargs);children.append(child);return child


class WorkflowStopHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/workflow-stop-state':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:return self.reply(405,{'error':'GET required'})
        return self.reply(200,{'task_id':task['run_id'],'ready':ready.exists(),'children_started':len(children),'children_running':sum(p.poll() is None for p in children)})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='workflow-model-stop-browser-',dir='/private/tmp');ready=Path(root)/'child-ready'
    catalog={'models':[{'id':'workflow-stop-fixture','name':'Workflow stop fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.llm.subprocess.Popen',launch):
        app=Application(root)
        agent=app.agents.save({'name':'工作流停止助手','description':'隔离的旧式任务验收','runtime':'codex','model':'workflow-stop-fixture',
            'options':{'timeout':60,'max_attempts':2,'reasoning_effort':'low'},'prompt':'核对变更证据。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('工作流停止助手')})
        task=app.create({'goal':'评估 change-demo-001 并创建草稿','change_id':'change-demo-001','agent_id':agent['id'],'agent_revision':1,'consent':True,'start':False})['run']
        TaskConversations(app).register(task)
        server=WebServer(('127.0.0.1',int(os.environ.get('WORKFLOW_MODEL_STOP_PORT','8799'))),app);server.RequestHandlerClass=WorkflowStopHandler
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:
            server.server_close();app.close()
            from agent_framework.processes import stop_process_group
            for child in children:stop_process_group(child)
