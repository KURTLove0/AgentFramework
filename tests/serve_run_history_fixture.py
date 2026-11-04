"""Disposable complete task history. No external models or execution dispatch."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, WebServer
from tests.test_run_catalog import seed_history
from tests.test_workspaces import space


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='run-history-browser-') as root, patch.object(
            ModelCatalog, 'list', return_value={'models': [], 'source': 'isolated fixture'}):
        app = Application(root)
        roots = seed_history(app, count=137, turns=1, body_bytes=64)
        other = app.workspaces.save(space('其他历史空间'))
        output = Path(os.environ['RUN_HISTORY_OUTPUT'])
        output.mkdir(parents=True, exist_ok=True)
        (output / 'fixture.json').write_text(json.dumps({
            'workspace': app.workspace['id'], 'other_workspace': other['id'], 'roots': roots,
        }))
        server = WebServer(('127.0.0.1', int(os.environ['PROJECT_REVIEW_PORT'])), app)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            app.close()
