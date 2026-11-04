"""Search saved messages across tasks without exposing execution internals."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical,PolicyDenied
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.task_text_search import excerpt,matches
from agent_framework.web import Application
from tests.test_run_catalog import seed_history


class TaskTextSearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.roots=seed_history(self.app,count=6,turns=3,body_bytes=200)

    def reply(self,root,number,report,**changes):
        identity=root if number==1 else root+'-turn-'+str(number)
        state=self.app.control_store.load(self.app.tenant,identity);state.update(report=report,**changes)
        with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,identity))

    def search(self,text,**params):return self.app.runs({'search':text,**params})

    def test_followups_and_saved_replies_find_the_root_with_exact_turn(self):
        page=self.search('补充消息-3');self.assertEqual(page['filtered_total'],6)
        self.assertTrue(all(r['search_match']['turn']==3 and r['search_match']['role']=='user' for r in page['runs']))
        self.reply(self.roots[0],2,{'content':'交付结论：橙色项目延期到周五'})
        result=self.search('橙色项目')['runs'];self.assertEqual([r['run_id'] for r in result],[self.roots[0]])
        self.assertEqual(result[0]['search_match'],{'turn':2,'run_id':self.roots[0]+'-turn-2','role':'assistant','before':'交付结论：','match':'橙色项目','after':'延期到周五'})

    def test_all_matches_are_filtered_before_pagination_and_have_one_row_per_task(self):
        result=self.search('补充消息',limit=2,sort='created_asc');ids=[]
        while True:
            ids.extend(r['run_id'] for r in result['runs']);self.assertEqual(result['filtered_total'],6)
            if not result['next_cursor']:break
            result=self.search('补充消息',limit=2,sort='created_asc',cursor=result['next_cursor'])
        self.assertEqual(ids,self.roots)

    def test_header_matches_keep_existing_behavior_without_reading_messages(self):
        with patch('agent_framework.task_text_search.matches',return_value={}) as read:
            result=self.search('历史目标');self.assertEqual(result['filtered_total'],6);self.assertEqual(read.call_args.args[1],[])
        self.assertNotIn('search_match',result['runs'][0]);self.assertEqual(self.search('history-0003')['runs'][0]['run_id'],self.roots[3])

    def test_saved_content_answer_and_section_values_are_supported(self):
        for index,report in enumerate([{'content':'交付正文 mango','answer':'不能检索的旧答案'}, {'answer':'摘录回答 mango'}, {'sections':{'a':'第一段 mango','b':'第二段'}}]):self.reply(self.roots[index],2,report)
        self.assertEqual(self.search('mango')['filtered_total'],3);self.assertEqual(self.search('不能检索的旧答案')['filtered_total'],0)

    def test_literals_unicode_and_long_bounded_excerpts_preserve_original_text(self):
        content='前'*150+'😀İSTANBUL [a+b]%_ <tag>'+'后'*150
        self.reply(self.roots[0],2,{'content':content})
        for text in ['İstanbul','[a+b]%_','<tag>','😀']:
            with self.subTest(text=text):
                hit=self.search(text)['runs'][0]['search_match'];self.assertLessEqual(len(hit['before']),65);self.assertLessEqual(len(hit['after']),65)
                self.assertIn(hit['match'],content);self.assertTrue(hit['before'].startswith('…'));self.assertTrue(hit['after'].endswith('…'))
        self.assertEqual(json.loads(excerpt('😀İSTANBUL','i'))['match'],'İ')
        with self.assertRaisesRegex(ValueError,'200'):self.search('x'*201)
        self.assertEqual(self.search('İ'*200)['filtered_total'],0)

    def test_current_edits_and_cancelled_queue_text_remain_searchable(self):
        from agent_framework.task_message_edits import update
        root=self.roots[0];service=TaskConversations(self.app)
        with patch.object(TaskConversations,'dispatch',return_value=False):service.append(root,{'content':'修改前的独有要求','request_id':'queue','revision':3})
        with patch.object(TaskConversations,'dispatch',return_value=False):update(self.app,root,4,{'content':'修改后的独有要求','revision':0,'request_id':'edit'})
        self.assertEqual(self.search('修改前的独有')['filtered_total'],0);self.assertEqual(self.search('修改后的独有')['runs'][0]['search_match']['turn'],4)
        service.cancel_queued(root,4,{'revision':5});self.assertEqual(self.search('修改后的独有')['filtered_total'],1)

    def test_archived_and_favorite_filters_still_restrict_body_results(self):
        from agent_framework.task_archive import update as archive
        from agent_framework.task_favorites import update as favorite
        root=self.roots[0];favorite(self.app,root,{'favorited':True,'revision':0});archive(self.app,root,{'archived':True,'revision':0})
        self.assertEqual(self.search('补充消息',favorites='only')['filtered_total'],0)
        self.assertEqual([r['run_id'] for r in self.search('补充消息',favorites='only',visibility='archived')['runs']],[root])
        self.assertEqual(self.search('补充消息',visibility='all')['filtered_total'],6)

    def test_scope_blocks_other_principals_workspaces_tenants_and_child_ownership(self):
        other=Application(self.tmp.name,principal='another');self.addCleanup(other.close);seed_history(other,count=1,prefix='other')
        tenant=Application(self.tmp.name,tenant='another');self.addCleanup(tenant.close);seed_history(tenant,count=1,prefix='tenant')
        space=self.app.workspaces.save({'name':'隔离空间','business':'验证','scenario':'搜索','description':'','revision':0});seed_history(self.app.scoped(space['id']),count=1,prefix='space')
        self.assertEqual(self.search('补充消息')['filtered_total'],6)
        self.reply(self.roots[0],2,{'content':'其他主体的回复'})
        identity=self.roots[0]+'-turn-2';state=self.app.control_store.load(self.app.tenant,identity);state['task']['principal']='another'
        with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,identity))
        with self.assertRaises(PolicyDenied):self.search('其他主体的回复')
        self.assertEqual(matches(self.app,[self.roots[0]],'其他主体的回复'),{})

    def test_audit_config_citations_and_old_edits_are_not_message_body(self):
        self.reply(self.roots[0],2,{'content':'可见正文','citations':[{'quote':'仅引用区出现的文字'}]})
        for text in ['完整审计片段','仅引用区出现的文字']:
            self.assertEqual(self.search(text)['filtered_total'],0)
        statements=[];original=Store.connect
        def traced(store):
            db=original(store);db.set_trace_callback(statements.append);return db
        with patch.object(Store,'connect',traced),patch.object(self.app,'detail',side_effect=AssertionError('full detail loaded')):
            self.assertEqual(self.search('可见正文')['filtered_total'],1)
        self.assertFalse(any('FROM events ' in sql or 'FROM actions ' in sql for sql in statements))

    def test_readonly_old_database_and_unregistered_legacy_root(self):
        root=self.roots[0]
        with self.app.control_store.transaction() as db:
            db.execute('DELETE FROM task_conversation_turns WHERE task_id=?',(root,));db.execute('DELETE FROM task_conversations WHERE id=?',(root,))
        self.app.close();store=Store(Path(self.tmp.name)/'runtime.sqlite3',read_only=True)
        result=matches(self.app,[root],'保留完整正文',store=store);self.assertEqual(result[root]['turn'],1);self.assertEqual(result[root]['role'],'assistant')

    def test_one_snapshot_covers_all_batches(self):
        identities=self.roots+['absent-'+str(i) for i in range(310)];store=self.app.control_store
        with patch.object(store,'read_snapshot',wraps=store.read_snapshot) as snapshots:
            result=matches(self.app,identities,'补充消息',store=store)
        self.assertEqual(snapshots.call_count,1);self.assertEqual(set(result),set(self.roots))

    def test_malformed_legacy_report_does_not_break_unrelated_search(self):
        for index,report in enumerate([42,'old string',[],{'content':False}]):self.reply(self.roots[index],2,report)
        self.assertEqual(self.search('补充消息')['filtered_total'],6)
        self.assertEqual(self.search('old string')['filtered_total'],0)


from tests import test_web as http_fixtures


class TaskTextSearchHTTPTests(unittest.TestCase):
    setUp=http_fixtures.HTTPTests.setUp
    tearDown=http_fixtures.HTTPTests.tearDown
    request=http_fixtures.HTTPTests.request

    def test_search_endpoint_returns_scoped_matches_and_asset(self):
        from urllib.parse import urlencode
        root=seed_history(self.app,count=1,turns=2,body_bytes=30)[0]
        status,_,body=self.request('/api/runs?'+urlencode({'search':'补充消息-2'}));self.assertEqual(status,200)
        row=json.loads(body)['runs'][0];self.assertEqual(row['run_id'],root);self.assertEqual(row['search_match']['turn'],2)
        self.assertEqual(self.request('/task_text_search.js')[0],200)
        self.assertEqual(self.request('/api/runs?'+urlencode({'search':'x'*201}))[0],400)
