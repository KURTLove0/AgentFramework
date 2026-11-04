"""Workflow recovery follows durable state, including missed reply callbacks."""
from copy import deepcopy
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import APIError, Application
from agent_framework.workflows import Workflows
from tests import test_project_journeys as journeys
from tests.test_workflows import role, definition


class WorkflowRecoveryTests(unittest.TestCase):
    setUp = journeys.ProjectJourneyTests.setUp
    generate = journeys.ProjectJourneyTests.generate
    wait_run = journeys.ProjectJourneyTests.wait_run
    wait_flow = journeys.ProjectJourneyTests.wait_flow
    flow = journeys.ProjectJourneyTests.flow

    def create_flow(self, app=None, request='recover', goals=None):
        app = app or self.app
        agent = self.agent if app.workspace['id'] == self.app.workspace['id'] else role(app, '恢复助手', 'general-assistant@1.0.0')
        data = definition([agent for _ in goals or ['整理事项']])
        for node, goal in zip(data['nodes'], goals or ['整理事项']):
            node['goal'] = goal
        workflow = app.workflows().save(data)
        return app.workflows().start(workflow['id'], {'revision': 1, 'consent': True, 'request_id': request})

    def restart(self):
        old = self.app
        old.close()
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        return self.app

    def answer_without_callback(self, root):
        # The reply commits successfully while the one-shot parent wakeup is lost.
        called = threading.Event()
        with patch.object(Workflows, 'continue_after_reply', side_effect=lambda _: called.set()):
            TaskConversations(self.app).append(root, {'content': '周五下午三点', 'request_id': 'answer', 'revision': 1})
            self.wait_run(root, 2)
            self.assertTrue(called.wait(2))

    def test_reply_completion_recovers_after_queue_rejects_parent_wakeup(self):
        identity = self.flow(['先确认会议时间', '整理会议通知'])
        root = self.wait_flow(identity, 'WAITING_INPUT')['run']['nodes']['n0']['run_id']
        called = threading.Event()
        def full(*args):
            called.set()
            raise ConfigConflict('执行队列已满')
        with patch.object(Application, 'schedule_flow', side_effect=full):
            TaskConversations(self.app).append(root, {'content': '周五下午三点', 'request_id': 'answer', 'revision': 1})
            self.wait_run(root, 2)
            self.assertTrue(called.wait(2))
        self.assertEqual(self.app.workflows().run(identity)['status'], 'WAITING_INPUT')
        Workflows.tick(self.app)
        completed = self.wait_flow(identity, 'SUCCEEDED')['run']
        self.assertIn('周五下午三点', self.calls[-1]['context']['task']['workflow_inputs'][0]['artifact']['content'])
        self.assertEqual(len(self.calls), 3)
        self.assertNotEqual(completed['nodes']['n0']['output_run_id'], root)

    def test_restart_dispatches_an_accepted_flow_without_an_in_memory_job(self):
        state = self.create_flow()
        self.restart().start_conversation_dispatcher()
        result = self.wait_flow(state['id'], 'SUCCEEDED')['run']
        self.assertEqual(result['snapshot_hash'], state['snapshot_hash'])
        self.assertEqual(len(self.calls), 1)

    def test_restart_recovers_completed_reply_and_passes_its_frozen_output(self):
        identity = self.flow(['先确认会议时间', '整理会议通知'])
        root = self.wait_flow(identity, 'WAITING_INPUT')['run']['nodes']['n0']['run_id']
        self.answer_without_callback(root)
        output = self.app.detail(root)['conversation']['active_run_id']
        self.restart().start_conversation_dispatcher()
        completed = self.wait_flow(identity, 'SUCCEEDED')['run']
        self.assertEqual(completed['nodes']['n0']['output_run_id'], output)
        self.assertEqual(len(self.calls), 3)

    def test_restart_after_child_commit_reuses_it_without_duplicate_writes(self):
        agent = role(self.app)
        flows = self.app.workflows()
        workflow = flows.save(definition([agent, agent]))
        state = flows.start(workflow['id'], {'revision': 1, 'grant': True})
        save = flows._save
        class PowerLoss(BaseException):
            pass
        def crash(value, owner, kind, details=None):
            if kind == 'node.checkpoint' and value['nodes']['n0']['status'] == 'SUCCEEDED':
                raise PowerLoss()
            return save(value, owner, kind, details)
        with patch.object(flows, '_save', side_effect=crash):
            with self.assertRaises(PowerLoss):
                flows.execute(state['id'])
        interrupted = flows.run(state['id'])
        child = interrupted['nodes']['n0']['run_id']
        self.assertEqual(interrupted['status'], 'RUNNING')
        frozen = self.app.runtime().store.load(self.app.tenant, child)['snapshot']
        self.restart().start_conversation_dispatcher()
        completed = self.wait_flow(state['id'], 'SUCCEEDED')['run']
        self.assertEqual(completed['nodes']['n0']['run_id'], child)
        self.assertEqual(self.app.runtime().store.load(self.app.tenant, child)['snapshot'], frozen)
        for item in completed['nodes'].values():
            stats = self.app.runtime().external.stats(self.app.tenant, item['run_id'])
            self.assertEqual(len(stats['drafts']), 1)
            self.assertEqual(stats['calls']['report.draft.create@1.0.0'], 1)

    def test_live_child_lease_defers_recovery_without_turning_it_into_an_input_wait(self):
        state = self.create_flow()
        flows = self.app.workflows()
        save = flows._save
        class PowerLoss(BaseException):
            pass
        def crash(value, owner, kind, details=None):
            if kind == 'node.submitted':
                raise PowerLoss()
            return save(value, owner, kind, details)
        with patch.object(flows, '_save', side_effect=crash):
            with self.assertRaises(PowerLoss):
                flows.execute(state['id'])
        child = flows.run(state['id'])['nodes']['n0']['run_id']
        store = self.app.runtime().store
        child_state = store.load(self.app.tenant, child)
        lease = store.acquire(self.app.tenant, child, 30)
        try:
            Workflows.tick(self.app)
            self.assertEqual(flows.run(state['id'])['status'], 'RUNNING')
            self.assertIsNone(self.app.job(state['id']))
            self.assertEqual(self.calls, [])
        finally:
            store.release(child_state, lease)
        Workflows.tick(self.app)
        completed = self.wait_flow(state['id'], 'SUCCEEDED')['run']
        self.assertEqual(completed['nodes']['n0']['run_id'], child)

    def test_one_invalid_snapshot_does_not_starve_other_recoverable_flows(self):
        invalid = self.create_flow(request='invalid')
        valid = self.create_flow(request='valid')
        value = deepcopy(invalid)
        value['snapshot_hash'] = 'corrupt-snapshot'
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE workflow_runs SET data=? WHERE id=?', (canonical(value), invalid['id']))
        with self.assertLogs('agent_framework.workflows', level='ERROR'):
            Workflows.tick(self.app)
        self.wait_flow(valid['id'], 'SUCCEEDED')
        self.assertIsNone(self.app.job(invalid['id']))
        self.assertEqual(len(self.calls), 1)

    def test_old_waiting_flow_is_not_lost_behind_a_hundred_newer_runs(self):
        identity = self.flow(['先确认会议时间', '整理会议通知'])
        root = self.wait_flow(identity, 'WAITING_INPUT')['run']['nodes']['n0']['run_id']
        state = self.app.workflows().run(identity)
        # Newer completed history is deliberately beyond the UI's 100-run window.
        with self.app.runtime().store.transaction() as db:
            for number in range(101):
                value = deepcopy(state)
                value.update(id='flow-history-' + str(number), status='SUCCEEDED')
                db.execute('INSERT INTO workflow_runs(tenant,workspace,principal,id,data) VALUES(?,?,?,?,?)',
                           (self.app.tenant, self.app.workspace['id'], self.app.principal, value['id'], canonical(value)))
        TaskConversations(self.app).append(root, {'content': '周五下午三点', 'request_id': 'answer', 'revision': 1})
        self.wait_flow(identity, 'SUCCEEDED')
        self.assertEqual(len(self.calls), 3)

    def test_input_authorization_and_manual_pause_require_their_existing_actions(self):
        waiting = self.flow(['先确认会议时间'])
        self.wait_flow(waiting, 'WAITING_INPUT')
        business = role(self.app)
        workflow = self.app.workflows().save(definition([business]))
        auth = self.app.workflows().start(workflow['id'], {'revision': 1})
        self.assertEqual(self.app.workflows().execute(auth['id'])['status'], 'WAITING_AUTH')
        paused = self.create_flow(request='manual-pause', goals=['第一步', '第二步'])
        self.assertEqual(self.app.workflows().execute(paused['id'], pause_after=1)['status'], 'PAUSED')
        calls = len(self.calls)
        Workflows.tick(self.app)
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.app.workflows().run(waiting)['status'], 'WAITING_INPUT')
        self.assertEqual(self.app.workflows().run(auth['id'])['status'], 'WAITING_AUTH')
        self.assertEqual(self.app.workflows().run(paused['id'])['status'], 'PAUSED')
        child = self.app.workflows().run(auth['id'])['nodes']['n0']['run_id']
        self.assertEqual(self.app.runtime().external.stats(self.app.tenant, child)['drafts'], [])

    def test_no_parent_dispatch_while_a_followup_is_running_or_queued(self):
        identity = self.flow(['先确认会议时间', '整理会议通知'])
        root = self.wait_flow(identity, 'WAITING_INPUT')['run']['nodes']['n0']['run_id']
        self.block_goal = '等待补充完成'
        self.release.clear()
        TaskConversations(self.app).append(root, {'content': self.block_goal, 'request_id': 'answer', 'revision': 1})
        self.assertTrue(self.entered.wait(2))
        TaskConversations(self.app).append(root, {'content': '排队的最终安排', 'request_id': 'last', 'revision': 2})
        with patch.object(Application, 'schedule_flow') as dispatch:
            Workflows.tick(self.app)
            dispatch.assert_not_called()
        self.release.set()
        result = self.wait_flow(identity, 'SUCCEEDED')['run']
        output = result['nodes']['n0']['output_run_id']
        self.assertEqual(output, self.app.detail(root)['conversation']['turns'][2]['run_id'])
        self.assertEqual(len(self.calls), 4)

    def test_recovery_respects_active_leases_queue_capacity_and_failed_workers(self):
        state = self.create_flow()
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE workflow_runs SET owner=?,lease_until=? WHERE id=?', ('other-worker', time.time() + 60, state['id']))
        with patch.object(Application, 'schedule_flow') as dispatch:
            Workflows.tick(self.app)
            dispatch.assert_not_called()
        self.app.schedule_flow(state['id'])
        self.assertEqual(self.app.flow_detail(state['id'])['queue']['state'], 'QUEUED')
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE workflow_runs SET owner=NULL,lease_until=0 WHERE id=?', (state['id'],))
        with self.app.lock:
            self.app.jobs.update({'queue-' + str(i): {'active': True} for i in range(16)})
        try:
            Workflows.tick(self.app)
            self.assertEqual(self.calls, [])
        finally:
            with self.app.lock:
                self.app.jobs.clear()
        self.app.jobs[state['id']] = {'active': False, 'state': 'ERROR', 'error': 'worker failed'}
        Workflows.tick(self.app)
        self.assertEqual(self.calls, [])
        self.app.schedule_flow(state['id'])
        self.wait_flow(state['id'], 'SUCCEEDED')

    def test_recovery_scans_workspaces_but_never_another_principal(self):
        space = self.app.workspaces.save({'name': '另一空间', 'business': '测试', 'scenario': '恢复', 'description': '', 'revision': 0})
        scoped = self.app.scoped(space['id'])
        state = self.create_flow(scoped)
        other = Application(self.tmp.name, principal='another-user')
        self.addCleanup(other.close)
        with patch.object(Application, 'schedule_flow') as dispatch:
            Workflows.tick(other)
            dispatch.assert_not_called()
        Workflows.tick(self.app)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and scoped.workflows().run(state['id'])['status'] != 'SUCCEEDED':
            time.sleep(.02)
        self.assertEqual(scoped.workflows().run(state['id'])['status'], 'SUCCEEDED')
        self.assertEqual(self.app.workflows().runs(), [])

    def test_cancel_request_survives_restart_without_starting_a_node(self):
        state = self.create_flow()
        self.app.workflows().cancel(state['id'])
        self.restart().start_conversation_dispatcher()
        result = self.wait_flow(state['id'], 'CANCELLED')['run']
        self.assertIsNone(result['nodes']['n0']['run_id'])
        self.assertEqual(self.calls, [])

    def test_shutdown_is_shared_with_workspace_views_and_blocks_new_work(self):
        state = self.create_flow()
        scoped = self.app.scoped(self.app.workspace['id'])
        self.app.close()
        self.assertTrue(scoped.closed)
        with self.assertRaises(APIError) as error:
            scoped.schedule_flow(state['id'])
        self.assertEqual(error.exception.status, 503)
        self.assertIsNone(scoped.job(state['id']))
        Workflows.tick(scoped)
        self.assertEqual(self.calls, [])

    def test_executor_rejection_releases_job_capacity_for_explicit_retry(self):
        state = self.create_flow()
        task = self.app.start_task({'goal': '整理事项', 'agent_id': self.agent['id'], 'agent_revision': 1,
                                    'request_id': 'pending-task'}, start=False)['run']['run_id']
        with patch.object(self.app.pool, 'submit', side_effect=RuntimeError('executor unavailable')):
            for identity, schedule in ((state['id'], self.app.schedule_flow), (task, self.app.schedule)):
                with self.subTest(identity=identity):
                    with self.assertRaisesRegex(RuntimeError, 'executor unavailable'):
                        schedule(identity)
                    self.assertFalse(self.app.job(identity)['active'])
                    self.assertEqual(self.app.job(identity)['state'], 'ERROR')
        self.app.schedule_flow(state['id'])
        self.app.schedule(task)
        self.wait_flow(state['id'], 'SUCCEEDED')
        self.wait_run(task)

    def test_recovery_and_user_start_race_accepts_the_same_active_execution(self):
        self.block_goal = '正在整理'
        self.release.clear()
        state = self.create_flow(goals=[self.block_goal])
        Workflows.tick(self.app)
        self.assertTrue(self.entered.wait(2))
        queued_at = self.app.job(state['id'])['started_at']
        self.app.schedule_flow(state['id'])
        self.assertEqual(self.app.job(state['id'])['started_at'], queued_at)
        self.release.set()
        self.wait_flow(state['id'], 'SUCCEEDED')
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
