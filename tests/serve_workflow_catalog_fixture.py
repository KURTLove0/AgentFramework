"""Complete workflow history fixture; no external calls or production data."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, WebServer
from tests.test_workflow_catalog import seed_flows
from tests.test_workspaces import space

if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='workflow-catalog-browser-',dir='/private/tmp')
    with patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture'}):
        app=Application(root);seed_flows(app)
        other=app.workspaces.save(space('另一流程空间'))
        output=Path(os.environ['AUDIT_FIX_SEED']);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps({'workspace':app.workspace['id'],'other_workspace':other['id'],'total':267,'oldest':'catalog-flow-0000'}))
        server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
