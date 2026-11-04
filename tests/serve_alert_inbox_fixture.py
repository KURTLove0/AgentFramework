"""An old actionable alert behind 230 already-read records, with real run links."""
import json
import os
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from agent_framework.agent_evaluation import AgentEvaluations
from agent_framework.contracts import canonical,digest
from agent_framework.definitions import default_definition
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application,WebServer
from test_alert_inbox import seed_alerts
from scripts.benchmark_library import seed as seed_memories


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='alert-inbox-browser-',dir='/private/tmp')
    with patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture','cached':False}):
        app=Application(root)
        agent=app.agents.save({'name':'提醒证据验收助手','description':'离线验收','runtime':'mock','model':'builtin','options':{},
            'prompt':'整理给定信息','skills':[],'mcp_servers':[],'definition':default_definition('提醒证据验收助手','general-assistant@1.0.0'),'revision':0})
        run=app.start_task({'goal':'提醒证据跳转验收','agent_id':agent['id'],'agent_revision':agent['revision'],'request_id':'alert-evidence-fixture'},start=False)['run']['run_id']
        assert app.runtime().run(run)['status']=='SUCCEEDED'
        seed_alerts(app)
        seed_memories(app,assets=0,experiences=0,memories=137,body_bytes=1024)
        service=AgentEvaluations(app);now=time.time()
        report={'id':'inbox-evaluation-0','run_id':run,'agent_id':'inbox-agent-0','agent_name':'提醒助手 0','agent_revision':1,
            'goal':'较早提醒对应的历史评测','created_at':now,'run_created_at':now,'verdict':'FAIL','score':40,
            'identity':{'role':'历史岗位'},'policy':{'threshold':80},'rubric':'synthetic-inbox-fixture','dimensions':[],
            'reasons':['合成评测提醒，用于检验历史入口'],'responsibilities':[],'standards':[],'evidence_refs':[],
            'snapshot_hash':'fixture','assessment':{'scope':'STRUCTURAL'}}
        with service.store.transaction() as db:
            db.execute('INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',(*service.scope,report['id'],run,digest(report),canonical(report),now))
            other={**report,'id':'inbox-evaluation-1','agent_id':'inbox-agent-1','agent_name':'提醒助手 1','goal':'另一条提醒对应的历史评测'}
            db.execute('INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',(*service.scope,other['id'],run,digest(other),canonical(other),now))
            for identity in ['inbox-alert-0','inbox-alert-60']:
                value=json.loads(db.execute('SELECT data FROM agent_alerts WHERE id=?',(identity,)).fetchone()[0])
                if identity=='inbox-alert-0':value['run_id']=run
                else:value['message']='<img src=x onerror="window.alertXSS=1"> '+('较长提醒与证据核对 '*30)+'x'*240
                db.execute('UPDATE agent_alerts SET data=? WHERE id=?',(canonical(value),identity))
        output=Path(os.environ['AUDIT_FIX_SEED']);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps({'workspace':app.workspace['id'],'run':run,'pending':61,'acknowledged':230,'memories':138}),encoding='utf-8')
        server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app)
        print('Isolated data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
