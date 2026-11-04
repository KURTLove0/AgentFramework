"""SSE admission and disconnects must not monopolize ordinary local requests."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application, WebServer


class StreamLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.limit = patch.object(Application, 'STREAM_LIMIT', 2, create=True)
        self.limit.start()
        self.app = Application(self.tmp.name)
        self.identity = self.app.create({'runtime': 'mock', 'start': False})['run']['run_id']
        self.snapshot = self.app.detail(self.identity)['conversation']
        self.snapshot.update(active=True, resumable=False, can_reply=True)
        self.views = 0
        self.view_failure = None
        self.view_patch = patch.object(TaskConversations, 'view', side_effect=self.view)
        self.view_patch.start()
        self.server = WebServer(('127.0.0.1', 0), self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.connections = []

    def tearDown(self):
        for connection, response in self.connections:
            response.close()
            connection.close()
        self.app.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.view_patch.stop()
        self.limit.stop()
        self.tmp.cleanup()

    def view(self, *args, **kwargs):
        self.views += 1
        if self.view_failure:
            raise self.view_failure
        return deepcopy(self.snapshot)

    def request(self, path, data=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=2)
        body = json.dumps(data) if data is not None else None
        headers = {'Content-Type': 'application/json', 'X-Agent-Token': self.app.token} if data is not None else {}
        connection.request('POST' if data is not None else 'GET', path, body, headers)
        response = connection.getresponse()
        self.connections.append((connection, response))
        return connection, response

    def stream(self):
        connection, response = self.request('/api/tasks/' + self.identity + '/stream')
        if response.status == 200:
            self.assertEqual(response.fp.readline(), b'event: conversation\n')
            self.assertTrue(response.fp.readline().startswith(b'data: '))
            self.assertEqual(response.fp.readline(), b'\n')
        return connection, response

    def wait_slots(self, count):
        deadline = time.monotonic() + 2
        while self.app.stream_capacity.active != count and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.app.stream_capacity.active, count)

    def test_stream_admission_is_bounded_and_does_not_block_stop(self):
        for _ in range(2):
            self.assertEqual(self.stream()[1].status, 200)
        _, excess = self.stream()
        self.assertEqual(excess.status, 503)
        self.assertEqual(json.loads(excess.read())['code'], 'stream_capacity_full')
        _, metadata = self.request('/api/session')
        self.assertEqual(metadata.status, 200)
        metadata.read()
        _, stopped = self.request('/api/runs/' + self.identity + '/cancel', {})
        self.assertEqual(stopped.status, 202)
        self.assertEqual(json.loads(stopped.read())['run']['status'], 'CANCELLED')

    def test_idle_disconnect_releases_admission_before_the_heartbeat(self):
        connection, response = self.stream()
        self.wait_slots(1)
        response.close()
        connection.close()
        self.wait_slots(0)
        self.assertEqual(self.stream()[1].status, 200)

    def test_concurrent_admission_cannot_exceed_the_shared_limit(self):
        barrier = threading.Barrier(7)
        def connect():
            barrier.wait(timeout=3)
            return self.stream()[1].status
        with ThreadPoolExecutor(max_workers=7) as pool:
            statuses = list(pool.map(lambda _: connect(), range(7)))
        self.assertEqual(statuses.count(200), 2)
        self.assertEqual(statuses.count(503), 5)
        self.wait_slots(2)

    def test_workspace_views_share_admission_and_reject_before_reading_full_history(self):
        scoped = self.app.scoped(self.app.workspace['id'])
        with self.app.stream_capacity.reserve(), scoped.stream_capacity.reserve():
            before = self.views
            _, response = self.stream()
            self.assertEqual(response.status, 503)
            response.read()
            self.assertEqual(self.views, before)
        self.assertEqual(self.stream()[1].status, 200)

    def test_initial_read_failure_releases_its_slot_and_keeps_the_http_error(self):
        self.view_failure = KeyError('unavailable task')
        _, response = self.stream()
        self.assertEqual(response.status, 404)
        self.assertIn('error', json.loads(response.read()))
        self.wait_slots(0)
        self.view_failure = None
        self.assertEqual(self.stream()[1].status, 200)

    def test_unexpected_failure_after_headers_closes_without_appending_an_http_response(self):
        _, response = self.stream()
        with self.assertLogs('agent_framework.web', level='ERROR'):
            self.view_failure = RuntimeError('synthetic snapshot failure')
            self.wait_slots(0)
        rest = response.read()
        self.assertNotIn(b'HTTP/', rest)
        self.assertNotIn(b'synthetic snapshot failure', rest)

    def test_settled_conversations_release_the_stream_immediately(self):
        self.snapshot.update(active=False, queued_count=0)
        _, response = self.stream()
        self.assertIn(b'event: settled', response.read())
        self.wait_slots(0)

    def test_shutdown_wakes_idle_streams_and_rejects_new_ones(self):
        _, response = self.stream()
        self.wait_slots(1)
        self.app.close()
        self.wait_slots(0)
        self.assertEqual(response.read(), b'')
        _, rejected = self.stream()
        self.assertEqual(rejected.status, 503)
        self.assertIn('关闭', json.loads(rejected.read())['error'])

    def test_connection_lifetime_releases_the_slot_without_claiming_task_completion(self):
        self.server.stream_lifetime = .12
        _, response = self.stream()
        self.assertNotIn(b'event: settled', response.read())
        self.wait_slots(0)
        self.assertEqual(self.stream()[1].status, 200)


if __name__ == '__main__':
    unittest.main()
