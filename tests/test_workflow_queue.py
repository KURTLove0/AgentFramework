"""Accepted workflow commands remain actionable when the worker queue is full."""
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.web import Application, WebServer
from agent_framework.workflows import Workflows
from tests.test_workflows import definition, role,grant_token


class WorkflowQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name, lease_seconds=.8, tool_timeout=.3)
        self.addCleanup(lambda: self.app.close())
        self.agent = role(self.app)

    def workflow(self, count=1):
        return self.app.workflows().save(definition([self.agent] * count))

    def fill_queue(self):
        self.saturated = {'capacity-' + str(i): {'active': True, 'cancel': threading.Event()} for i in range(16)}
        self.app.jobs.update(self.saturated)
        self.addCleanup(self.clear_queue)

    def clear_queue(self):
        for key in getattr(self, 'saturated', {}):
            self.app.jobs.pop(key, None)

    def restart(self):
        self.clear_queue()
        self.app.close()
        self.app = Application(self.tmp.name, lease_seconds=.8, tool_timeout=.3)

    def wait(self, identity, status):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            state = self.app.workflows().run(identity)
            if state['status'] == status and not (self.app.job(identity) or {}).get('active'):
                return state
            time.sleep(.02)
        self.fail('workflow did not settle: ' + str(self.app.flow_detail(identity)))

    def test_grant_while_full_is_persisted_and_restarts_with_one_write(self):
        workflow = self.workflow()
        flows = self.app.workflows()
        state = flows.start(workflow['id'], {'revision': 1})
        state = flows.execute(state['id'])
        child = state['nodes']['n0']['run_id']
        self.fill_queue()
        proposal = flows.grant(state['id'], 'n0',grant_token(self.app,state['id'],'n0'))
        self.app.schedule_flow(state['id'])
        queued = self.app.flow_detail(state['id'])
        self.assertEqual(queued['queue']['state'], 'QUEUED')
        self.assertEqual(queued['queue']['reason'], 'grant')
        self.assertEqual(self.app.runtime().store.get_grant(self.app.runtime().store.load(self.app.tenant, child))['args_hash'], proposal['args_hash'])
        self.restart()
        Workflows.tick(self.app)
        self.wait(state['id'], 'SUCCEEDED')
        stats = self.app.runtime().external.stats(self.app.tenant, child)
        self.assertEqual(len(stats['drafts']), 1)
        self.assertEqual(stats['calls']['report.draft.create@1.0.0'], 1)
        self.assertIsNone(self.app.flow_detail(state['id'])['queue'])

    def test_manual_resume_while_full_survives_restart(self):
        workflow = self.workflow()
        state = self.app.workflows().start(workflow['id'], {'revision': 1, 'grant': True})
        paused = self.app.workflows().execute(state['id'], pause_after=1)
        self.assertEqual(paused['status'], 'PAUSED')
        Workflows.tick(self.app)
        self.assertIsNone(self.app.job(state['id']))
        self.fill_queue()
        self.app.schedule_flow(state['id'])
        self.assertEqual(self.app.flow_detail(state['id'])['queue']['state'], 'QUEUED')
        self.restart()
        Workflows.tick(self.app)
        result = self.wait(state['id'], 'SUCCEEDED')
        self.assertEqual(result['snapshot_hash'], state['snapshot_hash'])

    def test_grant_and_enqueue_intent_roll_back_together(self):
        workflow = self.workflow()
        flows = self.app.workflows()
        state = flows.execute(flows.start(workflow['id'], {'revision': 1})['id'])
        child = self.app.runtime().store.load(self.app.tenant, state['nodes']['n0']['run_id'])
        from agent_framework import workflows
        original = workflows.event
        def fail(db, tenant, run, kind, data):
            if kind == 'workflow.dispatch_requested':
                raise RuntimeError('intent storage failed')
            return original(db, tenant, run, kind, data)
        with patch.object(workflows, 'event', side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, 'intent storage failed'):
                flows.grant(state['id'], 'n0',grant_token(self.app,state['id'],'n0'))
        self.assertIsNone(self.app.runtime().store.get_grant(child))
        self.assertFalse(any(e['kind'] == 'grant.issued' for e in self.app.runtime().store.events(self.app.tenant, child['run_id'])))
        self.assertIsNone(self.app.flow_detail(state['id'])['queue'])

    def test_new_grant_during_worker_finish_is_not_acknowledged_by_older_request(self):
        workflow = self.workflow()
        state = self.app.workflows().start(workflow['id'], {'revision': 1})
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = Workflows._save
        def hold(flows, value, owner, kind, details=None):
            result = original(flows, value, owner, kind, details)
            if kind == 'workflow.waiting':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('barrier timed out')
            return result
        with patch.object(Workflows, '_save', new=hold):
            self.app.schedule_flow(state['id'])
            self.assertTrue(entered.wait(5))
            self.app.workflows().grant(state['id'], 'n0',grant_token(self.app,state['id'],'n0'))
            self.app.schedule_flow(state['id'])
            release.set()
            self.wait(state['id'], 'WAITING_AUTH')
        self.assertEqual(self.app.flow_detail(state['id'])['queue']['reason'], 'grant')
        Workflows.tick(self.app)
        self.wait(state['id'], 'SUCCEEDED')

    def test_persisted_executor_error_requires_explicit_retry_after_restart(self):
        workflow = self.workflow()
        state = self.app.workflows().start(workflow['id'], {'revision': 1, 'grant': True})
        with patch.object(self.app.pool, 'submit', side_effect=RuntimeError('executor unavailable')):
            with self.assertRaises(RuntimeError):
                self.app.schedule_flow(state['id'])
        self.restart()
        Workflows.tick(self.app)
        detail = self.app.flow_detail(state['id'])
        self.assertEqual(detail['queue']['state'], 'ERROR')
        self.assertIsNone(self.app.job(state['id']))
        self.assertTrue(any(item['kind'] == 'workflow.dispatch_failed' for item in detail['events']))
        self.app.schedule_flow(state['id'])
        self.wait(state['id'], 'SUCCEEDED')
        self.assertTrue(any(item['kind'] == 'workflow.dispatch_failed' for item in self.app.flow_detail(state['id'])['events']))

    def test_queued_grant_still_expires_and_needs_fresh_authorization(self):
        workflow = self.workflow()
        flows = self.app.workflows()
        state = flows.execute(flows.start(workflow['id'], {'revision': 1})['id'])
        child = state['nodes']['n0']['run_id']
        self.fill_queue()
        flows.grant(state['id'], 'n0',grant_token(self.app,state['id'],'n0'))
        self.app.schedule_flow(state['id'])
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE grants SET expires_at=? WHERE tenant_id=? AND run_id=?', (time.time() - 1, self.app.tenant, child))
        self.restart()
        Workflows.tick(self.app)
        self.wait(state['id'], 'WAITING_AUTH')
        self.assertEqual(self.app.runtime().external.stats(self.app.tenant, child)['drafts'], [])
        self.assertIsNone(self.app.flow_detail(state['id'])['queue'])
        self.app.workflows().grant(state['id'], 'n0',grant_token(self.app,state['id'],'n0'))
        Workflows.tick(self.app)
        self.wait(state['id'], 'SUCCEEDED')
        self.assertEqual(len(self.app.runtime().external.stats(self.app.tenant, child)['drafts']), 1)

    def test_queued_requests_are_private_to_their_workspace_and_principal(self):
        workflow = self.workflow()
        state = self.app.workflows().start(workflow['id'], {'revision': 1})
        space = self.app.workspaces.save({'name': '别的空间', 'business': '测试', 'scenario': '隔离', 'description': '', 'revision': 0})
        scoped = self.app.scoped(space['id'])
        with self.assertRaises(KeyError):
            scoped.schedule_flow(state['id'])
        self.assertIsNone(scoped.workflows().dispatch_request(state['id']))
        other = Application(self.tmp.name, principal='another-user')
        self.addCleanup(other.close)
        with self.assertRaises(KeyError):
            other.schedule_flow(state['id'])
        Workflows.tick(other)
        self.assertIsNone(other.workflows().dispatch_request(state['id']))
        self.assertIsNone(other.job(state['id']))


class WorkflowQueueHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name, lease_seconds=.8, tool_timeout=.3)
        self.addCleanup(self.app.close)
        self.agent = role(self.app)
        self.server = WebServer(('127.0.0.1', 0), self.app)
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.app.jobs.update({'capacity-' + str(i): {'active': True, 'cancel': threading.Event()} for i in range(16)})

    def call(self, path, data=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request('POST' if data is not None else 'GET', path, json.dumps(data) if data is not None else None,
                           {'Content-Type': 'application/json', 'X-Agent-Token': self.app.token})
        response = connection.getresponse()
        status, value = response.status, json.loads(response.read())
        connection.close()
        return status, value

    def test_start_full_queue_is_accepted_and_visible_without_duplicate_runs(self):
        workflow = self.app.workflows().save(definition([self.agent]))
        path = '/api/workflows/' + workflow['id'] + '/start'
        payload = {'revision': 1, 'request_id': 'stable-start'}
        status, first = self.call(path, payload)
        self.assertEqual(status, 202)
        self.assertEqual(first['queue']['state'], 'QUEUED')
        status, retry = self.call(path, payload)
        self.assertEqual(status, 202)
        self.assertEqual(first['run']['id'], retry['run']['id'])
        directory = self.call('/api/workflows')[1]['runs']
        self.assertEqual(len(directory), 1)
        self.assertEqual(directory[0]['queue']['state'], 'QUEUED')

    def test_cancellation_is_accepted_during_saturation_and_never_starts_nodes(self):
        workflow = self.app.workflows().save(definition([self.agent]))
        state = self.app.workflows().start(workflow['id'], {'revision': 1})
        path = '/api/workflow-runs/' + state['id'] + '/cancel'
        status, pending = self.call(path, {})
        self.assertEqual(status, 202)
        self.assertTrue(pending['run']['cancel_requested'])
        self.assertEqual(pending['queue']['reason'], 'cancel')
        with self.app.lock:
            self.app.jobs.clear()
        Workflows.tick(self.app)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            value = self.app.workflows().run(state['id'])
            if value['status'] == 'CANCELLED':
                break
            time.sleep(.02)
        self.assertEqual(value['status'], 'CANCELLED')
        self.assertIsNone(value['nodes']['n0']['run_id'])


if __name__ == '__main__':
    unittest.main()
