"""Complete workbench attention and old daily links, with disposable records."""
from copy import deepcopy
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch
from zoneinfo import ZoneInfo

from agent_framework.contracts import canonical
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, WebServer
from agent_framework.workspace_scheduler import WorkspaceScheduler
from tests.test_run_catalog import seed_history
from tests.test_workflow_catalog import seed_flows
from tests.test_workspaces import space


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='attention-browser-') as root, patch.object(
            ModelCatalog, 'list', return_value={'models': [], 'source': 'isolated fixture'}):
        app = Application(root)
        tasks = seed_history(app, count=19, turns=1, body_bytes=64)
        seed_flows(app, count=13)
        store = app.runtime().store
        with store.transaction() as db:
            for index, identity in enumerate(tasks):
                row = db.execute('SELECT state FROM runs WHERE tenant_id=? AND id=?', (app.tenant, identity)).fetchone()
                value = json.loads(row[0])
                value.update(status='WAITING_AUTH' if index < 9 else 'FAILED', deadline=2000000000 + index)
                db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?', (canonical(value), app.tenant, identity))
            rows = db.execute('SELECT id,data FROM workflow_runs').fetchall()
            for index, row in enumerate(rows):
                value = json.loads(row['data'])
                value.update(status='WAITING_INPUT', deadline=1900000000 + index)
                db.execute('UPDATE workflow_runs SET data=? WHERE id=?', (canonical(value), row['id']))
        scheduler = WorkspaceScheduler(app)
        first = datetime.now(ZoneInfo('Asia/Shanghai')).replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=70)
        template = scheduler.generate(first.timestamp())
        with store.transaction() as db:
            db.execute('DELETE FROM workspace_daily_plans')
            for index in range(66):
                plan = deepcopy(template)
                day = first + timedelta(days=index)
                plan.update(id='attention-plan-' + str(index).zfill(4), day=day.date().isoformat(), created_at=day.timestamp(), status='DISPATCHED', dispatch={'state': 'FAILED' if index == 0 else 'COMPLETE'})
                if index == 0:
                    plan.update(error='派发中断，等待核对', items=[{'id': 'blocked-item', 'status': 'BLOCKED', 'agent_name': '每日计划岗位', 'task': {'goal': '检索每日复盘材料', 'agent_revision': 1, 'grant': False, 'execution_mode': 'conversation'}}])
                db.execute('INSERT INTO workspace_daily_plans(tenant,workspace,principal,day,id,data,created) VALUES(?,?,?,?,?,?,?)', (*scheduler.scope, plan['day'], plan['id'], canonical(plan), plan['created_at']))
        other = app.workspaces.save(space('没有待办的空间'))
        output = Path(os.environ['ATTENTION_OUTPUT']);output.mkdir(parents=True, exist_ok=True)
        (output / 'fixture.json').write_text(json.dumps({'workspace': app.workspace['id'], 'other_workspace': other['id'], 'total': app.attention()['counts']['total'], 'failed_plan': 'attention-plan-0000', 'old_plan': 'attention-plan-0001'}))
        server = WebServer(('127.0.0.1', int(os.environ['PROJECT_REVIEW_PORT'])), app)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close();app.close()
