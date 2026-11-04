import json
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from agent_framework.web import Application
from agent_framework.workflow_chat import WorkflowChat
from agent_framework.workflow_chat_requests import WorkflowChatRequests, WorkflowChatRequestNotFound
from agent_framework.runtime_config import ConfigConflict
from agent_framework.workspaces import WorkspaceDeleted
import test_workflows as workflow_fixtures
from agent_framework.backups import BackupError, create_backup, restore_backup


class WorkflowChatRequestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.profile = workflow_fixtures.role(self.app)
        self.service = WorkflowChatRequests(self.app)
        self.payload = dict(request_id='design-one', agent_id=self.profile['id'], agent_revision=1,
                            consent=False, message='新建「整理员」负责整理会议')

    def chats(self):
        return WorkflowChat(self.app).list()

    def test_replay_is_exact_and_survives_restart_and_designer_change(self):
        with patch.object(WorkflowChat, 'mock', wraps=WorkflowChat.mock) as model:
            accepted = self.service.reply(self.payload)
            self.app.agents.archive(self.profile['id'], 1, True)
            self.assertEqual(self.service.reply(self.payload), accepted)
            self.assertEqual(model.call_count, 1)
        restarted = Application(self.tmp.name)
        self.addCleanup(restarted.close)
        service = WorkflowChatRequests(restarted)
        self.assertEqual(service.reply(self.payload), accepted)
        self.assertEqual(service.get('design-one')['response'], accepted)
        self.assertEqual(len(self.chats()), 1)

    def test_conflicting_body_does_not_generate(self):
        self.service.reply(self.payload)
        with patch.object(WorkflowChat, 'mock') as model:
            with self.assertRaises(ConfigConflict):
                self.service.reply(self.payload | {'message': 'different'})
            model.assert_not_called()

    def test_concurrent_duplicate_is_fenced_and_lookup_is_read_only(self):
        entered, release = threading.Event(), threading.Event()
        mock = WorkflowChat.mock
        def generate(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return mock(*args)
        with ThreadPoolExecutor() as pool, patch.object(WorkflowChat, 'mock', side_effect=generate) as model:
            first = pool.submit(self.service.reply, self.payload)
            self.assertTrue(entered.wait(5))
            try:
                status = self.service.get('design-one')
                self.assertEqual(status['state'], 'RUNNING')
                self.assertFalse(status['retryable'])
                with self.assertRaises(ConfigConflict): self.service.reply(self.payload)
                self.assertEqual(self.chats(), [])
            finally: release.set()
            accepted = first.result(5)
            self.assertEqual(model.call_count, 1)
        self.assertEqual(self.service.get('design-one')['response'], accepted)

    def test_expired_owner_cannot_overwrite_new_attempt(self):
        entered, release = threading.Event(), threading.Event()
        mock = WorkflowChat.mock
        def slow(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return mock(*args)
        with ThreadPoolExecutor() as pool:
            with patch.object(WorkflowChat, 'mock', side_effect=slow):
                first = pool.submit(self.service.reply, self.payload)
                self.assertTrue(entered.wait(5))
            with self.service.store.transaction() as db:
                db.execute('UPDATE workflow_chat_requests SET lease_until=0')
            self.assertEqual(self.service.get('design-one')['state'], 'INTERRUPTED')
            try: accepted = self.service.reply(self.payload)
            finally: release.set()
            with self.assertRaises(ConfigConflict): first.result(5)
        receipt = self.service.get('design-one')
        self.assertEqual(receipt['attempt'], 2)
        self.assertEqual(receipt['response'], accepted)
        self.assertEqual(receipt['state'], 'COMPLETE')
        self.assertEqual(len(self.chats()), 1)

    def test_failure_requires_explicit_retry_and_does_not_persist_provider_error(self):
        with patch.object(WorkflowChat, 'mock', side_effect=ValueError('secret-provider-debug')):
            with self.assertRaises(ValueError): self.service.reply(self.payload)
        receipt = self.service.get('design-one')
        self.assertEqual(receipt['state'], 'ERROR')
        self.assertTrue(receipt['retryable'])
        self.assertNotIn('secret-provider-debug', json.dumps(receipt))
        self.assertEqual(self.chats(), [])
        self.service.reply(self.payload)
        self.assertEqual(self.service.get('design-one')['attempt'], 2)

    def test_chat_and_receipt_rollback_together(self):
        original = self.service.complete
        def fail(*args):
            original(*args)
            raise RuntimeError('simulate commit failure')
        with patch.object(self.service, 'complete', side_effect=fail):
            with self.assertRaises(RuntimeError): self.service.reply(self.payload)
        self.assertEqual(self.chats(), [])
        self.assertEqual(self.service.get('design-one')['state'], 'ERROR')
        self.service.reply(self.payload)
        self.assertEqual(len(self.chats()), 1)

    def test_stale_designer_rejected_before_generation(self):
        with patch.object(WorkflowChat, 'mock') as model:
            with self.assertRaises(ConfigConflict): self.service.reply(self.payload | {'agent_revision': 9})
            model.assert_not_called()

    def test_changed_designer_rolls_back_generated_result(self):
        mock = WorkflowChat.mock
        def changed(*args):
            self.app.agents.archive(self.profile['id'], 1, True)
            return mock(*args)
        with patch.object(WorkflowChat, 'mock', side_effect=changed):
            with self.assertRaises(ConfigConflict): self.service.reply(self.payload)
        self.assertEqual(self.chats(), [])
        self.assertEqual(self.service.get('design-one')['state'], 'ERROR')

    def test_deleted_workspace_cannot_commit_design(self):
        mock = WorkflowChat.mock
        def deleted(*args):
            with self.service.store.transaction() as db: db.execute('UPDATE workspaces SET deleted=1')
            return mock(*args)
        with patch.object(WorkflowChat, 'mock', side_effect=deleted):
            with self.assertRaises(WorkspaceDeleted): self.service.reply(self.payload)
        self.assertEqual(self.chats(), [])

    def test_original_receipt_is_distinct_from_current_conversation(self):
        first = self.service.reply(self.payload)
        second = self.service.reply(self.payload | {'request_id': 'design-two', 'id': first['id'], 'revision': 1, 'message': '名称改为新的流程'})
        receipt = self.service.get('design-one')
        self.assertEqual(receipt['response'], first)
        self.assertEqual(receipt['current'], second)
        self.assertEqual(self.service.reply(self.payload), first)

    def test_scope_and_not_found_do_not_disclose_or_generate(self):
        with self.assertRaises(WorkflowChatRequestNotFound): self.service.get('missing')
        self.service.reply(self.payload)
        other = Application(self.tmp.name, principal='another-person')
        self.addCleanup(other.close)
        with self.assertRaises(WorkflowChatRequestNotFound): WorkflowChatRequests(other).get('design-one')
        other_receipt = WorkflowChatRequests(other).reply(self.payload)
        self.assertNotEqual(other_receipt['id'], self.chats()[0]['id'])

    def test_invalid_payloads_are_rejected_before_claim(self):
        for data in (self.payload | {'agent_revision': True}, self.payload | {'extra': 1},
                     self.payload | {'request_id': '../bad'}, self.payload | {'id': 'chat-one'},
                     self.payload | {'revision': 0}, self.payload | {'consent': 'yes'}):
            with self.subTest(data=data), self.assertRaises(ValueError): self.service.reply(data)
        with self.assertRaises(WorkflowChatRequestNotFound): self.service.get('design-one')

    def test_backup_restores_completed_receipts_and_expired_requests(self):
        accepted = self.service.reply(self.payload)
        with self.service.store.transaction() as db:
            db.execute("INSERT INTO workflow_chat_requests SELECT tenant,workspace,principal,'expired',replace(payload,'design-one','expired'),'RUNNING',owner,0,attempt,'chat-expired',NULL,NULL,created,updated FROM workflow_chat_requests")
        archive, restored = Path(self.tmp.name) / 'backup.zip', Path(self.tmp.name) / 'restored'
        create_backup(self.tmp.name, archive)
        restore_backup(archive, restored)
        app = Application(restored)
        self.addCleanup(app.close)
        service = WorkflowChatRequests(app)
        self.assertEqual(service.reply(self.payload), accepted)
        self.assertEqual(service.get('expired')['state'], 'INTERRUPTED')
        with self.service.store.transaction() as db: db.execute("UPDATE workflow_chat_requests SET lease_until=9999999999 WHERE request_id='expired'")
        with self.assertRaisesRegex(BackupError, '设计请求'): create_backup(self.tmp.name, Path(self.tmp.name) / 'busy.zip')


class WorkflowChatRequestHTTPTests(unittest.TestCase):
    setUp = workflow_fixtures.WorkflowHTTPTests.setUp
    request = workflow_fixtures.WorkflowHTTPTests.request
    def test_request_route_requires_identity_and_lookup_never_posts(self):
        payload = dict(request_id='design-http', agent_id=self.p['id'], agent_revision=1, consent=False, message='先评估岗位')
        self.assertEqual(self.request('/api/workflow-chat', {'agent_id': self.p['id'], 'message': 'hello'})[0], 400)
        status, missing = self.request('/api/workflow-chat-requests/design-http')
        self.assertEqual(status, 404)
        self.assertEqual(missing['code'], 'workflow_chat_request_not_found')
        status, accepted = self.request('/api/workflow-chat', payload)
        self.assertEqual(status, 200)
        self.assertEqual(self.request('/api/workflow-chat', payload)[1], accepted)
        status, receipt = self.request('/api/workflow-chat-requests/design-http')
        self.assertEqual(status, 200)
        self.assertEqual(receipt['response'], accepted)
