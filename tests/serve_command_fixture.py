"""Isolated command search catalogs and long history; no external model calls."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, WebServer
from tests.test_run_catalog import seed_history
from tests.test_skill_catalog import package
from tests.test_workflows import role, definition
from tests.test_workspaces import space


if __name__ == '__main__':
    root = tempfile.mkdtemp(prefix='command-browser-', dir='/private/tmp')
    with patch.object(ModelCatalog, 'list', return_value={'models': [], 'source': 'isolated fixture'}):
        app = Application(root)
        runs = seed_history(app, count=251, turns=1, prefix='command-history', body_bytes=128)
        agents = [role(app, '命令检索助手 ' + str(i).zfill(2), 'general-assistant@1.0.0') for i in range(31)]
        workflow = app.workflows().save({**definition([agents[0]]), 'name': '目标流程卡片'})
        asset = app.library().create(app.library_access(), {'kind': 'KNOWLEDGE', 'title': '正文匹配验收资料', 'content': {'text': '唯一正文检索词 bodyneedle'}})
        skill = app.skills().save(package('command-method'))
        other = app.workspaces.save(space('另一检索空间'))
        role(app.scoped(other['id']), '另一空间专用助手', 'general-assistant@1.0.0')
        output = Path(os.environ['AUDIT_FIX_SEED'])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'workspace': app.workspace['id'], 'other_workspace': other['id'], 'agents': len(agents),
                                      'runs': len(runs), 'oldest': runs[0], 'workflow': workflow['id'], 'asset': asset['ref'], 'skill': skill['id'], 'external_model_calls': 0}), encoding='utf-8')
        server = WebServer(('127.0.0.1', int(os.environ['PROJECT_REVIEW_PORT'])), app)
        print('Isolated data: ' + root, flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            app.close()
