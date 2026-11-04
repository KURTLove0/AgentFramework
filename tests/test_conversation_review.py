"""Unresolved business outcomes hold accepted followups without losing receipts."""
import tempfile
import json
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.runtime import CrashInjected, Runtime
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application


class ConversationReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.runtime = self.app.runtime()
        self.store = self.runtime.store
        self.service = TaskConversations(self.app)
        self.root = self.app.create({'runtime': 'mock', 'scenario': 'unverifiable',
                                    'consent': True, 'grant': True, 'start': False})['run']
        self.identity = self.root['run_id']
        self.payload = {'content': '继续整理上一轮的结果', 'request_id': 'followup', 'revision': 1}

    def queue(self):
        with patch.object(self.service, 'dispatch', return_value=False):
            detail = self.service.append(self.identity, self.payload)
        return detail['conversation']['turns'][1]['run_id']

    def review(self):
        result = self.runtime.run(self.identity)
        self.assertEqual(result['status'], 'NEEDS_REVIEW')
        self.assertTrue(any(a['status'] == 'NEEDS_REVIEW' for a in self.store.actions(result)))
        self.assertEqual(len(self.runtime.external.stats(self.app.tenant, self.identity)['drafts']), 1)
        return result

    def set_status(self, status):
        state = self.store.load(self.app.tenant, self.identity)
        state['status'] = status
        with self.store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',
                       (canonical(state), self.app.tenant, self.identity))

    def assert_unstarted(self, child):
        with self.assertRaises(KeyError):
            self.store.load(self.app.tenant, child)
        self.assertEqual(self.service.rows(self.root)[1]['state'], 'QUEUED')
        self.assertIsNone(self.app.job(child))

    def test_actual_exhausted_readback_blocks_new_messages_and_keeps_audit(self):
        self.review()
        before = self.app.detail(self.identity)
        def thread_records():
            with self.store.connect() as db:
                return [list(db.execute('SELECT * FROM ' + table)) for table in
                        ('task_conversations', 'task_conversation_turns')]
        threads = thread_records()
        self.assertFalse(before['conversation']['can_reply'])
        with self.assertRaises(ConfigConflict):
            self.service.append(self.identity, self.payload)
        after = self.app.detail(self.identity)
        for field in ('run', 'events', 'external'):
            self.assertEqual(after[field], before[field])
        self.assertEqual(len(after['conversation']['turns']), 1)
        self.assertEqual(thread_records(), threads)

    def test_accepted_queue_does_not_advance_and_review_status_is_visible(self):
        child = self.queue()
        result = self.review()
        with patch.object(self.app, 'schedule') as schedule:
            self.assertFalse(self.service.dispatch(self.identity))
            schedule.assert_not_called()
        self.assert_unstarted(child)
        view = self.service.view(self.identity)
        self.assertEqual(view['status'], 'NEEDS_REVIEW')
        self.assertEqual(view['queued_count'], 1)
        self.assertEqual(self.service.summary_state(result)['status'], view['status'])

    def test_duplicate_receipt_survives_review_and_cancel_without_reviving_queue(self):
        child = self.queue()
        self.review()
        receipt = self.service.message_submission(self.identity, 'followup')['submission']
        duplicate = self.service.append(self.identity, self.payload)
        self.assertEqual(duplicate['conversation']['revision'], 2)
        self.assert_unstarted(child)
        with self.assertRaises(ConfigConflict):
            self.service.append(self.identity, self.payload | {'content': '改过的内容'})
        cancelled = self.service.cancel_queued(self.identity, 2, {'revision': 2})
        self.assertEqual(cancelled['conversation']['queued_count'], 0)
        replay = self.service.append(self.identity, self.payload)
        self.assertTrue(replay['conversation']['turns'][1]['cancelled_queue'])
        self.assertEqual(replay['conversation']['revision'], 3)
        self.assertEqual(self.service.message_submission(self.identity, 'followup')['submission'], receipt)
        self.assertEqual(len(replay['external']['drafts']), 1)

    def test_append_rechecks_current_state_at_acceptance(self):
        original = self.service.root
        def root(*args, **kwargs):
            state = original(*args, **kwargs)
            self.set_status('WAITING_AUTH')
            return state
        with patch.object(self.service, 'root', side_effect=root), patch.object(self.app, 'schedule') as schedule:
            with self.assertRaises(ConfigConflict):
                self.service.append(self.identity, self.payload)
            schedule.assert_not_called()
        self.assertEqual(len(self.service.rows(self.root)), 1)
        self.assertEqual(self.service.view(self.identity)['revision'], 1)

    def test_dispatch_rechecks_parent_during_child_creation_transaction(self):
        child = self.queue()
        self.set_status('SUCCEEDED')
        submit = Runtime.submit
        def before_submit(runtime, *args, **kwargs):
            self.set_status('WAITING_AUTH')
            return submit(runtime, *args, **kwargs)
        with patch.object(Runtime, 'submit', before_submit), patch.object(self.app, 'schedule') as schedule:
            self.assertFalse(self.service.dispatch(self.identity))
            schedule.assert_not_called()
        self.assert_unstarted(child)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events WHERE tenant_id=? AND run_id=?',
                                        (self.app.tenant, child)).fetchone()[0], 0)

    def test_all_unresolved_action_states_hold_queue_but_keep_accepted_receipt(self):
        child = self.queue()
        self.review()
        with self.store.connect() as db:
            action = db.execute("SELECT logical_id,data FROM actions WHERE tenant_id=? AND run_id=? AND json_extract(data,'$.status')='NEEDS_REVIEW'",
                                (self.app.tenant, self.identity)).fetchone()
        for status in ('DISPATCHED', 'UNKNOWN', 'RECONCILING', 'NEEDS_REVIEW'):
            with self.subTest(status=status):
                data = json.loads(action['data']) | {'status': status}
                with self.store.transaction() as db:
                    db.execute('UPDATE actions SET status=?,data=? WHERE tenant_id=? AND run_id=? AND logical_id=?',
                               (status, canonical(data), self.app.tenant, self.identity, action['logical_id']))
                with patch.object(self.app, 'schedule') as schedule:
                    self.assertFalse(self.service.view(self.identity)['can_reply'])
                    self.assertFalse(self.service.dispatch(self.identity))
                    replay = self.service.append(self.identity, self.payload)
                    self.assertEqual(replay['conversation']['revision'], 2)
                    schedule.assert_not_called()
                self.assert_unstarted(child)

    def test_restart_tick_and_completion_handoff_leave_blocked_queue_intact(self):
        child = self.queue()
        self.review()
        self.app.close()
        restarted = Application(self.tmp.name)
        self.addCleanup(restarted.close)
        with patch.object(Application, 'schedule') as schedule, self.assertNoLogs('agent_framework', level='ERROR'):
            TaskConversations.tick(restarted)
            restarted._advance_conversation(self.identity)
            schedule.assert_not_called()
        self.assert_unstarted(child)

    def test_previously_materialized_child_is_not_scheduled_after_parent_blocks(self):
        child = self.queue()
        self.set_status('SUCCEEDED')
        with patch.object(self.app, 'schedule'):
            self.assertTrue(self.service.dispatch(self.identity))
        self.assertEqual(self.store.load(self.app.tenant, child)['status'], 'CREATED')
        self.set_status('WAITING_AUTH')
        with patch.object(self.app, 'schedule') as schedule:
            self.assertFalse(self.service.dispatch(self.identity))
            schedule.assert_not_called()

    def test_review_without_unresolved_action_can_continue(self):
        child = self.queue()
        self.set_status('NEEDS_REVIEW')
        self.assertTrue(self.service.view(self.identity)['can_reply'])
        with patch.object(self.app, 'schedule') as schedule:
            self.assertTrue(self.service.dispatch(self.identity))
            schedule.assert_called_once_with(child, automatic=True)

    def test_original_run_can_still_reconcile_its_own_unresolved_write(self):
        root = self.app.create({'runtime': 'mock', 'scenario': 'crash-after-write',
                                'consent': True, 'grant': True, 'start': False})['run']
        self.service.register(root)
        with self.assertRaises(CrashInjected):
            self.runtime.run(root['run_id'])
        with self.store.transaction() as db:
            db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?', (self.app.tenant, root['run_id']))
        self.assertFalse(self.service.view(root['run_id'])['can_reply'])
        with patch.object(self.app, 'schedule') as schedule:
            self.assertTrue(self.service.dispatch(root['run_id']))
            schedule.assert_called_once_with(root['run_id'], automatic=True)
        result = self.runtime.run(root['run_id'])
        self.assertEqual(result['status'], 'SUCCEEDED')
        self.assertEqual(len(self.runtime.external.stats(self.app.tenant, root['run_id'])['drafts']), 1)


if __name__ == '__main__':
    unittest.main()
