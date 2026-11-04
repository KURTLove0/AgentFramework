"""Complete private workflow history without decoding frozen execution bodies."""
import base64
from copy import copy, deepcopy
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from agent_framework.contracts import canonical, digest
from agent_framework.web import Application, WebServer
from tests.test_workflows import role, definition


def seed_flows(app, count=267):
    flows = app.workflows()
    agent = role(app, '历史流程助手', 'general-assistant@1.0.0')
    workflow = flows.save(definition([agent]))
    template = flows.start(workflow['id'], {'revision': 1, 'request_id': 'catalog-template'})
    template['snapshot']['padding'] = 'FROZEN_WORKFLOW_BODY_' + 'x' * 8192
    template['snapshot_hash'] = digest(template['snapshot'])
    with flows.store.transaction() as db:
        db.execute('DELETE FROM workflow_dispatches WHERE tenant=? AND run_id=?', (app.tenant, template['id']))
        db.execute('DELETE FROM workflow_events WHERE tenant=? AND run_id=?', (app.tenant, template['id']))
        db.execute('DELETE FROM workflow_runs WHERE tenant=? AND id=?', (app.tenant, template['id']))
        for i in range(count):
            state = deepcopy(template)
            state.update(id='catalog-flow-'+str(i).zfill(4), name='历史流程 '+str(i).zfill(4), status='WAITING_INPUT' if i==0 else 'SUCCEEDED', created_at=100+i//2)
            db.execute('INSERT INTO workflow_runs(tenant,workspace,principal,id,data) VALUES(?,?,?,?,?)', (*flows.scope, app.principal, state['id'], canonical(state)))
    return template


class WorkflowCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.flows = self.app.workflows()
        self.template = seed_flows(self.app)

    def page(self, **kwargs):
        return self.flows.page(**kwargs)

    def test_all_history_is_reachable_once_in_insertion_order(self):
        ids=[];cursor=None;sizes=[]
        while True:
            page=self.page(cursor=cursor)
            self.assertEqual(page['total'],267);self.assertEqual(page['filtered_total'],267)
            self.assertEqual(page['offset'],len(ids));ids.extend(r['id'] for r in page['runs']);sizes.append(len(page['runs']))
            if not page['has_more']:break
            cursor=page['next_cursor']
        self.assertEqual(sizes,[50,50,50,50,50,17])
        self.assertEqual(ids,['catalog-flow-'+str(i).zfill(4) for i in range(266,-1,-1)])
        self.assertEqual(len(self.flows.runs()),100)

    def test_search_and_status_filter_before_limit_and_old_waiting_work_is_visible(self):
        page=self.page(search='0000',status='attention')
        self.assertEqual(page['filtered_total'],1);self.assertEqual(page['runs'][0]['id'],'catalog-flow-0000')
        self.assertEqual(page['attention_count'],1)
        self.assertEqual(self.page(status='SUCCEEDED')['filtered_total'],266)
        self.assertEqual(self.page(search=self.template['workflow_id'])['filtered_total'],267)
        attention=self.app.attention()
        self.assertEqual([r['id'] for r in attention['workflow_runs']],['catalog-flow-0000'])
        self.assertEqual(attention['counts']['workflows'],1)

    def test_new_insertions_do_not_shift_anchored_pages(self):
        first=self.page(limit=2)
        with self.flows.store.transaction() as db:
            value={**self.template,'id':'new-flow','status':'SUCCEEDED'}
            db.execute('INSERT INTO workflow_runs(tenant,workspace,principal,id,data) VALUES(?,?,?,?,?)',(*self.flows.scope,self.app.principal,value['id'],canonical(value)))
        same=self.page(limit=2,cursor=first['cursor'])
        self.assertEqual(same['runs'],first['runs']);self.assertEqual(same['newer_count'],1)
        next_page=self.page(limit=2,cursor=first['next_cursor'])
        self.assertEqual(next_page['runs'][0]['id'],'catalog-flow-0264')
        self.assertEqual(self.page(limit=2)['runs'][0]['id'],'new-flow')

    def test_queue_cancellation_and_error_statuses_filter_consistently(self):
        with self.flows.store.transaction() as db:
            for i,error,cancel in [(1,None,0),(2,'暂时无法派发',0),(3,None,1)]:
                identity='catalog-flow-'+str(i).zfill(4)
                db.execute("UPDATE workflow_runs SET data=json_set(data,'$.status','CREATED'),cancel_requested=? WHERE id=?",(cancel,identity))
                db.execute('INSERT INTO workflow_dispatches VALUES(?,?,?,?,?,?)',(self.app.tenant,identity,1,'cancel' if cancel else 'start',100,error))
        for status,identity in [('QUEUED','catalog-flow-0001'),('QUEUE_ERROR','catalog-flow-0002'),('CANCELLING','catalog-flow-0003')]:
            page=self.page(status=status)
            self.assertEqual([r['id'] for r in page['runs']],[identity]);self.assertEqual(page['runs'][0]['display_status'],status)
        self.assertEqual(self.page()['attention_count'],2)
        self.assertEqual({r['id'] for r in self.app.attention()['workflow_runs']},{'catalog-flow-0000','catalog-flow-0002'})

    def test_other_scopes_are_filtered_before_reading_private_json(self):
        with self.flows.store.transaction() as db:
            for i,scope in enumerate([('other',self.flows.scope[1],self.app.principal),(self.app.tenant,'other',self.app.principal),(*self.flows.scope,'other')]):
                db.execute('INSERT INTO workflow_runs(tenant,workspace,principal,id,data) VALUES(?,?,?,?,?)',(*scope,'private-'+str(i),'INVALID_PRIVATE_JSON'))
        self.assertEqual(self.page()['total'],267)
        other=copy(self.flows);other.scope=(self.app.tenant,'other')
        with self.assertRaises(ValueError):other.page(cursor=self.page()['cursor'])

    def test_catalog_does_not_decode_or_return_frozen_snapshots(self):
        original=json.loads;decoded=[]
        def load(value,*args,**kwargs):
            if isinstance(value,str) and 'FROZEN_WORKFLOW_BODY_' in value:decoded.append(value)
            return original(value,*args,**kwargs)
        with patch.object(json,'loads',side_effect=load):page=self.page(limit=7)
        self.assertEqual(len(page['runs']),7);self.assertEqual(decoded,[])
        self.assertNotIn('snapshot',page['runs'][0]);self.assertNotIn('nodes',page['runs'][0]);self.assertEqual(page['runs'][0]['node_count'],1)
        self.assertIn('snapshot',self.flows.run(page['runs'][0]['id']))

    def test_cursor_and_parameter_validation(self):
        cursor=self.page(limit=2)['next_cursor']
        for kwargs in [{'limit':True},{'limit':0},{'limit':51},{'limit':'５０'},{'status':'unknown'},{'status':[]},{'search':42},{'search':'x'*2001},{'cursor':''},{'cursor':[]},{'cursor':'bad'},{'cursor':cursor,'limit':3},{'cursor':cursor,'limit':2,'search':'new'},{'cursor':cursor,'limit':2,'status':'SUCCEEDED'}]:
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):self.page(**kwargs)
        value=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        for change in [{'upper':True},{'upper':10**100},{'before':0},{'v':True},{'extra':1}]:
            bad=base64.urlsafe_b64encode(canonical({**value,**change}).encode()).decode()
            with self.assertRaises(ValueError):self.page(limit=2,cursor=bad)

    def test_empty_query_can_be_reloaded_using_its_own_cursor(self):
        first=self.page(search='unmatched')
        self.assertEqual(first['runs'],[]);self.assertFalse(first['has_more']);self.assertIsNone(first['next_cursor'])
        self.assertEqual(self.page(search='unmatched',cursor=first['cursor'])['filtered_total'],0)

    def test_counts_and_rows_share_one_read_snapshot(self):
        connect=self.flows.store.connect;changed=[]
        def traced():
            db=connect()
            def trace(sql):
                if 'catalog_page_rows' in sql and not changed:
                    changed.append(True)
                    with connect() as writer:writer.execute("UPDATE workflow_runs SET data=json_set(data,'$.status','SUCCEEDED') WHERE id='catalog-flow-0000'")
            db.set_trace_callback(trace);return db
        with patch.object(self.flows.store,'connect',side_effect=traced):page=self.page(status='attention')
        self.assertTrue(changed);self.assertEqual(page['filtered_total'],1);self.assertEqual(page['runs'][0]['status'],'WAITING_INPUT')
        self.assertEqual(self.page(status='attention')['filtered_total'],0)

    def test_http_page_definitions_only_and_legacy_compatibility(self):
        server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(3)))
        def get(path):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:conn.request('GET',path);r=conn.getresponse();return r.status,json.loads(r.read())
            finally:conn.close()
        status,page=get('/api/workflow-runs?status=attention');self.assertEqual(status,200);self.assertEqual(page['filtered_total'],1)
        self.assertEqual(len(get('/api/workflows')[1]['runs']),100)
        self.assertEqual(set(get('/api/workflows?view=definitions')[1]),{'workflows'})
        for query in ['limit=0','cursor=','status=all&status=attention','search=a&search=b','limit=&limit=2']:
            self.assertEqual(get('/api/workflow-runs?'+query)[0],400,query)
