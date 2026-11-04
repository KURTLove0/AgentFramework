"""Bounded proposal summaries, stable history pagination and exact request recovery."""
import base64
from copy import deepcopy
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.definitions import default_definition
from agent_framework.learning import Learning
from agent_framework.web import Application,WebServer


class LearningCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.service=Learning(self.app)
        agent=self.app.agents.save({'name':'历史核对助手','description':'合成资料','runtime':'mock','model':'builtin','options':{},'prompt':'保留来源','skills':[],
            'mcp_servers':[],'revision':0,'definition':default_definition('历史核对助手','general-assistant@1.0.0')})
        library=self.app.library();access=self.app.library_access();source=library.create(access,{'title':'合成来源','content':{'text':'订单的业务标识用于历史核对。'}})
        library.transition(access,source['ref'],'REVIEW');library.transition(access,source['ref'],'PUBLISHED')
        self.proposal=self.service.generate({'request_id':'old-request','purpose':'ontology','source_refs':[source['ref']],'agent_id':agent['id'],'agent_revision':1})
        with self.service.store.connect() as db:self.raw=json.loads(db.execute('SELECT data FROM learning_proposals WHERE id=?',(self.proposal['id'],)).fetchone()[0])

    def seed(self,count=1,*,scope=None,purpose='ontology',source='',status='DRAFT',padding=0):
        scope=scope or self.service._scope();ids=[];self.seeds=getattr(self,'seeds',0)+1
        with self.service.store.transaction() as db:
            for i in range(count):
                identity='catalog-'+str(self.seeds)+'-'+str(i);ids.append(identity)
                value=deepcopy(self.raw);value.update(request_id='request-'+identity,run_id=source or None,created_at=1000+i)
                if padding:value['source_context']['large_fixture_text']='do-not-load-body-'+'x'*padding
                if status=='FAILED':value['rejected_output']=deepcopy(value['output'])
                db.execute('INSERT INTO learning_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',(*scope,identity,value['request_id'],purpose,source,2,status,canonical(value)))
        return ids

    def trace(self):
        queries=[];connect=self.service.store.connect
        def traced():
            db=connect();db.set_trace_callback(lambda sql:queries.append(sql) if sql.lstrip().upper().startswith('SELECT') else None);return db
        return queries,patch.object(self.service.store,'connect',traced)

    def test_list_uses_summary_projection_without_loading_any_full_proposal(self):
        self.seed(8,padding=128000)
        with patch.object(self.service,'get',side_effect=AssertionError('Full detail loaded')):
            rows=self.service.list()
        self.assertEqual(len(rows),9);self.assertNotIn('do-not-load-body',canonical(rows))

    def test_list_is_one_select_and_excludes_body_columns(self):
        self.seed(12);queries,traced=self.trace()
        with traced:rows=self.service.list()
        self.assertEqual(len(rows),13);self.assertEqual(len(queries),1)
        self.assertNotIn('SELECT *',queries[0].upper());self.assertIn('json_extract',queries[0])

    def test_summary_fields_keep_the_existing_contract(self):
        expected={k:self.proposal.get(k) for k in ('id','revision','status','purpose','request_id','run_id','agent_revision','runtime','created_at','error')}
        expected['agent']={'name':self.proposal['agent']['name']}
        self.assertEqual(self.service.list(),[expected])

    def test_failed_history_does_not_validate_rejected_outputs_to_render_a_summary(self):
        self.seed(1,status='FAILED')
        with patch('agent_framework.ontology.validate_ontology',side_effect=AssertionError('Validated history')):
            self.assertEqual(self.service.list()[0]['status'],'FAILED')

    def test_all_history_beyond_two_hundred_can_be_traversed_exactly_once(self):
        ids=self.seed(436);seen=[];cursor=None
        for _ in range(12):
            page=self.service.page(purpose='ontology',limit=50,cursor=cursor);seen.extend(p['id'] for p in page['proposals']);cursor=page['next_cursor']
            self.assertEqual(page['has_more'],bool(cursor))
            if not cursor:break
        self.assertEqual(seen,list(reversed(ids))+[self.proposal['id']]);self.assertEqual(len(seen),len(set(seen)))

    def test_page_boundaries_survive_newer_inserts_and_updates(self):
        ids=self.seed(4);first=self.service.page(limit=2)
        with self.service.store.transaction() as db:
            db.execute('UPDATE learning_proposals SET revision=revision+1,status=? WHERE id=?',('REVIEW',ids[0]))
            value=deepcopy(self.raw);value['request_id']='new-request'
            db.execute('INSERT INTO learning_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',(*self.service._scope(),'new-proposal','new-request','ontology','',2,'DRAFT',canonical(value)))
        second=self.service.page(limit=200,cursor=first['next_cursor'])
        self.assertEqual([p['id'] for p in first['proposals']+second['proposals']],list(reversed(ids))+[self.proposal['id']])
        self.assertEqual(next(p for p in second['proposals'] if p['id']==ids[0])['revision'],3)

    def test_list_keeps_its_legacy_two_hundred_item_limit(self):
        self.seed(205);self.assertEqual(len(self.service.list()),200)

    def test_page_filters_scope_and_purpose_before_limiting(self):
        scope=self.service._scope()
        for altered in [(scope[0]+'other',*scope[1:]),(scope[0],scope[1]+'other',scope[2]),(*scope[:2],scope[2]+'other')]:self.seed(2,scope=altered)
        self.seed(3,purpose='retrospective');page=self.service.page(purpose='ontology',limit=1)
        self.assertEqual([p['id'] for p in page['proposals']],[self.proposal['id']]);self.assertFalse(page['has_more'])

    def test_cursor_cannot_be_reused_after_scope_or_filter_changes(self):
        self.seed(3);cursor=self.service.page(purpose='ontology',limit=1)['next_cursor']
        with self.assertRaises(ValueError):self.service.page(purpose='retrospective',cursor=cursor)
        with patch.object(self.service,'_scope',return_value=('other-tenant','other-space','other-user')):
            with self.assertRaises(ValueError):self.service.page(purpose='ontology',cursor=cursor)

    def test_invalid_page_sizes_are_rejected_before_queries(self):
        for value in [True,False,0,-1,201,1.5,'1.5','no',[],None]:
            with self.subTest(value=value),self.assertRaises(ValueError):self.service.page(limit=value)

    def test_malformed_cursors_are_rejected(self):
        for value in ['!', 'x'*2049, 'e30',True,{},base64.urlsafe_b64encode(b'{"v":true}').decode()]:
            with self.subTest(value=value),self.assertRaises(ValueError):self.service.page(cursor=value)

    def test_empty_page_has_no_cursor(self):
        with patch.object(self.service,'_scope',return_value=('empty-tenant','empty-space','empty-user')):
            self.assertEqual(self.service.page(),{'proposals':[],'has_more':False,'next_cursor':None})

    def test_request_lookup_finds_a_proposal_outside_the_recent_history_window(self):
        self.seed(230);self.assertNotIn(self.proposal['id'],[p['id'] for p in self.service.list()])
        self.assertEqual(self.service.get_by_request('old-request'),self.proposal)

    def test_request_lookup_is_scoped_and_never_scans_or_replays_history(self):
        with patch.object(self.service,'list',side_effect=AssertionError('Scanned history')),patch('agent_framework.learning.agent_generate',side_effect=AssertionError('Replayed generation')):
            self.assertEqual(self.service.get_by_request('old-request')['id'],self.proposal['id'])
        scope=self.service._scope()
        for altered in [(scope[0]+'other',*scope[1:]),(scope[0],scope[1]+'other',scope[2]),(*scope[:2],scope[2]+'other')]:
            with patch.object(self.service,'_scope',return_value=altered),self.assertRaises(KeyError):self.service.get_by_request('old-request')

    def test_request_lookup_returns_current_revision_and_deposition_receipt(self):
        current=self.service.deposit(self.proposal['id'],{'revision':self.proposal['revision'],'item_ids':['ontology']})
        self.assertEqual(self.service.get_by_request('old-request'),current)

    def test_request_lookup_returns_pending_and_failed_states(self):
        for status in ['GENERATING','FAILED']:
            with self.service.store.transaction() as db:db.execute('UPDATE learning_proposals SET status=? WHERE id=?',(status,self.proposal['id']))
            self.assertEqual(self.service.get_by_request('old-request')['status'],status)

    def test_request_lookup_uses_one_indexed_select(self):
        queries,traced=self.trace()
        with traced:self.service.get_by_request('old-request')
        self.assertEqual(len(queries),1);self.assertIn('request_id=',queries[0])
        with self.service.store.connect() as db:plan=db.execute('EXPLAIN QUERY PLAN '+queries[0]).fetchall()
        self.assertTrue(any('INDEX' in r['detail'] for r in plan))

    def test_invalid_request_identifiers_never_query_the_store(self):
        with patch.object(self.service.store,'connect',side_effect=AssertionError('Queried invalid request')):
            for value in ['',None,True,'x'*101,'request/other']:
                with self.subTest(value=value),self.assertRaises(ValueError):self.service.get_by_request(value)

    def test_http_request_lookup_and_pagination_preserve_scope_and_clear_not_found_message(self):
        self.seed(3)
        with patch.object(Application,'start_scheduler'),patch.object(Application,'start_conversation_dispatcher'):server=WebServer(('127.0.0.1',0),self.app)
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start()
        def get(path,workspace=None):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                connection.request('GET',path,headers={'X-Agent-Workspace':workspace or self.app.workspace['id']});response=connection.getresponse();return response.status,json.loads(response.read())
            finally:connection.close()
        try:
            code,value=get('/api/learning-requests/old-request');self.assertEqual(code,200);self.assertEqual(value['id'],self.proposal['id'])
            code,value=get('/api/learning-requests/not-here');self.assertEqual(code,404);self.assertEqual(value['code'],'learning_request_not_found');self.assertIn('暂未找到不代表',value['error']);self.assertNotIn('运行',value['error'])
            code,value=get('/api/learning-proposals?purpose=ontology&limit=2');self.assertEqual(code,200);self.assertEqual(len(value['proposals']),2);self.assertTrue(value['has_more'])
            code,next_page=get('/api/learning-proposals?purpose=ontology&limit=2&cursor='+value['next_cursor']);self.assertEqual(code,200);self.assertEqual(len(next_page['proposals']),2);self.assertFalse(next_page['has_more'])
            self.assertEqual(get('/api/learning-proposals?limit=0')[0],400)
            space=self.app.workspaces.save({'name':'其他历史空间','business':'测试','scenario':'隔离','description':'','revision':0})
            self.assertEqual(get('/api/learning-requests/old-request',space['id'])[0],404)
        finally:server.shutdown();server.server_close();thread.join(2)
