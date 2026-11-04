"""Isolated long evaluation history, an actual task link and two private scopes."""
import json
import os
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from agent_framework.agent_evaluation import AgentEvaluations
from agent_framework.contracts import canonical,digest
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,WebServer
from tests.test_evaluation_catalog import seed_evaluations
from tests.test_workflows import role
from tests.test_workspaces import space

if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='evaluation-catalog-browser-',dir='/private/tmp')
    with patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture'}):
        app=Application(root);agent=role(app,'明细跳转助手','general-assistant@1.0.0')
        run=app.start_task({'goal':'评测历史证据跳转','agent_id':agent['id'],'agent_revision':agent['revision'],'request_id':'evaluation-history-fixture'},start=False)['run']['run_id']
        assert app.runtime().run(run)['status']=='SUCCEEDED'
        service=AgentEvaluations(app)
        with service.store.transaction() as db:
            db.execute('DELETE FROM agent_evaluations');db.execute('DELETE FROM agent_alerts')
        reports=seed_evaluations(app)
        with service.store.transaction() as db:
            report={**reports[0],'run_id':run}
            db.execute('UPDATE agent_evaluations SET run_id=?,data=? WHERE id=?',(run,canonical(report),report['id']))
            old={**reports[0],'id':'outside-window-report','run_id':'outside-window-run','agent_id':'retired-agent','agent_name':'早期历史岗位','goal':'六十天前的历史目标','run_created_at':time.time()-60*86400}
            db.execute('INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',(*service.scope,old['id'],old['run_id'],digest(old),canonical(old),old['created_at']))
        other=app.workspaces.save(space('另一评测空间'))
        output=Path(os.environ['AUDIT_FIX_SEED']);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps({'workspace':app.workspace['id'],'other_workspace':other['id'],'window_total':267,'all_total':268,'oldest':reports[0]['id'],'run':run}))
        server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
