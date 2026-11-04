"""Complete latest-per-execution evaluation history and consistent private summaries."""
import base64
from copy import copy
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.agent_evaluation import AgentEvaluations
from agent_framework.contracts import canonical, digest
from agent_framework.web import Application, WebServer


def seed_evaluations(app, count=267):
    service=AgentEvaluations(app);now=time.time();reports=[]
    with service.store.transaction() as db:
        for i in range(count):
            report={'id':'catalog-evaluation-'+str(i).zfill(4),'run_id':'catalog-task-'+str(i).zfill(4),
                'agent_id':'historical-agent' if i==0 else 'catalog-agent','agent_name':'历史岗位' if i==0 else '评测岗位','agent_revision':1,
                'goal':'历史评测目标 '+str(i).zfill(4),'created_at':now-100+i//2,'run_created_at':now-86400,
                'verdict':['PASS','FAIL','EXCLUDED','SIMULATED'][i%4],'score':None if i%4 in (2,3) else 100 if i%4==0 else 40,
                'status':'CANCELLED' if i%4==2 else 'SUCCEEDED','identity':{'role':'冻结岗位'},'policy':{'threshold':80},
                'rubric':'job-history@2.1.0','assessment':{'scope':'STRUCTURAL','label':'结构检查分'},
                'dimensions':[],'reasons':['检验历史定位'],'responsibilities':[],'standards':[],'evidence_refs':[],
                'snapshot_hash':'fixture','padding':'EVALUATION_BODY_ONLY_'+'x'*8192}
            db.execute('INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',(*service.scope,report['id'],report['run_id'],digest(report),canonical(report),report['created_at']))
            reports.append(report)
    return reports


class EvaluationCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.service=AgentEvaluations(self.app);self.reports=seed_evaluations(self.app)

    def page(self,**options):return self.service.page(**options)

    def insert(self,report):
        with self.service.store.transaction() as db:
            db.execute('INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',(*self.service.scope,report['id'],report['run_id'],digest(report),canonical(report),report['created_at']))

    def test_all_latest_reports_are_reachable_in_generation_order(self):
        ids=[];cursor=None
        while True:
            page=self.page(cursor=cursor);self.assertEqual(page['total'],267);self.assertEqual(page['offset'],len(ids))
            ids.extend(r['id'] for r in page['reports'])
            if not page['has_more']:break
            cursor=page['next_cursor']
        self.assertEqual(ids,[r['id'] for r in reversed(self.reports)])
        self.assertEqual(len(self.service.overview()['reports']),200)

    def test_agent_verdict_and_keyword_filter_before_page_limit(self):
        page=self.page(agent_id='historical-agent');self.assertEqual(page['filtered_total'],1);self.assertEqual(page['reports'][0]['id'],self.reports[0]['id'])
        self.assertEqual(self.page(search='目标 0000')['filtered_total'],1)
        self.assertEqual(self.page(verdict='FAIL')['filtered_total'],67)
        self.assertEqual(self.page(search=self.reports[12]['run_id'])['reports'][0]['id'],self.reports[12]['id'])
        self.assertEqual(self.page(search='missing')['reports'],[])

    def test_all_time_history_is_separate_from_window_aggregates(self):
        self.insert({**self.reports[0],'id':'very-old-report','run_id':'very-old-run','agent_id':'retired-agent','agent_name':'已移除岗位','run_created_at':time.time()-60*86400})
        window=self.page();all_time=self.page(period='all')
        self.assertEqual(window['total'],267);self.assertEqual(all_time['total'],268)
        self.assertEqual(window['agents'],all_time['agents']);self.assertEqual(all_time['window_total'],267)
        self.assertIn('retired-agent',{a['id'] for a in window['report_agents']})
        self.assertEqual(self.page(period='all',agent_id='retired-agent')['filtered_total'],1)

    def test_re_evaluation_is_latest_per_run_but_cursor_retains_its_original_window(self):
        first=self.page(limit=2)
        replacement={**self.reports[0],'id':'new-evaluation','verdict':'FAIL','score':0,'created_at':time.time()};self.insert(replacement)
        anchored=self.page(limit=2,cursor=first['cursor']);self.assertEqual(anchored['reports'],first['reports']);self.assertEqual(anchored['newer_count'],1)
        next_page=self.page(limit=2,cursor=first['next_cursor']);self.assertEqual(next_page['reports'][0]['id'],self.reports[-3]['id'])
        fresh=self.page();self.assertEqual(fresh['reports'][0]['id'],'new-evaluation');self.assertEqual(fresh['total'],267)
        self.assertEqual(self.page(agent_id='historical-agent')['reports'][0]['score'],0)
        self.assertEqual(self.service.get(self.reports[0]['id'])['score'],100)

    def test_catalog_never_decodes_full_report_bodies_and_keeps_details_available(self):
        original=json.loads;decoded=[]
        def load(value,*a,**kw):
            if isinstance(value,str) and 'EVALUATION_BODY_ONLY_' in value:decoded.append(value)
            return original(value,*a,**kw)
        with patch.object(json,'loads',side_effect=load):page=self.page(limit=7)
        self.assertEqual(decoded,[]);self.assertEqual(len(page['reports']),7)
        self.assertNotIn('responsibilities',page['reports'][0]);self.assertNotIn('padding',page['reports'][0])
        self.assertIn('responsibilities',self.service.get(page['reports'][0]['id']))

    def test_private_scopes_are_applied_before_json_and_cursor_is_scope_bound(self):
        with self.service.store.transaction() as db:
            for i,scope in enumerate([('other',self.service.scope[1],self.app.principal),(self.app.tenant,'other',self.app.principal),(*self.service.scope[:2],'other')]):
                db.execute('INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',(*scope,'private-'+str(i),'private-run-'+str(i),'hash','INVALID_PRIVATE_BODY',1))
        self.assertEqual(self.page()['total'],267)
        other=copy(self.service);other.scope=(self.app.tenant,'other',self.app.principal)
        with self.assertRaises(ValueError):other.page(cursor=self.page()['cursor'])

    def test_legacy_mock_reports_are_excluded_from_scored_samples(self):
        legacy={k:v for k,v in self.reports[0].items() if k!='assessment'}
        legacy.update(id='legacy-report',run_id='legacy-task',agent_id='legacy-agent')
        self.insert(legacy)
        with self.service.store.transaction() as db:
            db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,1,?)',(self.app.tenant,'legacy-task',canonical({'task':{'execution_mode':'direct'},'snapshot':{'agent_profile':{'runtime':'mock'}}})))
        page=self.page(agent_id='legacy-agent',verdict='SIMULATED');report=page['reports'][0]
        self.assertIsNone(report['score']);self.assertEqual(report['assessment']['scope'],'STRUCTURAL')
        group=next(g for g in page['agents'] if g['agent_id']=='legacy-agent')
        self.assertEqual(group['sample_count'],0);self.assertEqual(group['simulated'],1);self.assertIsNone(group['score'])

    def test_strict_parameters_and_cursor_bindings(self):
        cursor=self.page(limit=2)['next_cursor']
        for options in [{'limit':True},{'limit':0},{'limit':51},{'limit':'５０'},{'search':None},{'search':'x'*2001},{'verdict':'unknown'},{'verdict':[]},{'period':'recent'},{'agent_id':[]},{'cursor':''},{'cursor':'bad'},{'cursor':cursor,'limit':3},{'cursor':cursor,'limit':2,'period':'all'},{'cursor':cursor,'limit':2,'search':'other'}]:
            with self.subTest(options=options),self.assertRaises(ValueError):self.page(**options)
        value=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        for change in [{'upper':True},{'upper':10**100},{'before':0},{'v':True},{'asof':True},{'extra':1}]:
            bad=base64.urlsafe_b64encode(canonical({**value,**change}).encode()).decode()
            with self.assertRaises(ValueError):self.page(limit=2,cursor=bad)
        self.service.save_policy(dict(revision=0,threshold=85,window_days=7,automatic=True))
        with self.assertRaises(ValueError):self.page(limit=2,cursor=cursor)

    def test_counts_aggregates_and_rows_share_one_read_snapshot(self):
        connect=self.service.store.connect;changed=[]
        def traced():
            db=connect()
            def trace(sql):
                if 'evaluation_page_rows' in sql and not changed:
                    changed.append(True)
                    with connect() as writer:writer.execute("DELETE FROM agent_evaluations WHERE id='catalog-evaluation-0000'")
            db.set_trace_callback(trace);return db
        with patch.object(self.service.store,'connect',side_effect=traced):page=self.page(agent_id='historical-agent')
        self.assertTrue(changed);self.assertEqual(page['filtered_total'],1);self.assertEqual(len(page['reports']),1)
        self.assertEqual(self.page(agent_id='historical-agent')['filtered_total'],0)

    def test_http_paging_and_legacy_compatibility(self):
        server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(3)))
        def get(query):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:conn.request('GET','/api/agent-evaluations'+query);r=conn.getresponse();return r.status,json.loads(r.read())
            finally:conn.close()
        self.assertEqual(len(get('')[1]['reports']),200)
        status,page=get('?view=page&agent_id=historical-agent');self.assertEqual(status,200);self.assertEqual(page['filtered_total'],1)
        for query in ['view=page&cursor=','view=page&limit=0','view=page&search=a&search=b','view=page&verdict=FAIL&verdict=PASS','view=page&unknown=1']:
            self.assertEqual(get('?'+query)[0],400,query)

    def test_mean_rounding_preserves_the_existing_overview(self):
        for i,score in enumerate([55.55,55.56]):
            self.insert({**self.reports[0],'id':'rounding-'+str(i),'run_id':'rounding-run-'+str(i),'agent_id':'rounding-agent','score':score})
        old=next(g for g in self.service.overview()['agents'] if g['agent_id']=='rounding-agent')
        new=next(g for g in self.page()['agents'] if g['agent_id']=='rounding-agent')
        self.assertEqual(new['score'],old['score'])
