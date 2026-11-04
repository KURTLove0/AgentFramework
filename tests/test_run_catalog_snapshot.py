"""Task catalogs must not combine metadata, status and text from different commits."""
import json
import sqlite3
import tempfile
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

from agent_framework import run_catalog,task_text_search
from agent_framework.task_conversations import TaskConversations
from agent_framework.store import Store
from agent_framework.web import Application
from tests.test_run_catalog import seed_history


class RunCatalogSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.roots=seed_history(self.app,count=3,turns=3,body_bytes=40);self.root=self.roots[0]

    def after_roots(self,writer):
        original=run_catalog.accessible_roots
        def read(*args,**kwargs):
            result=original(*args,**kwargs);writer();return result
        return patch.object(run_catalog,'accessible_roots',side_effect=read)

    def reply(self,text):
        with self.app.control_store.transaction() as db:
            db.execute("UPDATE runs SET state=json_set(state,'$.report.content',?) WHERE tenant_id=? AND id=?",(text,self.app.tenant,self.root+'-turn-3'))

    def test_archive_restoration_and_new_message_cannot_mix_with_old_archive_header(self):
        self.app.archive_task(self.root,{'archived':True,'revision':0})
        def append():
            with patch.object(TaskConversations,'dispatch',return_value=False):
                TaskConversations(self.app).append(self.root,{'content':'恢复任务后追加的消息','revision':3,'request_id':'restore-and-append'})
        with self.after_roots(append):page=self.app.runs({'visibility':'archived'})
        self.assertEqual(len(page['runs']),1);row=page['runs'][0]
        self.assertTrue(row['archive']['archived']);self.assertEqual(row['status'],'SUCCEEDED')
        fresh=self.app.runs({'visibility':'all'});row=next(r for r in fresh['runs'] if r['run_id']==self.root)
        self.assertFalse(row['archive']['archived']);self.assertEqual(row['status'],'QUEUED')

    def test_body_search_uses_the_header_snapshot_when_reply_changes(self):
        self.reply('旧快照关键词');original=task_text_search.matches
        def read(*args,**kwargs):self.reply('新快照关键词');return original(*args,**kwargs)
        with patch.object(task_text_search,'matches',side_effect=read):page=self.app.runs({'search':'旧快照关键词'})
        self.assertEqual(page['filtered_total'],1);self.assertEqual(page['runs'][0]['search_match']['match'],'旧快照关键词')
        self.assertEqual(self.app.runs({'search':'旧快照关键词'})['filtered_total'],0)
        self.assertEqual(self.app.runs({'search':'新快照关键词'})['filtered_total'],1)

    def test_counts_filter_and_row_share_one_process_job_observation(self):
        identity=self.root+'-turn-3';self.app.jobs[identity]={'active':True,'state':'RUNNING','run_id':identity}
        with self.after_roots(lambda:self.app.jobs.clear()):page=self.app.runs({'status':'group:running'})
        self.assertEqual(page['counts']['running'],1);self.assertEqual(page['filtered_total'],1)
        self.assertTrue(page['runs'][0]['job']['active']);self.assertEqual(page['runs'][0]['run_id'],self.root)
        self.assertEqual(self.app.runs({'status':'group:running'})['filtered_total'],0)


    def test_metadata_and_sorted_status_page_keep_one_commit(self):
        self.app.rename_task(self.root,{'name':'原名称','revision':0})
        baseline=self.app.runs({'sort':'updated_desc','limit':2,'visibility':'all'})
        def write():
            with self.app.control_store.transaction() as db:
                db.execute("UPDATE task_names SET name='新名称',revision=2 WHERE run_id=?",(self.root,))
                db.execute("UPDATE runs SET state=json_set(state,'$.status','WAITING_INPUT','$.updated_at',?) WHERE id=?",(time.time()+1000,self.root+'-turn-3'))
        with self.after_roots(write):page=self.app.runs({'sort':'updated_desc','limit':2,'visibility':'all'})
        self.assertEqual(page,baseline)
        fresh=self.app.runs({'sort':'updated_desc','limit':2,'visibility':'all'})
        self.assertEqual(fresh['runs'][0]['run_id'],self.root);self.assertEqual(fresh['runs'][0]['title'],'新名称');self.assertEqual(fresh['counts']['waiting'],1)

    def test_cancellation_projection_and_status_do_not_mix(self):
        identity=self.root+'-turn-3'
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.status','RUNNING') WHERE id=?",(identity,))
        with self.after_roots(lambda:self.app.control_store.request_cancellation(self.app.tenant,identity,principal=self.app.principal)):
            page=self.app.runs({'status':'RUNNING'})
        self.assertEqual(page['filtered_total'],1);self.assertIsNone(page['runs'][0]['cancellation']);self.assertEqual(page['runs'][0]['status'],'RUNNING')
        fresh=self.app.runs({'status':'CANCELLING'});self.assertEqual(fresh['filtered_total'],1);self.assertTrue(fresh['runs'][0]['cancellation']['pending'])

    def test_job_epoch_validation_uses_the_same_durable_checkpoint(self):
        identity=self.root+'-turn-3'
        with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET epoch=7 WHERE id=?',(identity,))
        self.app.jobs[identity]={'active':False,'state':'ERROR','execution_epoch':7,'error':'old worker failure'}
        def supersede():
            with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET epoch=8 WHERE id=?',(identity,))
        with self.after_roots(supersede):page=self.app.runs({'search':self.root})
        self.assertEqual(page['runs'][0]['job']['execution_epoch'],7)
        self.assertIsNone(self.app.runs({'search':self.root})['runs'][0]['job'])

    def test_attention_cannot_offer_resume_between_completion_and_lease_release(self):
        identity=self.root+'-turn-3'
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.status','RUNNING'),owner='worker',lease_until=? WHERE id=?",(time.time()+300,identity))
        def complete():
            with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.status','SUCCEEDED'),owner=NULL,lease_until=0 WHERE id=?",(identity,))
        with self.after_roots(complete):result=self.app.attention()
        self.assertFalse(any(row['run_id']==self.root for row in result['tasks']))
        self.assertFalse(any(row['run_id']==self.root for row in self.app.attention()['tasks']))

    def test_attention_freezes_job_hints_before_querying_task_state(self):
        identity=self.root+'-turn-3'
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.status','RUNNING') WHERE id=?",(identity,))
        self.app.jobs[identity]={'active':True,'state':'RUNNING'}
        with self.after_roots(lambda:self.app.jobs.clear()):result=self.app.attention()
        self.assertFalse(any(row['run_id']==self.root for row in result['tasks']))
        self.assertEqual(next(row for row in self.app.attention()['tasks'] if row['run_id']==self.root)['attention_kind'],'resume')

    def test_caller_owned_connection_is_reused_without_close_or_commit(self):
        self.reply('连接一致性关键词');store=self.app.control_store
        with store.read_snapshot() as db:
            initial=self.app.accessible_run_states(compact=True,db=db);self.reply('更新后的关键词')
            with patch.object(store,'connect',side_effect=AssertionError('unexpected connection')):
                self.assertEqual(self.app.accessible_run_states(compact=True,db=db),initial)
                self.assertEqual(set(task_text_search.matches(self.app,self.roots,'连接一致性关键词',store=store,db=db)),{self.root})
                self.assertEqual(task_text_search.matches(self.app,self.roots,'更新后的关键词',store=store,db=db),{})
                self.assertEqual(run_catalog.active_leases(store,self.app.tenant,self.roots,db=db),set())
                self.assertEqual(db.execute('SELECT 1').fetchone()[0],1);self.assertTrue(db.in_transaction)
        self.assertEqual(set(task_text_search.matches(self.app,self.roots,'更新后的关键词')),{self.root})

    def test_slow_read_does_not_hold_worker_lock_or_block_a_committing_writer(self):
        original=task_text_search.matches
        def read(*args,**kwargs):
            def writer():
                with self.app.lock:self.reply('并发写入成功')
                return True
            with ThreadPoolExecutor(max_workers=1) as pool:self.assertTrue(pool.submit(writer).result(timeout=2))
            return original(*args,**kwargs)
        self.reply('先前的正文')
        with patch.object(task_text_search,'matches',side_effect=read):page=self.app.runs({'search':'先前的正文'})
        self.assertEqual(page['filtered_total'],1);self.assertEqual(self.app.runs({'search':'并发写入成功'})['filtered_total'],1)

    def test_catalog_uses_one_connection_no_hydration_or_runtime_initialization(self):
        connects=[];original=Store.connect
        def connect(store):
            db=original(store);connects.append(db);return db
        with patch.object(Store,'connect',connect),patch.object(self.app,'runtime',side_effect=AssertionError('runtime initialization')),patch.object(Store,'load',side_effect=AssertionError('hydrating payload')),patch.object(self.app,'observe_jobs',wraps=self.app.observe_jobs) as observe:
            result=self.app.runs({'search':'补充消息'})
        self.assertEqual(result['filtered_total'],3);self.assertEqual(len(connects),1);observe.assert_called_once_with()
        with self.assertRaises(sqlite3.ProgrammingError):connects[0].execute('SELECT 1')

    def test_failure_closes_read_snapshot_and_next_request_sees_fresh_data(self):
        with patch.object(task_text_search,'matches',side_effect=RuntimeError('injected search failure')):
            with self.assertRaisesRegex(RuntimeError,'injected'):self.app.runs({'search':'body'})
        self.reply('失败后新内容');self.assertEqual(self.app.runs({'search':'失败后新内容'})['filtered_total'],1)

    def test_readonly_optional_tables_and_legacy_root_remain_readonly(self):
        store=self.app.control_store
        with store.transaction() as db:
            for name in ['task_names','task_archives','task_favorites']:db.execute('DROP TABLE '+name)
            db.execute('DELETE FROM task_conversation_turns WHERE task_id=?',(self.root,));db.execute('DELETE FROM task_conversations WHERE id=?',(self.root,))
        readonly=Store(store.path,read_only=True)
        before=Path(store.path).read_bytes()
        with readonly.read_snapshot() as db:
            roots=run_catalog.accessible_roots(self.app,readonly,compact=True,db=db)
            states=TaskConversations(self.app,readonly).summary_states(roots,db=db)
            hits=task_text_search.matches(self.app,[s['run_id'] for s in states],'保留完整正文',store=readonly,db=db)
        self.assertEqual(set(hits),set(self.roots));self.assertEqual(Path(store.path).read_bytes(),before)
        self.assertTrue(all(not s['archive']['archived'] and not s['favorite']['favorited'] and not s['task_name']['name'] for s in states))


    def test_summary_and_body_batches_share_one_snapshot_above_sql_batch_sizes(self):
        many=seed_history(self.app,count=405,turns=1,prefix='batch-snapshot',body_bytes=0);target=many[-1]
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.report.content','跨批次旧关键词') WHERE id=?",(target,))
        original=Store.connect;changed=False
        def connect(store):
            db=original(store)
            def trace(sql):
                nonlocal changed
                if not changed and 'SELECT c.id,c.workspace' in sql:
                    changed=True
                    with self.app.control_store.transaction() as writer:writer.execute("UPDATE runs SET state=json_set(state,'$.status','WAITING_INPUT','$.report.content','跨批次新关键词') WHERE id=?",(target,))
            db.set_trace_callback(trace);return db
        with patch.object(Store,'connect',connect):page=self.app.runs({'search':'跨批次旧关键词','status':'SUCCEEDED'})
        self.assertTrue(changed);self.assertEqual(page['filtered_total'],1);self.assertEqual(page['runs'][0]['run_id'],target);self.assertEqual(page['counts']['waiting'],0)
        fresh=self.app.runs({'search':'跨批次新关键词','status':'WAITING_INPUT'});self.assertEqual(fresh['filtered_total'],1);self.assertEqual(fresh['counts']['waiting'],1)


