"""Completion callbacks respect deleted workspaces without hiding real failures."""
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from agent_framework.workflows import Workflows
from agent_framework.workspaces import WorkspaceDeleted, assert_workspace_active
from tests.test_workflows import role
from tests.test_workspaces import space


class ConversationHandoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.workspace = self.app.workspaces.save(space())
        self.scoped = self.app.scoped(self.workspace['id'])
        self.store = self.app.control_store
        self.service = TaskConversations(self.scoped, self.store)
        self.agent = role(self.scoped, '离线接续助手', 'general-assistant@1.0.0')
        self.sequence = 0

    def task(self, completed=True):
        self.sequence += 1
        run = self.scoped.start_task({
            'goal': '整理本轮事项', 'agent_id': self.agent['id'], 'agent_revision': 1,
            'request_id': 'handoff-' + str(self.sequence),
        }, start=False)['run']
        self.service.register(run)
        if completed:
            run = self.scoped.runtime().run(run['run_id'])
            self.assertEqual(run['status'], 'SUCCEEDED')
        return run

    def delete(self):
        return self.app.workspaces.lifecycle(self.workspace['id'], 1, True)

    def queued(self, root):
        with patch.object(self.service, 'dispatch', return_value=False):
            detail = self.service.append(root['run_id'], {
                'content': '继续整理事项', 'request_id': 'followup', 'revision': 1,
            })
        return detail['conversation']['turns'][1]['run_id']

    def wait(self, run_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            run = self.store.load(self.app.tenant, run_id)
            if run['status'] == 'SUCCEEDED' and not (self.app.job(run_id) or {}).get('active'):
                return run
            time.sleep(.01)
        self.fail('Offline turn did not complete')

    def test_completed_task_in_deleted_workspace_is_a_quiet_noop(self):
        root = self.task()
        before = self.store.load(self.app.tenant, root['run_id'])
        turns = self.service.rows(root)
        events = self.store.events(self.app.tenant, root['run_id'])
        self.delete()
        with self.assertNoLogs('agent_framework.web', level='ERROR'):
            self.app._advance_conversation(root['run_id'])
        self.assertEqual(self.store.load(self.app.tenant, root['run_id']), before)
        self.assertEqual(self.service.rows(root), turns)
        self.assertEqual(self.store.events(self.app.tenant, root['run_id']), events)
        self.assertIsNone(self.app.job(root['run_id']))

    def test_delete_after_conversation_lookup_before_workspace_selection(self):
        root = self.task()
        scoped = self.app.scoped
        def select(identity):
            self.delete()
            return scoped(identity)
        with patch.object(self.app, 'scoped', side_effect=select), self.assertNoLogs('agent_framework.web', level='ERROR'):
            self.app._advance_conversation(root['run_id'])
        self.assertTrue(self.app.workspaces.get(self.workspace['id'], include_deleted=True)['deleted'])

    def test_real_worker_can_finish_before_workspace_is_deleted_and_callback_resumes(self):
        root = self.task(completed=False)
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        advance = Application._advance_conversation
        def delayed(app, run_id):
            entered.set()
            try:
                if not release.wait(5):
                    raise RuntimeError('handoff test barrier timed out')
                advance(app, run_id)
            finally:
                finished.set()
        with patch.object(Application, '_advance_conversation', delayed), self.assertNoLogs('agent_framework.web', level='ERROR'):
            self.scoped.schedule(root['run_id'])
            try:
                self.assertTrue(entered.wait(3))
                before = self.store.load(self.app.tenant, root['run_id'])
                self.assertEqual(before['status'], 'SUCCEEDED')
                self.assertEqual(self.app.job(root['run_id'])['state'], 'COMPLETED')
                self.delete()
            finally:
                release.set()
            self.assertTrue(finished.wait(3))
        self.assertEqual(self.store.load(self.app.tenant, root['run_id']), before)
        self.assertEqual(self.app.job(root['run_id'])['state'], 'COMPLETED')

    def test_deleted_workspace_can_be_restored_and_new_reply_still_completes(self):
        root = self.task()
        self.delete()
        with self.assertNoLogs('agent_framework.web', level='ERROR'):
            self.app._advance_conversation(root['run_id'])
        self.app.workspaces.lifecycle(self.workspace['id'], 2, False)
        reply = self.queued(root)
        self.app._advance_conversation(root['run_id'])
        self.wait(reply)
        self.assertEqual(len(self.service.rows(root)), 2)
        self.assertEqual(self.store.load(self.app.tenant, root['run_id'])['snapshot'], root['snapshot'])

    def test_accepted_queue_still_blocks_delete_and_handoff_starts_it_once(self):
        root = self.task()
        reply = self.queued(root)
        with self.assertRaises(ConfigConflict):
            self.delete()
        self.app._advance_conversation(root['run_id'])
        self.app._advance_conversation(root['run_id'])
        self.wait(reply)
        events = self.store.events(self.app.tenant, reply)
        self.assertEqual(sum(e['kind'] == 'conversation.turn_created' for e in events), 1)
        self.assertEqual(len(self.service.rows(root)), 2)

    def test_cancelled_queue_is_not_started_by_delayed_callback(self):
        root = self.task()
        reply = self.queued(root)
        self.service.cancel_queued(root['run_id'], 2, {'revision': 2})
        self.delete()
        with self.assertNoLogs('agent_framework.web', level='ERROR'):
            self.app._advance_conversation(root['run_id'])
        with self.assertRaises(KeyError):
            self.store.load(self.app.tenant, reply)
        self.assertEqual(self.service.rows(root)[1]['state'], 'CANCELLED')

    def test_missing_workspace_is_still_reported_as_corruption(self):
        root = self.task()
        with self.store.transaction() as db:
            db.execute('DELETE FROM workspaces WHERE tenant=? AND id=?', (self.app.tenant, self.workspace['id']))
        with self.assertLogs('agent_framework.web', level='ERROR') as logs:
            self.app._advance_conversation(root['run_id'])
        self.assertIn('workspace unavailable', '\n'.join(logs.output))

    def test_identical_keyerror_message_is_not_mistaken_for_workspace_deletion(self):
        root = self.task()
        def fail(identity):
            self.delete()
            raise KeyError('workspace unavailable')
        with patch.object(TaskConversations, 'dispatch', side_effect=fail):
            with self.assertLogs('agent_framework.web', level='ERROR'):
                self.app._advance_conversation(root['run_id'])

    def test_parent_workflow_failure_is_still_reported(self):
        root = self.task()
        with patch.object(Workflows, 'continue_after_reply', side_effect=RuntimeError('parent wakeup unavailable')):
            with self.assertLogs('agent_framework.web', level='ERROR') as logs:
                self.app._advance_conversation(root['run_id'])
        self.assertIn('parent wakeup unavailable', '\n'.join(logs.output))

    def test_recovery_logs_a_broken_thread_and_continues_other_threads(self):
        broken = self.task(completed=False)
        healthy = self.task(completed=False)
        dispatch = TaskConversations.dispatch
        def recover(service, identity):
            if identity == broken['run_id']:
                raise KeyError('missing frozen setting')
            return dispatch(service, identity)
        with patch.object(TaskConversations, 'dispatch', recover):
            with self.assertLogs('agent_framework.task_conversations', level='ERROR') as logs:
                TaskConversations.tick(self.app)
            self.wait(healthy['run_id'])
        self.assertIn('missing frozen setting', '\n'.join(logs.output))
        self.assertIsNone(self.app.job(broken['run_id']))

    def test_recovery_does_not_silently_ignore_missing_workspace(self):
        self.task(completed=False)
        with self.store.transaction() as db:
            db.execute('DELETE FROM workspaces WHERE tenant=? AND id=?', (self.app.tenant, self.workspace['id']))
        with self.assertLogs('agent_framework.task_conversations', level='ERROR'):
            TaskConversations.tick(self.app)

    def test_recovery_selection_can_race_with_cancellation_and_deletion(self):
        root = self.task(completed=False)
        scoped = self.app.scoped
        def select(identity):
            self.scoped.runtime().cancel(root['run_id'], self.app.tenant)
            self.delete()
            return scoped(identity)
        with patch.object(self.app, 'scoped', side_effect=select):
            with self.assertNoLogs('agent_framework.task_conversations', level='ERROR'):
                TaskConversations.tick(self.app)
        self.assertEqual(self.store.load(self.app.tenant, root['run_id'])['status'], 'CANCELLED')
        self.assertIsNone(self.app.job(root['run_id']))

    def test_deletion_of_a_different_scope_does_not_hide_failure(self):
        root = self.task(completed=False)
        for tenant, workspace in [('other-tenant', self.workspace['id']), (self.app.tenant, 'other-workspace')]:
            with self.subTest(tenant=tenant, workspace=workspace):
                with patch.object(TaskConversations, 'dispatch', side_effect=WorkspaceDeleted(tenant, workspace)):
                    with self.assertLogs('agent_framework.web', level='ERROR'):
                        self.app._advance_conversation(root['run_id'])
                    with self.assertLogs('agent_framework.task_conversations', level='ERROR'):
                        TaskConversations.tick(self.app)

    def test_deleted_lookup_and_transaction_guard_preserve_keyerror_compatibility(self):
        self.delete()
        with self.assertRaises(WorkspaceDeleted) as lookup:
            self.app.workspaces.get(self.workspace['id'])
        with self.store.transaction() as db:
            with self.assertRaises(WorkspaceDeleted) as write:
                assert_workspace_active(db, self.app.tenant, self.workspace['id'])
        for exc in (lookup.exception, write.exception):
            self.assertIsInstance(exc, KeyError)
            self.assertEqual(exc.args, ('workspace unavailable',))
            self.assertEqual((exc.tenant, exc.workspace_id), (self.app.tenant, self.workspace['id']))
        self.assertTrue(self.app.workspaces.get(self.workspace['id'], include_deleted=True)['deleted'])

    def test_missing_and_other_tenant_workspaces_are_not_classified_as_deleted(self):
        self.delete()
        with self.assertRaises(KeyError) as lookup:
            self.app.workspaces.get('missing-workspace')
        self.assertNotIsInstance(lookup.exception, WorkspaceDeleted)
        with self.store.transaction() as db:
            with self.assertRaises(KeyError) as write:
                assert_workspace_active(db, 'other-tenant', self.workspace['id'])
        self.assertNotIsInstance(write.exception, WorkspaceDeleted)

    def test_closed_application_ignores_wakeup(self):
        root = self.task()
        self.app.close()
        with patch.object(self.app, 'scoped') as scoped:
            self.app._advance_conversation(root['run_id'])
        scoped.assert_not_called()
