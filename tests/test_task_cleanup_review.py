"""Unconfirmed model cleanup holds later turns until explicit scoped review."""
import json
import tempfile
import unittest
import threading
from pathlib import Path
from unittest.mock import patch

from agent_framework.contracts import canonical,PolicyDenied
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests.test_task_acceptance import agent_data
from tests import test_web as fixtures


class TaskCleanupReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=self.app.agents.save(agent_data());self.store=self.app.runtime().store;self.service=TaskConversations(self.app)
        self.root=self.app.start_task({'goal':'检查清理后的后续执行','agent_id':self.agent['id'],'agent_revision':1,'request_id':'cleanup-root'},start=False)['run']
        self.identity=self.root['run_id'];self.payload={'content':'之后处理的消息','request_id':'queued-original','revision':1}

    def queue(self):
        with patch.object(TaskConversations,'dispatch',return_value=False):detail=self.service.append(self.identity,self.payload)
        return detail['conversation']['turns'][1]['run_id']

    def cleanup_failure(self,identity=None,status='FAILED',version=None):
        identity=identity or self.identity;run=self.store.load(self.app.tenant,identity)
        run.update(status=status,cleanup_failure={'kind':'PermissionError','pid':12345,'confirmed':False,'pipes_closed':True},last_error='认知调用失败：model_timeout；本地模型进程清理未确认，请先检查运行环境。')
        run['version']=version if version is not None else run['version']+1
        with self.store.transaction() as db:db.execute('UPDATE runs SET state=?,version=? WHERE tenant_id=? AND id=?',(canonical(run),run['version'],self.app.tenant,identity))
        return run

    def review(self,run=None):
        from agent_framework.task_cleanup import review
        run=run or self.store.load(self.app.tenant,self.identity)
        return review(self.app,self.identity,{'run_id':run['run_id'],'version':run['version']})

    def test_failed_cleanup_holds_queue_and_preserves_receipts(self):
        child=self.queue();self.cleanup_failure()
        with patch.object(self.app,'schedule') as schedule:
            self.assertFalse(self.service.dispatch(self.identity));schedule.assert_not_called()
        with self.assertRaises(KeyError):self.store.load(self.app.tenant,child)
        view=self.service.view(self.identity);self.assertFalse(view['can_reply']);self.assertEqual(view['queued_count'],1)
        self.assertEqual(view['status'],'NEEDS_REVIEW');self.assertIn('运行环境',view['reply_blocked'])
        duplicate=self.service.append(self.identity,self.payload);self.assertEqual(len(duplicate['conversation']['turns']),2)
        self.assertEqual(self.service.message_submission(self.identity,'queued-original')['submission']['run_id'],child)

    def test_stopped_cleanup_is_visible_and_blocks_new_messages_and_retry(self):
        self.cleanup_failure(status='CANCELLED');view=self.service.view(self.identity)
        self.assertFalse(view['can_reply']);self.assertEqual(view['cleanup_review'][0]['turn'],1)
        self.assertEqual(view['turns'][0]['status'],'CANCELLED')
        with self.assertRaises(ConfigConflict):self.service.append(self.identity,self.payload)
        self.cleanup_failure()
        with self.assertRaises(ConfigConflict):self.service.retry(self.identity,1,{'revision':1})

    def test_summary_and_archive_do_not_hide_cleanup_behind_queue(self):
        self.queue();run=self.cleanup_failure()
        self.assertEqual(self.service.summary_state(run)['status'],'NEEDS_REVIEW')
        item=next(r for r in self.app.runs()['runs'] if r['run_id']==self.identity);self.assertEqual(item['status'],'NEEDS_REVIEW')
        self.service.cancel_queued(self.identity,2,{'revision':2})
        with self.assertRaises(ConfigConflict):self.app.archive_task(self.identity,{'archived':True,'revision':1})

    def test_explicit_review_is_idempotent_and_preserves_original_failure(self):
        self.queue();run=self.cleanup_failure();before=self.store.load(self.app.tenant,self.identity)
        with patch.object(TaskConversations,'dispatch',return_value=False):first=self.review(run);second=self.review(run)
        self.assertEqual(first['receipt'],second['receipt']);self.assertEqual(first['detail']['conversation']['revision'],3)
        self.assertTrue(second['detail']['conversation']['can_reply']);self.assertEqual(second['detail']['conversation']['cleanup_review'],[])
        self.assertEqual(self.store.load(self.app.tenant,self.identity),before)
        events=[e for e in self.store.events(self.app.tenant,self.identity) if e['kind']=='model.cleanup_reviewed'];self.assertEqual(len(events),1)
        self.assertNotIn('confirmed',first['receipt'])

    def test_stale_review_cannot_clear_new_failure_and_active_run_cannot_be_reviewed(self):
        run=self.cleanup_failure()
        with patch.object(TaskConversations,'dispatch',return_value=False):self.review(run)
        self.cleanup_failure(version=run['version']+1)
        with self.assertRaises(ConfigConflict):self.review(run)
        self.assertFalse(self.service.view(self.identity)['can_reply'])
        active=self.cleanup_failure(status='RUNNING')
        with self.assertRaises(ConfigConflict):self.review(active)

    def test_review_survives_restart_and_read_is_side_effect_free(self):
        from agent_framework.task_cleanup import inspect
        self.cleanup_failure();before=self.store.events(self.app.tenant,self.identity)
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('read scheduled')):
            self.assertEqual(len(inspect(self.app,self.identity)['detail']['conversation']['cleanup_review']),1)
        self.assertEqual(self.store.events(self.app.tenant,self.identity),before)
        with patch.object(TaskConversations,'dispatch',return_value=False):self.review()
        self.app.close();other=Application(self.tmp.name);self.addCleanup(other.close)
        self.assertTrue(TaskConversations(other).view(self.identity)['can_reply'])

    def test_review_is_scoped_and_cannot_clear_other_task(self):
        from agent_framework.task_cleanup import review
        run=self.cleanup_failure();data={'run_id':self.identity,'version':run['version']}
        other=Application(self.tmp.name,principal='other');self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):review(other,self.identity,data)
        second=self.app.start_task({'goal':'另一个任务','agent_id':self.agent['id'],'agent_revision':1,'request_id':'other-root'},start=False)['run']['run_id']
        with self.assertRaises((ConfigConflict,KeyError)):review(self.app,second,data)

    def test_review_does_not_override_unresolved_business_operation(self):
        self.cleanup_failure()
        with self.store.transaction() as db:
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?)',(self.app.tenant,self.identity,'write-one','UNKNOWN',canonical({'status':'UNKNOWN','tool_ref':'report.draft.create@1.0.0','logical_id':'write-one','args':{}})))
        with patch.object(TaskConversations,'dispatch',return_value=False):result=self.review()
        self.assertFalse(result['detail']['conversation']['can_reply']);self.assertIn('待确认',result['detail']['conversation']['reply_blocked'])

    def test_acceptance_rechecks_cleanup_in_transaction(self):
        original=self.service.root
        def stale(*args,**kwargs):
            root=original(*args,**kwargs);self.cleanup_failure();return root
        with patch.object(self.service,'root',side_effect=stale),self.assertRaises(ConfigConflict):self.service.append(self.identity,self.payload)
        self.assertEqual(len(self.service.rows(self.root)),1)

    def test_later_failed_turn_holds_already_materialized_next_turn(self):
        child=self.queue();root=self.store.load(self.app.tenant,self.identity);root['status']='SUCCEEDED'
        with self.store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(root),self.app.tenant,self.identity))
        with patch.object(self.app,'schedule',return_value=False):self.service.dispatch(self.identity)
        self.cleanup_failure(child)
        self.assertEqual(self.service.view(self.identity)['cleanup_review'][0]['run_id'],child)
        with self.assertRaises(ConfigConflict):self.service.append(self.identity,self.payload|{'request_id':'new','revision':2})
        with patch.object(TaskConversations,'dispatch',return_value=False):self.review(self.store.load(self.app.tenant,child))
        with patch.object(self.app,'schedule',return_value=False):
            result=self.service.append(self.identity,self.payload|{'request_id':'new','revision':3})
        next_run=result['conversation']['turns'][2]['run_id'];self.assertEqual(self.store.load(self.app.tenant,next_run)['status'],'CREATED')
        self.cleanup_failure(child)
        with patch.object(self.app,'schedule') as schedule:self.assertFalse(self.service.dispatch(self.identity));schedule.assert_not_called()

    def test_dispatch_rechecks_cleanup_before_creating_next_turn(self):
        from agent_framework.runtime import Runtime
        child=self.queue();run=self.store.load(self.app.tenant,self.identity);run['status']='SUCCEEDED'
        with self.store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(run),self.app.tenant,self.identity))
        original=Runtime.submit
        def submit(runtime,*args,**kwargs):self.cleanup_failure();return original(runtime,*args,**kwargs)
        with patch.object(Runtime,'submit',submit),patch.object(self.app,'schedule') as schedule:
            self.assertFalse(self.service.dispatch(self.identity));schedule.assert_not_called()
        with self.assertRaises(KeyError):self.store.load(self.app.tenant,child)

    def test_two_instances_review_once_and_failed_dispatch_keeps_receipt(self):
        from agent_framework.task_cleanup import review,inspect
        run=self.cleanup_failure();other=Application(self.tmp.name);self.addCleanup(other.close);errors=[];receipts=[];gate=threading.Barrier(2)
        def worker(app):
            try:gate.wait(timeout=2);receipts.append(review(app,self.identity,{'run_id':self.identity,'version':run['version']})['receipt'])
            except Exception as exc:errors.append(exc)
        with patch.object(TaskConversations,'dispatch',return_value=False):
            threads=[threading.Thread(target=worker,args=(app,)) for app in (self.app,other)]
            for thread in threads:thread.start()
            for thread in threads:thread.join(timeout=5);self.assertFalse(thread.is_alive())
        self.assertEqual(errors,[]);self.assertEqual(receipts[0],receipts[1])
        run=self.cleanup_failure()
        with patch.object(TaskConversations,'dispatch',side_effect=RuntimeError('handoff failed')),self.assertRaises(RuntimeError):self.review(run)
        found=inspect(self.app,self.identity);self.assertEqual(len(found['receipts']),2);self.assertTrue(found['detail']['conversation']['can_reply'])

    def test_reviews_and_pending_holds_survive_backup_restore(self):
        from agent_framework.backups import create_backup,restore_backup
        from agent_framework.task_cleanup import inspect
        self.cleanup_failure()
        with patch.object(TaskConversations,'dispatch',return_value=False):self.review()
        self.cleanup_failure();expected=inspect(self.app,self.identity);self.app.close()
        backup=create_backup(self.tmp.name,Path(self.tmp.name)/'backup');destination=Path(self.tmp.name)/'restored';restore_backup(backup['backup'],destination)
        restored=Application(destination);self.addCleanup(restored.close);found=inspect(restored,self.identity)
        self.assertEqual(found['receipts'],expected['receipts']);self.assertEqual(found['detail']['conversation']['cleanup_review'],expected['detail']['conversation']['cleanup_review'])

    def test_export_keeps_environment_hold_and_readonly_old_database_needs_no_migration(self):
        from agent_framework.exports import conversation_markdown
        self.cleanup_failure();self.assertIn('运行环境待检查',conversation_markdown(self.service.export(self.identity)))
        with self.store.transaction() as db:db.execute('DROP TABLE task_cleanup_reviews')
        from agent_framework.store import Store
        readonly=Store(self.store.path,read_only=True)
        self.assertFalse(TaskConversations(self.app,readonly).view(self.identity)['can_reply'])
        with readonly.connect() as db:self.assertFalse(readonly._optional_table_available(db,'task_cleanup_reviews'))


class TaskCleanupHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_scoped_review_endpoints_and_asset(self):
        agent=self.app.agents.save(agent_data());run=self.app.start_task({'goal':'HTTP 检查','agent_id':agent['id'],'agent_revision':1,'request_id':'http-cleanup'},start=False)['run']
        run.update(status='FAILED',version=1,cleanup_failure={'kind':'PermissionError','pid':123,'confirmed':False,'pipes_closed':True})
        with self.app.runtime().store.transaction() as db:db.execute('UPDATE runs SET state=?,version=1 WHERE tenant_id=? AND id=?',(canonical(run),self.app.tenant,run['run_id']))
        url='/api/tasks/'+run['run_id']+'/cleanup-review'
        status,_,body=self.request(url);self.assertEqual(status,200);self.assertEqual(json.loads(body)['receipts'],[])
        with patch.object(TaskConversations,'dispatch',return_value=False):
            status,_,body=self.request(url,'POST',json.dumps({'run_id':run['run_id'],'version':1}))
        self.assertEqual(status,200);self.assertTrue(json.loads(body)['detail']['conversation']['can_reply'])
        self.assertEqual(self.request('/task_cleanup.js')[0],200)
