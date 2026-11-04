"""Real historical CLI runs, restarted workbench, disposable data, mock models."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.contracts import TaskContract
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime import Runtime
from agent_framework.web import Application,WebServer


def main():
    with tempfile.TemporaryDirectory(prefix='workspace-history-browser-') as temporary,patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated history fixture','cached':False}):
        runtime=Runtime(temporary);runs=[]
        for project,count in [('project-history-a',2),('project-history-b',1),('project-demo',1)]:
            for index in range(count):
                task=TaskContract(project_id=project,principal='demo-user',goal='历史任务-'+project+'-'+str(index))
                original=runtime.submit(task=task);finished=runtime.run(original['run_id']);assert finished['status']=='SUCCEEDED'
                runs.append({'id':finished['run_id'],'project':project,'goal':task.goal,'snapshot_hash':finished['snapshot']['hash']})
        first=Application(temporary)
        try:
            spaces={w['project_id']:w for w in first.workspaces.list()};a=spaces['project-history-a']
            first.workspaces.save({'name':'用户已命名的历史交易空间','business':'已配置业务','scenario':'保留历史任务','description':'重启后保留说明','revision':1},a['id'])
            first.workspaces.lifecycle(spaces['project-history-b']['id'],1,True)
            first.workspaces.lifecycle('workspace-default',1,True)
        finally:first.close()
        app=Application(temporary);output=Path(os.environ['WORKSPACE_HISTORY_OUTPUT']);output.mkdir(parents=True,exist_ok=True)
        (output/'fixture.json').write_text(json.dumps({'runs':runs,'spaces':app.workspaces.list()},ensure_ascii=False,indent=2))
        server=WebServer(('127.0.0.1',int(os.environ['WORKSPACE_HISTORY_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()


if __name__=='__main__':main()