from tests import test_web as http_fixture


class RunCatalogSnapshotHTTPTests(unittest.TestCase):
    setUp=http_fixture.HTTPTests.setUp
    tearDown=http_fixture.HTTPTests.tearDown
    request=http_fixture.HTTPTests.request

    def test_http_reply_keeps_archive_and_status_consistent_across_real_append(self):
        root=seed_history(self.app,count=1,turns=2,body_bytes=0)[0];self.app.archive_task(root,{'archived':True,'revision':0})
        original=run_catalog.accessible_roots
        def read(*args,**kwargs):
            result=original(*args,**kwargs)
            with patch.object(TaskConversations,'dispatch',return_value=False):TaskConversations(self.app).append(root,{'content':'HTTP 读取期间追加','revision':2,'request_id':'http-append'})
            return result
        with patch.object(run_catalog,'accessible_roots',side_effect=read):status,_,body=self.request('/api/runs?visibility=archived')
        self.assertEqual(status,200);row=json.loads(body)['runs'][0];self.assertEqual(row['status'],'SUCCEEDED');self.assertTrue(row['archive']['archived'])
        status,_,body=self.request('/api/runs');self.assertEqual(status,200);self.assertEqual(json.loads(body)['runs'][0]['run_id'],root);self.assertFalse(json.loads(body)['runs'][0]['archive']['archived'])

    def test_http_search_response_preserves_its_old_match_until_the_next_read(self):
        root=seed_history(self.app,count=1,turns=1,body_bytes=0)[0];original=task_text_search.matches
        def write(text):
            with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.report.content',?) WHERE id=?",(text,root))
        write('before-snapshot-needle')
        def read(*args,**kwargs):write('after-snapshot-needle');return original(*args,**kwargs)
        with patch.object(task_text_search,'matches',side_effect=read):status,_,body=self.request('/api/runs?search=before-snapshot-needle')
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['runs'][0]['search_match']['match'],'before-snapshot-needle')
        self.assertEqual(json.loads(self.request('/api/runs?search=before-snapshot-needle')[2])['filtered_total'],0)
        self.assertEqual(json.loads(self.request('/api/runs?search=after-snapshot-needle')[2])['filtered_total'],1)


if __name__=='__main__':unittest.main()
