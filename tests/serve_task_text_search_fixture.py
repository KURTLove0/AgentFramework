"""Disposable task catalog with messages whose keywords are absent from titles."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.task_favorites import update as favorite
from agent_framework.web import Application,WebServer
from tests.test_run_catalog import seed_history
from tests.test_workspaces import space


class HeldApp(Application):
    def has_job_capacity(self,**kwargs):return False


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='task-text-search-') as root,patch.object(ModelCatalog,'list',return_value={'models':[],'source':'fixture'}):
        app=HeldApp(root);roots=seed_history(app,count=105,turns=3,body_bytes=128)
        with app.control_store.transaction() as db:
            for identity in roots:
                child=identity+'-turn-3';state=json.loads(db.execute('SELECT state FROM runs WHERE tenant_id=? AND id=?',(app.tenant,child)).fetchone()[0])
                state['report']={'content':'# 交付结论\n\n青禾项目：下周五交付正式文档。\n\n'+'评审说明与补充资料。\n'*25+'\n行末专用词 TOPAZ-[a+b]%_ 😀 <img src=x onerror=alert(1)>','citations':[],'limitations':[]}
                db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),app.tenant,child))
        app.archive_task(roots[0],{'archived':True,'revision':0});favorite(app,roots[1],{'favorited':True,'revision':0})
        TaskConversations(app).append(roots[2],{'content':'只在追加要求中：保持蓝色封面','request_id':'queued-search','revision':3})
        other=app.workspaces.save(space('独立搜索空间'));seed_history(app.scoped(other['id']),count=1,prefix='other-space')
        output=Path(os.environ['TASK_TEXT_SEARCH_OUTPUT']);output.mkdir(parents=True,exist_ok=True)
        (output/'fixture.json').write_text(json.dumps({'workspace':app.workspace['id'],'other_workspace':other['id'],'roots':roots}))
        server=WebServer(('127.0.0.1',int(os.environ['TASK_TEXT_SEARCH_PORT'])),app)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
