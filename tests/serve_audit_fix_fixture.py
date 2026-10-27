"""Disposable audit UI fixture. All model output and data are synthetic."""
import json
import os
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from agent_framework.contracts import canonical,digest
from agent_framework.learning import Learning,agent_generate
from agent_framework.llm import CodexTransport,CursorTransport,QoderTransport
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,WebServer
from serve_project_review_fixture import generate
from test_job_ontology import content,profile


def learning_generate(app,agent,purpose,context,shape,consent,offline):
    if purpose=='ontology' and context.get('instruction')=='audit-invalid-ontology':
        raw=content(context['sources'][0]['ref'])
        raw['model']['objects'][0]['values']['score']=200
        for obj in raw['model']['objects']:
            obj['values']=[{'property_id':key,'values':[value]} for key,value in obj['values'].items()]
        return raw,{'model_calls':0,'usage':[]}
    return agent_generate(app,agent,purpose,context,shape,consent,offline)


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='audit-fix-browser-')
    catalog={'models':[{'id':'review-model','name':'Synthetic fixture','efforts':['low']}],'source':'fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(CursorTransport,'generate',generate),patch.object(QoderTransport,'generate',generate),patch('agent_framework.learning.agent_generate',learning_generate):
        app=Application(root);lib=app.library();access=app.library_access();agent=app.agents.save(profile())
        source=lib.create(access,dict(title='过期状态的测试来源',content={'text':'变更 C001 产出报告 R001。'},effective_at=0,effective_until=time.time()+3*365*86400))
        def publish(asset):
            lib.transition(access,asset['ref'],'REVIEW');return lib.transition(access,asset['ref'],'PUBLISHED')
        source=publish(source);service=Learning(app)
        p=service.generate(dict(request_id='expiry-fixture',purpose='ontology',source_refs=[source['ref']],agent_id=agent['id'],agent_revision=1,operational=True))
        p=service.save(p['id'],dict(revision=p['revision'],output=content(source['ref'])))
        p=service.deposit(p['id'],dict(revision=p['revision'],item_ids=['ontology']))
        expired=publish(lib.get(access,p['receipt']['assets'][0]['ref']))
        body={k:v for k,v in expired.items() if k not in {'ref','id','version','kind','status','owner','tenant_id','project_id','environment','visibility','content_hash'}}
        body.update(effective_at=time.time()-120,effective_until=time.time()-60)
        with lib.store.transaction() as db:db.execute('UPDATE asset_versions SET data=?,hash=? WHERE tenant=? AND id=? AND version=?',(canonical(body),digest(body),access.tenant,expired['id'],expired['version']))
        seed=Path(os.environ['AUDIT_FIX_SEED']);seed.parent.mkdir(parents=True,exist_ok=True)
        seed.write_text(json.dumps({'workspace':app.workspace['id'],'expired_ref':expired['ref']}))
        server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
