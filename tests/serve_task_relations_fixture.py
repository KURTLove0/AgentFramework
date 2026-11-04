"""Disposable related tasks, archived parents and large conversation payloads."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, WebServer
from tests.test_run_catalog import seed_history
from tests.test_task_relations import link


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='task-relations-browser-') as root,patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture'}):
        app=Application(root);roots=seed_history(app,count=56,turns=2,body_bytes=4096)
        for child in roots[1:54]:link(app,child,roots[0])
        link(app,roots[53],roots[0]+'-turn-2');link(app,roots[0],roots[54]);link(app,roots[55],'unavailable-source')
        app.rename_task(roots[54],{'name':'已归档的产品改进原始任务','revision':0});app.archive_task(roots[54],{'archived':True,'revision':0})
        app.rename_task(roots[53],{'name':'移动到新受众的改进计划 <img src=x onerror=alert(1)>','revision':0});app.archive_task(roots[53],{'archived':True,'revision':0})
        output=Path(os.environ['TASK_RELATIONS_OUTPUT']);output.mkdir(parents=True,exist_ok=True)
        profile=app.control_store.load(app.tenant,roots[0])['snapshot']['agent_profile']
        (output/'fixture.json').write_text(json.dumps({'workspace':app.workspace['id'],'root':roots[0],'children':roots[1:54],'parent':roots[54],'unavailable':roots[55],'agent':profile['id']}))
        server=WebServer(('127.0.0.1',int(os.environ['TASK_RELATIONS_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
