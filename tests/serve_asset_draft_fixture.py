"""Disposable asset editor fixture with a real local-service restart switch."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from unittest.mock import patch

from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,WebServer


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='asset-draft-browser-',dir='/private/tmp');port=int(os.environ['PROJECT_REVIEW_PORT'])
    state=Path(os.environ['AUDIT_FIX_SEED']);state.parent.mkdir(parents=True,exist_ok=True);restart=state.parent/'restart-request';count=0
    def publish():
        temporary=state.with_suffix('.tmp');temporary.write_text(json.dumps({'restarts':count,'data_dir':root}),encoding='utf-8');temporary.replace(state)
    app=None;server=None;thread=None
    with patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture','cached':False}):
        try:
            while True:
                if server is None:
                    app=Application(root);server=WebServer(('127.0.0.1',port),app);thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start();publish()
                if restart.exists():
                    restart.unlink();server.shutdown();server.server_close();thread.join(2);app.close();server=None;app=None;count+=1
                time.sleep(.05)
        except KeyboardInterrupt:pass
        finally:
            if server:server.shutdown();server.server_close();thread.join(2)
            if app:app.close()
