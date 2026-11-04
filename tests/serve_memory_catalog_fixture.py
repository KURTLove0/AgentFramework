"""Private memory pages in an isolated store; no external model calls."""
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,WebServer
from scripts.benchmark_library import seed


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='memory-catalog-browser-',dir='/private/tmp')
    with patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture','cached':False}):
        app=Application(root)
        seed(app,assets=0,experiences=0,memories=137,body_bytes=4096)
        with app.runtime().store.transaction() as db:
            row=db.execute("SELECT data FROM episodic_memories WHERE run_id='bench-run-136'").fetchone()
            body=json.loads(row[0]);body['summary']+=' <img src=x onerror="window.memoryXSS=1"> '+('长摘要与事实核对 '*40)+'x'*280
            db.execute("UPDATE episodic_memories SET data=? WHERE run_id='bench-run-136'",(canonical(body),))
        output=Path(os.environ['AUDIT_FIX_SEED']);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps({'workspace':app.workspace['id'],'records':137,'external_model_calls':0}),encoding='utf-8')
        server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
