"""A failed turn owns one retry, including concurrent requests and lost replies."""
from concurrent.futures import ThreadPoolExecutor
import tempfile
import json
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical, PolicyDenied
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests.test_task_acceptance import agent_data
from tests import test_web as fixtures


class TurnRetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.agent = self.app.agents.save(agent_data())
        self.identity = self.app.start_task({'goal': '保留这份原始要求', 'agent_id': self.agent['id'],
                                            'agent_revision': 1, 'request_id': 'original'}, start=False)['run']['run_id']
        self.service = TaskConversations(self.app)
        self.status('FAILED')
        self.dispatch = patch.object(TaskConversations, 'dispatch', return_value=False)
        self.dispatch.start()
        self.addCleanup(self.dispatch.stop)

    def status(self, status):
        state = self.service.store.load(self.app.tenant, self.identity)
        state['status'] = status
        with self.service.store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',
                       (canonical(state), self.app.tenant, self.identity))

    def test_repeated_retry_returns_the_same_turn_and_preserves_source(self):
        before = self.app.detail(self.identity)
        first = self.service.retry(self.identity, 1, {'revision': 1})
        second = self.service.retry(self.identity, 1, {'revision': 1})
        self.assertEqual(len(second['conversation']['turns']), 2)
        self.assertEqual(second['conversation']['revision'], 2)
        self.assertEqual(first['conversation']['turns'], second['conversation']['turns'])
        self.assertEqual(second['run'], before['run'])
        original, retry = second['conversation']['turns']
        self.assertEqual(original['retried_by'], 2)
        self.assertEqual(retry['retry_of'], 1)
        self.assertEqual(retry['content'], original['content'])

    def test_concurrent_applications_accept_only_one_retry(self):
        other = Application(self.tmp.name)
        self.addCleanup(other.close)
        services = [self.service, TaskConversations(other)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda service: service.retry(self.identity, 1, {'revision': 1}), services))
        self.assertEqual([len(result['conversation']['turns']) for result in results], [2, 2])
        self.assertEqual(results[0]['conversation']['turns'][1]['run_id'], results[1]['conversation']['turns'][1]['run_id'])

    def test_retry_lookup_is_read_only_and_survives_cancel_and_restart(self):
        with self.assertRaises(KeyError):
            self.service.retry_submission(self.identity, 1)
        self.service.retry(self.identity, 1, {'revision': 1})
        before = self.app.detail(self.identity)
        with patch.object(TaskConversations, 'dispatch', side_effect=AssertionError('read dispatched')):
            receipt = self.service.retry_submission(self.identity, 1)
        self.assertEqual(receipt['submission']['request_id'], 'retry:1')
        self.assertEqual(self.app.detail(self.identity)['events'], before['events'])
        self.service.cancel_queued(self.identity, 2, {'revision': 2})
        self.app.close()
        restarted = Application(self.tmp.name)
        self.addCleanup(restarted.close)
        service = TaskConversations(restarted)
        replay = service.retry(self.identity, 1, {'revision': 1})
        self.assertEqual(replay['conversation']['revision'], 3)
        self.assertTrue(replay['conversation']['turns'][1]['cancelled_queue'])
        self.assertEqual(service.retry_submission(self.identity, 1)['submission'], receipt['submission'])

    def test_only_failed_expired_or_unstarted_error_turns_can_retry(self):
        for status in ('CREATED', 'RUNNING', 'WAITING_INPUT', 'WAITING_AUTH', 'SUCCEEDED', 'CANCELLED', 'NEEDS_REVIEW'):
            self.status(status)
            with self.subTest(status=status), self.assertRaises(ConfigConflict):
                self.service.retry(self.identity, 1, {'revision': 1})
        self.status('EXPIRED')
        detail = self.service.retry(self.identity, 1, {'revision': 1})
        self.assertEqual(detail['conversation']['turns'][1]['retry_of'], 1)

    def test_a_failed_retry_gets_its_own_retry_and_keeps_the_chain(self):
        self.service.retry(self.identity, 1, {'revision': 1})
        with self.service.store.transaction() as db:
            db.execute("UPDATE task_conversation_turns SET state='ERROR',error='技能已撤回' WHERE tenant=? AND task_id=? AND number=2", (self.app.tenant, self.identity))
        detail = self.service.retry(self.identity, 2, {'revision': 2})
        self.assertEqual([(t['retry_of'], t['retried_by']) for t in detail['conversation']['turns']], [(None, 2), (1, 3), (2, None)])
        self.assertEqual(detail['conversation']['turns'][2]['content'], '保留这份原始要求')

    def test_stale_revision_rejects_new_retry_but_not_accepted_replay(self):
        self.service.append(self.identity, {'content': '后来发送的补充', 'request_id': 'later', 'revision': 1})
        with self.assertRaises(ConfigConflict):
            self.service.retry(self.identity, 1, {'revision': 1})
        self.assertEqual(len(self.service.view(self.identity)['turns']), 2)
        accepted = self.service.retry(self.identity, 1, {'revision': 2})
        replay = self.service.retry(self.identity, 1, {'revision': 1})
        self.assertEqual(accepted['conversation']['turns'], replay['conversation']['turns'])

    def test_current_source_status_is_checked_after_root_preflight(self):
        root = self.service.root
        def changed(*args, **kwargs):
            state = root(*args, **kwargs)
            self.status('SUCCEEDED')
            return state
        with patch.object(self.service, 'root', side_effect=changed), self.assertRaises(ConfigConflict):
            self.service.retry(self.identity, 1, {'revision': 1})
        self.assertEqual(len(self.service.rows(root(self.identity))), 1)

    def test_retry_cannot_change_content_or_use_normal_message_namespace(self):
        for number in (0, -1, True, '1', 9007199254740992):
            with self.subTest(number=number), self.assertRaises(ValueError):
                self.service.retry(self.identity, number, {'revision': 1})
        for data in ({}, {'revision': True}, {'revision': 1, 'content': '替换要求'}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.service.retry(self.identity, 1, data)
        with self.assertRaises(ValueError):
            self.service.append(self.identity, {'content': '伪造重试', 'request_id': 'retry:1', 'revision': 1})
        with self.assertRaises(KeyError):
            self.service.retry(self.identity, 99, {'revision': 1})
        self.assertEqual(len(self.service.view(self.identity)['turns']), 1)

    def test_retry_and_receipt_remain_private_to_original_scope(self):
        self.service.retry(self.identity, 1, {'revision': 1})
        from tests.test_workspaces import space
        other = Application(self.tmp.name, principal='another-user')
        self.addCleanup(other.close)
        workspace = self.app.workspaces.save(space())
        for app in (other, self.app.scoped(workspace['id'])):
            service = TaskConversations(app)
            for operation in (lambda: service.retry(self.identity, 1, {'revision': 1}), lambda: service.retry_submission(self.identity, 1)):
                with self.assertRaises((PolicyDenied, KeyError, ValueError)):
                    operation()

    def test_exports_keep_retry_links_even_when_the_retry_is_cancelled(self):
        from agent_framework.exports import conversation_markdown
        self.service.retry(self.identity, 1, {'revision': 1})
        self.service.cancel_queued(self.identity, 2, {'revision': 2})
        exported = self.service.export(self.identity)
        self.assertEqual(exported['turns'][0]['retried_by'], 2)
        self.assertEqual(exported['turns'][1]['retry_of'], 1)
        markdown = conversation_markdown(exported)
        self.assertIn('重试记录：第 2 轮。', markdown)
        self.assertIn('重试来源：第 1 轮。', markdown)
        self.assertIn('已取消排队，未执行', markdown)


class TurnRetryHTTPTests(unittest.TestCase):
    setUp = fixtures.HTTPTests.setUp
    tearDown = fixtures.HTTPTests.tearDown
    request = fixtures.HTTPTests.request

    def test_retry_and_lookup_http_routes(self):
        agent = self.app.agents.save(agent_data())
        root = self.app.start_task({'goal': 'HTTP 重试', 'agent_id': agent['id'], 'agent_revision': 1, 'request_id': 'http-retry'}, start=False)['run']['run_id']
        store = self.app.runtime().store
        state = store.load(self.app.tenant, root);state['status'] = 'FAILED'
        with store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?', (canonical(state), self.app.tenant, root))
        endpoint = '/api/tasks/'+root+'/messages/1/retry'
        self.assertEqual(self.request(endpoint)[0], 404)
        with patch.object(TaskConversations, 'dispatch', return_value=False):
            for _ in range(2):self.assertEqual(self.request(endpoint, 'POST', json.dumps({'revision': 1}))[0], 202)
        status, _, body = self.request(endpoint)
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result['submission']['request_id'], 'retry:1')
        self.assertEqual(len(result['detail']['conversation']['turns']), 2)
        self.assertEqual(self.request(endpoint.replace('/1/', '/0/'))[0], 400)
