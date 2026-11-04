"""Workspace deletion checks use durable work, and serialize with new writes."""
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import TaskContract, canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from agent_framework.workspace_scheduler import WorkspaceScheduler
from tests.test_workspaces import space
from tests.test_workflows import role, definition


class WorkspaceDeletionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(self.app.close)
        self.workspace=self.app.workspaces.save(space())
        self.scoped=self.app.scoped(self.workspace['id'])
        self.store=self.scoped.runtime().store
        self.service=TaskConversations(self.scoped)

    def check(self):
        return self.app.workspaces.deletion_check(self.workspace['id'])

    def delete(self):
        return self.app.workspaces.lifecycle(self.workspace['id'],1,True)

    def completed(self):
        run=self.scoped.create({'runtime':'mock','start':False})['run']
        return self.scoped.runtime().run(run['run_id'])

    def queue(self,root):
        self.app.jobs.update({'capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
        self.addCleanup(self.app.jobs.clear)
        return self.service.append(root['run_id'],{'content':'待回复的私密消息','request_id':'followup','revision':1})

    def test_check_is_read_only_and_rechecks_work_started_after_preview(self):
        self.assertTrue(self.check()['can_delete'])
        self.assertEqual(self.check()['workspace']['revision'],1)
        run=self.scoped.create({'runtime':'mock','start':False})['run']
        with self.assertRaisesRegex(ConfigConflict,'未完成'):self.delete()
        self.assertFalse(self.app.workspaces.get(self.workspace['id'])['deleted'])
        self.scoped.mutate(run['run_id'],'cancel')
        self.assertTrue(self.check()['can_delete'])

    def test_unmaterialized_queue_blocks_delete_and_cancel_unblocks(self):
        root=self.completed();detail=self.queue(root)
        with self.assertRaises(KeyError):self.store.load(self.app.tenant,detail['conversation']['turns'][1]['run_id'])
        check=self.check();self.assertFalse(check['can_delete'])
        self.assertEqual([(b['kind'],b['count']) for b in check['blockers']],[('queued_messages',1)])
        self.assertNotIn('待回复的私密消息',canonical(check))
        with self.assertRaisesRegex(ConfigConflict,'排队消息'):self.delete()
        self.service.cancel_queued(root['run_id'],2,{'revision':detail['conversation']['revision']})
        self.assertTrue(self.check()['can_delete']);self.delete()
        self.app.workspaces.lifecycle(self.workspace['id'],2,False)
        self.assertEqual(self.scoped.detail(root['run_id'])['run']['snapshot'],root['snapshot'])
        self.assertEqual(self.service.rows(root)[1]['state'],'CANCELLED')

    def test_error_queue_does_not_block_and_materialized_run_is_counted_once(self):
        root=self.completed();self.queue(root)
        with self.store.transaction() as db:
            db.execute("UPDATE task_conversation_turns SET state='ERROR',error='offline' WHERE tenant=? AND number=2",(self.app.tenant,))
        self.assertTrue(self.check()['can_delete'])
        turn=self.service.rows(root)[1]
        self.store.create(TaskContract.from_dict(root['task']),root['snapshot'],'normal',run_id=turn['run_id'])
        with self.store.transaction() as db:db.execute("UPDATE task_conversation_turns SET state='QUEUED' WHERE tenant=? AND number=2",(self.app.tenant,))
        self.assertEqual([(b['kind'],b['count']) for b in self.check()['blockers']],[('tasks',1)])

    def test_restarted_process_still_sees_queued_messages(self):
        root=self.completed();self.queue(root)
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(restarted.workspaces.deletion_check(self.workspace['id'])['blockers'][0]['kind'],'queued_messages')
        with self.assertRaises(ConfigConflict):restarted.workspaces.lifecycle(self.workspace['id'],1,True)

    def test_legacy_waiting_input_and_active_worker_still_block(self):
        root=self.completed()
        with self.store.transaction() as db:
            db.execute("UPDATE runs SET state=json_set(state,'$.status','WAITING_INPUT') WHERE tenant_id=? AND id=?",(self.app.tenant,root['run_id']))
        self.assertEqual(self.check()['blockers'][0]['kind'],'tasks')
        with self.store.transaction() as db:
            db.execute("UPDATE runs SET state=json_set(state,'$.status','SUCCEEDED'),owner='worker',lease_until=? WHERE tenant_id=? AND id=?",(time.time()+30,self.app.tenant,root['run_id']))
        self.assertFalse(self.check()['can_delete'])
        with self.store.transaction() as db:db.execute('UPDATE runs SET lease_until=0')
        self.assertTrue(self.check()['can_delete'])

    def test_pending_workflows_and_daily_dispatch_lease_block(self):
        agent=role(self.scoped);flows=self.scoped.workflows();saved=flows.save(definition([agent]))
        run=flows.start(saved['id'],{'revision':1,'request_id':'flow-pending'})
        self.assertEqual(self.check()['blockers'][0]['kind'],'workflows')
        with self.store.transaction() as db:
            db.execute("UPDATE workflow_runs SET data=json_set(data,'$.status','CANCELLED') WHERE tenant=? AND id=?",(self.app.tenant,run['id']))
        scheduler=WorkspaceScheduler(self.scoped);plan=scheduler.generate()
        with self.store.transaction() as db:
            db.execute("UPDATE workspace_daily_plans SET owner='worker',lease_until=? WHERE tenant=? AND id=?",(time.time()+30,self.app.tenant,plan['id']))
        self.assertEqual(self.check()['blockers'][0]['kind'],'daily_dispatch')
        with self.assertRaisesRegex(ConfigConflict,'正在派发'):self.delete()
        with self.store.transaction() as db:db.execute('UPDATE workspace_daily_plans SET lease_until=0')
        self.assertTrue(self.check()['can_delete'])

    def test_other_workspace_work_does_not_block_or_expose_content(self):
        self.app.create({'runtime':'mock','goal':'另一个空间的私密目标','start':False})
        self.assertTrue(self.check()['can_delete'])
        other=Application(self.tmp.name,tenant='other');self.addCleanup(other.close)
        with self.assertRaises(KeyError):other.workspaces.deletion_check(self.workspace['id'])

    def test_all_principals_block_shared_workspace_but_only_counts_are_returned(self):
        other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close)
        other.scoped(self.workspace['id']).create({'runtime':'mock','goal':'其他用户的私密目标','start':False})
        check=self.check();self.assertEqual(check['blockers'][0]['count'],1)
        self.assertNotIn('其他用户的私密目标',canonical(check));self.assertNotIn('other-user',canonical(check))

    def test_lifecycle_receipts_replay_without_advancing_versions(self):
        deleted=self.delete();self.assertEqual(self.delete(),deleted)
        self.assertEqual(self.app.workspaces.lifecycle(self.workspace['id'],2,True),deleted)
        restored=self.app.workspaces.lifecycle(self.workspace['id'],2,False)
        self.assertEqual(self.app.workspaces.lifecycle(self.workspace['id'],2,False),restored)
        with self.assertRaises(ConfigConflict):self.delete()
        self.assertEqual(self.app.workspaces.get(self.workspace['id'])['revision'],3)

    def test_invalid_lifecycle_arguments_do_not_write(self):
        for revision,deleted in [(True,True),(0,True),(-1,True),(1,1),(1,'true')]:
            with self.subTest(revision=revision,deleted=deleted):
                with self.assertRaises(ValueError):self.app.workspaces.lifecycle(self.workspace['id'],revision,deleted)
        self.assertEqual(self.app.workspaces.get(self.workspace['id'])['revision'],1)

    def test_stale_conversation_view_cannot_register_or_append_after_delete(self):
        root=self.completed();self.service.register(root);self.delete()
        with self.assertRaises(KeyError):self.service.register(root)
        with self.assertRaises(KeyError):self.service.append(root['run_id'],{'content':'过期页面消息','request_id':'stale','revision':1})
        self.assertEqual(len(self.service.rows(root)),1)

    def test_delete_between_root_read_and_append_rolls_back_new_message(self):
        root=self.completed();original=self.service.root
        # Registration now shares the append transaction. Delete after the
        # initial read, before that transaction acquires its write lock.
        def read_then_delete(identity):
            run=original(identity);self.delete();return run
        with patch.object(self.service,'root',side_effect=read_then_delete):
            with self.assertRaises(KeyError):self.service.append(root['run_id'],{'content':'竞态消息','request_id':'race','revision':1})
        self.assertEqual(len(self.service.rows(root)),1)

    def test_delete_between_submission_validation_and_store_insert_rejects_run(self):
        original=Store.create
        def create(store,*args,**kwargs):
            self.delete();return original(store,*args,**kwargs)
        with patch.object(Store,'create',create):
            with self.assertRaises(KeyError):self.scoped.create({'runtime':'mock','start':False})
        with self.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM runs').fetchone()[0],0)

    def test_stale_workflow_and_scheduler_views_cannot_start_after_delete(self):
        agent=role(self.scoped);flows=self.scoped.workflows();saved=flows.save(definition([agent]))
        scheduler=WorkspaceScheduler(self.scoped);plan=scheduler.generate();self.delete()
        with self.assertRaises(KeyError):flows.start(saved['id'],{'revision':1,'request_id':'stale'})
        with self.assertRaises(KeyError):flows.save(definition([agent]))
        with self.assertRaises(KeyError):scheduler.dispatch(plan['id'])
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM workflow_runs').fetchone()[0],0)
            self.assertIsNone(db.execute('SELECT owner FROM workspace_daily_plans').fetchone()[0])
