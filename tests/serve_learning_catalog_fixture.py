"""Make one accepted offline request older than 235 synthetic proposal records."""
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from agent_framework.contracts import canonical,digest
from agent_framework.learning import agent_generate
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,WebServer


def generate(app,profile,purpose,context,shape,consent,offline):
    if profile['runtime']!='mock':raise ValueError('This fixture only permits offline generation')
    output,usage=agent_generate(app,profile,purpose,context,shape,consent,offline)
    if context.get('instruction')=='catalog-recovery-fixture':
        store=app.runtime().store;scope=(app.tenant,app.workspace['id'],app.principal)
        with store.transaction() as db:
            accepted=db.execute('SELECT * FROM learning_proposals WHERE tenant=? AND workspace=? AND principal=? AND status=? ORDER BY rowid DESC LIMIT 1',(*scope,'GENERATING')).fetchone()
            value=json.loads(accepted['data'])
            for i in range(235):
                copied=deepcopy(value);copied.update(request_id='newer-request-'+str(i),request_hash=digest(['fixture',i]),output=deepcopy(output),generation=usage,created_at=time.time()+i,fixture_padding='x'*32768)
                db.execute('INSERT INTO learning_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',(*scope,'newer-proposal-'+str(i),copied['request_id'],purpose,'',2,'DRAFT',canonical(copied)))
        path=Path(os.environ['AUDIT_FIX_SEED']);path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps({'id':accepted['id'],'request_id':accepted['request_id'],'newer_records':235,'model_calls':0}),encoding='utf-8')
    return output,usage


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='learning-catalog-browser-',dir='/private/tmp')
    with patch('agent_framework.learning.agent_generate',generate),patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture','cached':False}):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
