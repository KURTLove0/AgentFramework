"""Execution hints are bounded; durable history and recovery survive eviction."""
from concurrent.futures import Future
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.runtime import Runtime
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application, APIError
from agent_framework.workflows import Workflows
from tests.test_workflows import role, definition


class JobHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name, lease_seconds=.5, tool_timeout=.1)
        self.addCleanup(self.app.close)
        self.limit = patch.object(Application, 'JOB_HISTORY_LIMIT', 3, create=True)
        self.limit.start()
        self.addCleanup(self.limit.stop)

    def root(self):
        return self.app.create({'runtime': 'mock', 'start': False})['run']['run_id']

    def execute(self, identity):
        # Run the real worker synchronously, after submit has returned its Future.
        with patch.object(self.app.pool, 'submit', return_value=Future()) as submit:
            self.app.schedule(identity)
            call = submit.call_args.args
            call[0](*call[1:])

    def test_completed_history_is_bounded_without_losing_saved_results(self):
        identities = [self.root() for _ in range(6)]
        for identity in identities:
            self.execute(identity)
        self.assertLessEqual(len(self.app.jobs), 3)
        self.assertIsNone(self.app.job(identities[0]))
        detail = self.app.detail(identities[0])
        self.assertEqual(detail['run']['status'], 'SUCCEEDED')
        self.assertTrue(detail['run']['report'])
        self.assertTrue(detail['events'])

    def test_evicted_worker_failure_stays_paused_and_can_be_explicitly_resumed(self):
        identity = self.root()
        TaskConversations(self.app).register(self.app.control_store.load(self.app.tenant, identity))
        with patch.object(Runtime, 'run', side_effect=RuntimeError('private failure')):
            self.execute(identity)
        for _ in range(4):
            self.execute(self.root())
        self.assertIsNone(self.app.job(identity))
        detail = self.app.detail(identity)
        self.assertEqual(detail['run']['interruption']['code'], 'worker_exception')
        with patch.object(Runtime, 'run') as run:
            TaskConversations.tick(self.app)
            run.assert_not_called()
        self.execute(identity)
        self.assertEqual(self.app.detail(identity)['run']['status'], 'SUCCEEDED')

    def test_workflow_exception_is_saved_before_its_local_hint_is_evicted(self):
        flows = self.app.workflows()
        profile = role(self.app)
        definition_record = flows.save(definition([profile]))
        flow = flows.start(definition_record['id'], {'revision': 1, 'grant': True})
        with patch.object(self.app.pool, 'submit') as submit:
            self.app.schedule_flow(flow['id'])
            with patch.object(Workflows, 'execute', side_effect=RuntimeError('execution failed')):
                submit.call_args.args[0]()
        request = flows.dispatch_request(flow['id'])
        self.assertTrue(request['error'])
        for _ in range(4):
            self.execute(self.root())
        self.assertIsNone(self.app.job(flow['id']))
        with patch.object(self.app.pool, 'submit') as submit:
            Workflows.tick(self.app)
            submit.assert_not_called()
        self.assertEqual(self.app.flow_detail(flow['id'])['queue']['state'], 'ERROR')

    def test_cancellation_history_is_bounded_and_durable_stop_receipts_survive(self):
        identities = [self.root() for _ in range(6)]
        for identity in identities:
            self.app.control_store.request_cancellation(self.app.tenant, identity)
            with patch.object(self.app.cancellation_pool, 'submit', return_value=Future()) as submit:
                self.assertTrue(self.app.schedule_cancellation(identity))
                call = submit.call_args.args
                call[0](*call[1:])
        self.assertLessEqual(len(self.app.cancel_jobs), 3)
        self.assertNotIn(identities[0], self.app.cancel_jobs)
        detail = self.app.detail(identities[0])
        self.assertEqual(detail['run']['status'], 'CANCELLED')
        self.assertFalse(detail['cancellation']['pending'])
        self.assertEqual(detail['cancellation']['outcome'], 'CANCELLED')

    def test_stop_executor_rejections_do_not_accumulate_or_lose_retry_errors(self):
        identities = [self.root() for _ in range(6)]
        for identity in identities:
            self.app.control_store.request_cancellation(self.app.tenant, identity)
            with patch.object(self.app.cancellation_pool, 'submit', side_effect=RuntimeError('rejected')):
                self.app.schedule_cancellation(identity)
        self.assertLessEqual(len(self.app.cancel_jobs), 3)
        self.assertNotIn(identities[0], self.app.cancel_jobs)
        receipt = self.app.control_store.cancellation(self.app.tenant, identities[0])
        self.assertTrue(receipt['pending'])
        self.assertTrue(receipt['error'])
        with patch.object(self.app.cancellation_pool, 'submit') as submit:
            self.app.recover_cancellations()
            submit.assert_not_called()

    def test_unrecorded_failures_apply_backpressure_and_allow_explicit_retry(self):
        identities = [self.root() for _ in range(3)]
        with patch.object(Application, 'JOB_CAPACITY', 2):
            with patch.object(Runtime, 'run', side_effect=RuntimeError('private')):
                with patch.object(Store, 'interrupt_execution', side_effect=OSError('disk unavailable')):
                    with self.assertLogs('agent_framework.web', level='ERROR'):
                        for identity in identities[:2]:
                            self.execute(identity)
            self.assertFalse(self.app.has_job_capacity())
            with self.assertRaises(APIError) as full:
                self.app.schedule(identities[2])
            self.assertEqual(full.exception.status, 429)
            with self.assertRaises(APIError) as automatic:
                self.app.schedule(identities[0], automatic=True)
            self.assertEqual(automatic.exception.status, 409)
            self.assertEqual(len(self.app.jobs), 2)
            self.execute(identities[0])
            self.assertTrue(self.app.has_job_capacity())
            self.execute(identities[2])
            self.assertTrue(self.app.jobs[identities[1]]['_retention_required'])
            self.assertEqual(self.app.detail(identities[0])['run']['status'], 'SUCCEEDED')

    def test_executor_rejections_are_bounded_and_keep_original_failure_marker(self):
        identities = [self.root() for _ in range(6)]
        with patch.object(self.app.pool, 'submit', side_effect=RuntimeError('rejected')):
            for identity in identities:
                with self.assertRaises(RuntimeError):
                    self.app.schedule(identity)
        self.assertLessEqual(len(self.app.jobs), 3)
        self.assertIsNone(self.app.job(identities[0]))
        self.assertEqual(self.app.detail(identities[0])['run']['interruption']['code'], 'executor_rejected')

    def test_old_completion_cannot_remove_a_new_active_attempt(self):
        identity = self.root()
        with patch.object(self.app.pool, 'submit', return_value=Future()):
            self.app.schedule(identity)
        old = self.app.jobs[identity]
        newer = {**old, 'cancel': threading.Event(), 'future': Future()}
        self.app.jobs[identity] = newer
        old['state'] = 'SUPERSEDED'
        self.app._finish_job(identity, old)
        for _ in range(4):
            self.execute(self.root())
        self.assertIs(self.app.jobs[identity], newer)
        self.assertTrue(self.app.job(identity)['active'])
        self.assertIs(self.app.jobs[identity]['future'], newer['future'])
        self.assertFalse(newer['cancel'].is_set())

    def test_snapshot_survives_eviction_without_capturing_private_worker_handles(self):
        identity = self.root()
        self.execute(identity)
        observed = self.app.observe_jobs()
        for field in ('future', 'cancel', '_retention_required'):
            self.assertNotIn(field, observed[identity])
        for _ in range(4):
            self.execute(self.root())
        self.assertIsNone(self.app.job(identity))
        self.assertEqual(self.app.job(identity, observed=observed)['state'], 'COMPLETED')

    def test_workspace_views_share_history_and_capacity_without_replacing_live_jobs(self):
        space = self.app.workspaces.save(dict(name='其他', business='测试', scenario='测试', description='', revision=0))
        other = self.app.scoped(space['id'])
        active = self.root()
        with patch.object(self.app.pool, 'submit', return_value=Future()):
            self.app.schedule(active)
        for _ in range(4):
            identity = other.create({'runtime': 'mock', 'start': False})['run']['run_id']
            with patch.object(other.pool, 'submit', return_value=Future()) as submit:
                other.schedule(identity)
                call = submit.call_args.args
                call[0](*call[1:])
        self.assertIs(self.app.jobs, other.jobs)
        self.assertEqual(len(self.app.jobs), 4)
        self.assertTrue(self.app.job(active)['active'])
        with patch.object(Application, 'JOB_CAPACITY', 1):
            self.assertFalse(other.has_job_capacity())

    def test_retention_uses_completion_order_when_wall_clock_moves_backwards(self):
        identities = [self.root() for _ in range(4)]
        # Override only the completion clock; execution and leases use real time.
        finish = self.app._finish_job
        values = iter([4000, 3000, 2000, 1000])
        def finish_with_clock(*args, **kwargs):
            with patch('agent_framework.web.time.time', return_value=next(values)):
                return finish(*args, **kwargs)
        with patch.object(self.app, '_finish_job', side_effect=finish_with_clock):
            for identity in identities:
                self.execute(identity)
        self.assertIsNone(self.app.job(identities[0]))
        self.assertIsNotNone(self.app.job(identities[-1]))

    def test_unrecorded_stop_failures_bound_only_the_stop_queue(self):
        identities = [self.root() for _ in range(3)]
        for identity in identities:
            self.app.control_store.request_cancellation(self.app.tenant, identity)
        with patch.object(Application, 'JOB_CAPACITY', 2):
            with patch.object(self.app.cancellation_pool, 'submit', side_effect=RuntimeError('rejected')):
                with patch.object(Store, 'fail_cancellation', side_effect=OSError('disk unavailable')):
                    for identity in identities[:2]:
                        with self.assertRaises(OSError):
                            self.app.schedule_cancellation(identity)
            self.assertFalse(self.app.has_job_capacity(cancellation=True))
            self.assertTrue(self.app.has_job_capacity())
            self.assertFalse(self.app.schedule_cancellation(identities[2]))
            self.assertEqual(len(self.app.cancel_jobs), 2)
            # The already accepted stop may be retried without admitting a new identity.
            with patch.object(self.app.cancellation_pool, 'submit', return_value=Future()) as submit:
                self.assertTrue(self.app.schedule_cancellation(identities[0]))
                call = submit.call_args.args
                call[0](*call[1:])
            self.assertTrue(self.app.has_job_capacity(cancellation=True))

    def test_unrecorded_workflow_failure_remains_local_and_blocks_automatic_dispatch(self):
        flows = self.app.workflows()
        record = flows.save(definition([role(self.app)]))
        flow = flows.start(record['id'], {'revision': 1, 'grant': True})
        with patch.object(self.app.pool, 'submit') as submit:
            self.app.schedule_flow(flow['id'])
            with patch.object(Workflows, 'execute', side_effect=RuntimeError('private failure')):
                with patch.object(Workflows, 'dispatch_error', side_effect=OSError('disk unavailable')):
                    with self.assertLogs('agent_framework.web', level='ERROR'):
                        submit.call_args.args[0]()
        for _ in range(4):
            self.execute(self.root())
        self.assertTrue(self.app.jobs[flow['id']]['_retention_required'])
        self.assertNotIn('private failure', self.app.job(flow['id'])['error'])
        with patch.object(self.app.pool, 'submit') as submit:
            Workflows.tick(self.app)
            submit.assert_not_called()
        with patch.object(self.app.pool, 'submit') as submit:
            self.app.schedule_flow(flow['id'])
            submit.call_args.args[0]()
        self.assertEqual(flows.run(flow['id'])['status'], 'SUCCEEDED')
        self.assertFalse(self.app.jobs[flow['id']]['_retention_required'])

    def test_completed_stop_errors_survive_eviction_without_repeating_cancel(self):
        identities = [self.root() for _ in range(5)]
        for identity in identities:
            self.app.control_store.request_cancellation(self.app.tenant, identity)
            with patch.object(self.app.cancellation_pool, 'submit', return_value=Future()) as submit:
                self.app.schedule_cancellation(identity)
                call = submit.call_args.args
                with patch.object(Runtime, 'cancel', side_effect=RuntimeError('private failure')):
                    call[0](*call[1:])
        self.assertNotIn(identities[0], self.app.cancel_jobs)
        self.assertEqual(len(self.app.cancel_jobs), 3)
        self.assertTrue(self.app.control_store.cancellation(self.app.tenant, identities[0])['error'])
        with patch.object(self.app.cancellation_pool, 'submit') as submit:
            self.app.recover_cancellations()
            submit.assert_not_called()

    def test_recovery_from_another_process_releases_the_pinned_capacity(self):
        identity = self.root()
        with patch.object(Runtime, 'run', side_effect=RuntimeError('private')):
            with patch.object(Store, 'interrupt_execution', side_effect=OSError('disk unavailable')):
                with self.assertLogs('agent_framework.web', level='ERROR'):
                    self.execute(identity)
        with patch.object(Application, 'JOB_CAPACITY', 1):
            self.assertFalse(self.app.has_job_capacity())
            other = Application(self.tmp.name, lease_seconds=.5, tool_timeout=.1)
            self.addCleanup(other.close)
            self.assertEqual(other.runtime().run(identity)['status'], 'SUCCEEDED')
            self.assertTrue(self.app.has_job_capacity())
            self.assertFalse(self.app.jobs[identity]['_retention_required'])

    def test_unavailable_database_does_not_discard_the_failure_fallback(self):
        identity = self.root()
        with patch.object(self.app.pool, 'submit', side_effect=RuntimeError('rejected')):
            with patch.object(Store, 'interrupt_execution', side_effect=OSError('disk unavailable')):
                with self.assertRaises(OSError):
                    self.app.schedule(identity)
        with patch.object(Application, 'JOB_CAPACITY', 1):
            with patch.object(Store, 'read_snapshot', side_effect=OSError('still unavailable')):
                self.assertFalse(self.app.has_job_capacity())
        self.assertTrue(self.app.jobs[identity]['_retention_required'])

    def test_later_durable_flow_error_and_stop_completion_release_fallbacks(self):
        flows = self.app.workflows()
        record = flows.save(definition([role(self.app)]))
        flow = flows.start(record['id'], {'revision': 1, 'grant': True})
        with patch.object(self.app.pool, 'submit', side_effect=RuntimeError('rejected')):
            with patch.object(Workflows, 'dispatch_error', side_effect=OSError('disk unavailable')):
                with self.assertRaises(OSError):
                    self.app.schedule_flow(flow['id'])
        identity = self.root()
        self.app.control_store.request_cancellation(self.app.tenant, identity)
        with patch.object(self.app.cancellation_pool, 'submit', side_effect=RuntimeError('rejected')):
            with patch.object(Store, 'fail_cancellation', side_effect=OSError('disk unavailable')):
                with self.assertRaises(OSError):
                    self.app.schedule_cancellation(identity)
        with patch.object(Application, 'JOB_CAPACITY', 1):
            self.assertFalse(self.app.has_job_capacity())
            self.assertFalse(self.app.has_job_capacity(cancellation=True))
            flows.dispatch_error(flow['id'], 1, '已记录的失败')
            self.app.runtime().cancel(identity, requested=True)
            self.assertTrue(self.app.has_job_capacity())
            self.assertTrue(self.app.has_job_capacity(cancellation=True))


if __name__ == '__main__':
    unittest.main()
