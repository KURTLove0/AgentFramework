"""Unexpected worker failures pause durably without replacing the original task."""
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.backups import create_backup,restore_backup
from agent_framework.contracts import LeaseLost,PolicyDenied,canonical
from agent_framework.runtime import Runtime
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,APIError
from agent_framework.workspace_scheduler import WorkspaceScheduler,tick
from tests.test_workflows import role,definition


class WorkerRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(lambda:self.app.close())

    def root(self,register=True,**options):
        run=self.app.create({'runtime':'mock','start':False,**options})['run']
        if register:TaskConversations(self.app).register(run)
        return run

    def wait(self,identity):
        deadline=time.monotonic()+6
        while time.monotonic()<deadline:
            job=self.app.job(identity)
            if not job or not job['active']:return self.app.detail(identity)
            time.sleep(.01)
        self.fail('worker did not finish')

    def fail_worker(self,run,register=True):
        with patch.object(Runtime,'run',side_effect=RuntimeError('PRIVATE_EXCEPTION_DETAIL')):
            if register:TaskConversations(self.app).dispatch(run['run_id'])
            else:self.app.schedule(run['run_id'])
            return self.wait(run['run_id'])

    def restart(self):
        self.app.close();self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2)

    def test_unexpected_failure_is_one_attempt_and_remains_paused_after_restart(self):
        root=self.root();detail=self.fail_worker(root);marker=detail['run']['interruption']
        self.assertEqual(marker['code'],'worker_exception');self.assertTrue(detail['conversation']['resumable'])
        self.assertEqual(detail['conversation']['last_error'],marker['message'])
        self.assertNotIn('PRIVATE_EXCEPTION_DETAIL',canonical(detail))
        with patch.object(Runtime,'run') as execute:
            for _ in range(3):TaskConversations.tick(self.app)
            execute.assert_not_called()
        self.restart()
        with patch.object(Runtime,'run') as execute:TaskConversations.tick(self.app);execute.assert_not_called()
        restored=self.app.detail(root['run_id']);self.assertIsNone(restored['job'])
        self.assertEqual(restored['run']['interruption'],marker)
        self.assertEqual(self.app.runs()['runs'][0]['last_error'],marker['message'])
        with self.assertRaisesRegex(APIError,'手动恢复'):self.app.schedule(root['run_id'],automatic=True)

    def test_explicit_resume_uses_same_task_snapshot_budget_and_grant(self):
        root=self.root();original=self.app.detail(root['run_id']);self.fail_worker(root)
        self.app.mutate(root['run_id'],'resume');completed=self.wait(root['run_id'])
        self.assertEqual(completed['run']['status'],'SUCCEEDED');self.assertNotIn('interruption',completed['run'])
        self.assertEqual(completed['run']['task'],root['task']);self.assertEqual(completed['run']['snapshot'],root['snapshot'])
        self.assertEqual(completed['run']['deadline'],root['deadline']);self.assertEqual(completed['grant']['expires_at'],original['grant']['expires_at'])
        self.assertEqual(completed['external']['calls']['report.draft.create@1.0.0'],1)
        kinds=[event['kind'] for event in completed['events']]
        self.assertEqual(kinds.count('worker.interrupted'),1);self.assertEqual(kinds.count('worker.retry_requested'),1)
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_interruption_is_waiting_in_filters_counts_and_attention(self):
        for registered in (False,True):
            root=self.root(registered);self.fail_worker(root,register=registered)
        listed=self.app.runs();self.assertEqual(listed['counts']['running'],0);self.assertEqual(listed['counts']['waiting'],2)
        self.assertEqual(len(self.app.runs({'status':'INTERRUPTED'})['runs']),2)
        self.assertEqual(len(self.app.runs({'status':'group:running'})['runs']),0)
        self.assertEqual(len(self.app.runs({'status':'group:waiting'})['runs']),2)
        self.assertEqual({task['attention_kind'] for task in self.app.attention()['tasks']},{'resume'})

    def test_interruption_diagnostics_stay_inside_workspace_and_principal_scope(self):
        root=self.root();self.fail_worker(root)
        other=Application(self.tmp.name,principal='another-user',lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):other.detail(root['run_id'])
        self.assertEqual(other.runs()['counts']['total'],0)
        workspace=self.app.workspaces.save(dict(name='另一个空间',business='测试',scenario='隔离',description='',revision=0))
        scoped=self.app.scoped(workspace['id'])
        with self.assertRaises(PolicyDenied):scoped.detail(root['run_id'])
        self.assertEqual(scoped.runs()['counts']['total'],0)

    def test_resume_keeps_expired_budget_instead_of_resetting_deadline(self):
        root=self.root(budget={'max_wall_seconds':.05});self.fail_worker(root);time.sleep(.06)
        self.app.mutate(root['run_id'],'resume');result=self.wait(root['run_id'])
        self.assertEqual(result['run']['status'],'EXPIRED');self.assertEqual(result['run']['deadline'],root['deadline'])
        self.assertFalse(result['external']['drafts']);self.assertNotIn('interruption',result['run'])

    def test_queued_message_stays_queued_until_user_resumes_failed_turn(self):
        root=self.root();self.fail_worker(root);service=TaskConversations(self.app)
        pending=service.append(root['run_id'],{'content':'排队的后续要求','request_id':'queued','revision':1})
        self.assertEqual(pending['conversation']['turns'][1]['status'],'QUEUED')
        with patch.object(Runtime,'run') as execute:TaskConversations.tick(self.app);execute.assert_not_called()
        self.app.mutate(root['run_id'],'resume');self.wait(root['run_id'])
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            detail=self.app.detail(root['run_id'])
            if detail['conversation']['turns'][1]['status']=='SUCCEEDED' and not detail['conversation']['active']:break
            time.sleep(.02)
        self.assertEqual(detail['conversation']['turns'][1]['status'],'SUCCEEDED')
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_executor_rejection_is_durable_and_not_an_automatic_retry_loop(self):
        root=self.root()
        with patch.object(self.app.pool,'submit',side_effect=RuntimeError('PRIVATE_EXECUTOR_DETAIL')):
            with self.assertRaises(RuntimeError):self.app.schedule(root['run_id'])
        failed=self.app.detail(root['run_id']);self.assertEqual(failed['run']['interruption']['code'],'executor_rejected')
        self.assertFalse(failed['job']['active']);self.restart()
        with patch.object(Runtime,'run') as execute:TaskConversations.tick(self.app);execute.assert_not_called()
        self.app.mutate(root['run_id'],'resume');self.assertEqual(self.wait(root['run_id'])['run']['status'],'SUCCEEDED')

    def test_runtime_initialization_failure_can_be_recorded_without_initializing_it_again(self):
        root=self.root();original=self.app.runtime
        def initialize(*args,**kwargs):
            if threading.current_thread().name.startswith('agent-web'):raise RuntimeError('PRIVATE_INIT_DETAIL')
            return original(*args,**kwargs)
        with patch.object(self.app,'runtime',side_effect=initialize):
            self.app.schedule(root['run_id']);failed=self.wait(root['run_id'])
        self.assertEqual(failed['run']['interruption']['code'],'runtime_initialization_failed')
        self.assertNotIn('PRIVATE_INIT_DETAIL',canonical(failed));self.assertFalse(failed['job']['active'])

    def test_stale_attempt_cannot_publish_an_error_over_new_attempt(self):
        root=self.root(False);store=self.app.control_store
        older=store.begin_execution(self.app.tenant,root['run_id']);newer=store.begin_execution(self.app.tenant,root['run_id'])
        self.assertFalse(store.interrupt_execution(self.app.tenant,root['run_id'],older,kind='ERROR',code='old',message='old',exception_type='RuntimeError'))
        runtime=self.app.runtime();runtime.execution_epoch=older
        with self.assertRaises(LeaseLost):runtime.run(root['run_id'])
        self.assertNotIn('interruption',store.load(self.app.tenant,root['run_id']))
        runtime=self.app.runtime();runtime.execution_epoch=newer;result=runtime.run(root['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED');self.assertEqual(len(self.app.detail(root['run_id'])['external']['drafts']),1)

    def test_two_process_views_with_queued_attempts_only_execute_the_latest(self):
        root=self.root(False);second=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(second.close)
        with patch.object(self.app.pool,'submit') as first_submit,patch.object(second.pool,'submit') as second_submit:
            self.app.schedule(root['run_id']);second.schedule(root['run_id'])
            first=first_submit.call_args.args;second_call=second_submit.call_args.args
            first[0](*first[1:]);self.assertIsNone(self.app.job(root['run_id']))
            self.assertNotIn('interruption',self.app.control_store.load(self.app.tenant,root['run_id']))
            second_call[0](*second_call[1:])
        detail=second.detail(root['run_id']);self.assertEqual(detail['run']['status'],'SUCCEEDED')
        self.assertEqual(detail['external']['calls']['report.draft.create@1.0.0'],1)

    def test_interruption_recording_is_idempotent_and_preserves_business_state(self):
        root=self.root(False);store=self.app.control_store;epoch=store.begin_execution(self.app.tenant,root['run_id'])
        before=store.load(self.app.tenant,root['run_id'])
        for _ in range(2):self.assertTrue(store.interrupt_execution(self.app.tenant,root['run_id'],epoch,kind='ERROR',code='worker_exception',message='执行已中断',exception_type='RuntimeError'))
        after=store.load(self.app.tenant,root['run_id'])
        self.assertEqual(after['version'],before['version']+1)
        for field in ('task','snapshot','status','deadline','steps','model_calls'):self.assertEqual(after[field],before[field])
        self.assertEqual(sum(e['kind']=='worker.interrupted' for e in store.events(self.app.tenant,root['run_id'])),1)

    def test_direct_cli_runtime_resume_clears_marker_and_stale_web_error(self):
        root=self.root();self.fail_worker(root)
        result=self.app.runtime().run(root['run_id']);self.assertEqual(result['status'],'SUCCEEDED')
        detail=self.app.detail(root['run_id']);self.assertNotIn('interruption',detail['run']);self.assertIsNone(detail['job'])
        self.assertIn('worker.resumed',[e['kind'] for e in detail['events']])

    def test_cancellation_clears_marker_without_creating_draft(self):
        root=self.root();self.fail_worker(root);self.app.mutate(root['run_id'],'cancel')
        detail=self.app.detail(root['run_id']);self.assertEqual(detail['run']['status'],'CANCELLED')
        self.assertNotIn('interruption',detail['run']);self.assertFalse(detail['external']['drafts'])
        self.assertIsNone(detail['job'])

    def test_crash_after_write_keeps_diagnostic_and_reconciles_once_after_restart(self):
        root=self.root(False,scenario='crash-after-write');self.app.schedule(root['run_id']);failed=self.wait(root['run_id'])
        self.assertEqual(failed['run']['interruption']['kind'],'CRASHED');self.assertEqual(len(failed['external']['drafts']),1)
        self.restart();self.assertEqual(self.app.detail(root['run_id'])['run']['interruption']['code'],'injected_crash')
        time.sleep(.55);self.app.mutate(root['run_id'],'resume');finished=self.wait(root['run_id'])
        self.assertEqual(finished['run']['status'],'SUCCEEDED');self.assertEqual(finished['external']['calls']['report.draft.create@1.0.0'],1)

    def test_daily_recovery_checks_durable_failure_after_restart_before_any_tick(self):
        agent=role(self.app);daily=WorkspaceScheduler(self.app)
        daily.save(dict(revision=0,enabled=False,timezone='Asia/Shanghai',daily_time='00:00',auto_start=True,
            tasks=[dict(agent_id=agent['id'],agent_revision=1,goal='每日恢复',change_id='daily-worker',grant=True,consent=False,mcp_consent=False)]))
        with patch.object(Runtime,'run',side_effect=RuntimeError('PRIVATE_DAILY_DETAIL')):
            plan=daily.dispatch(daily.generate()['id']);run=plan['items'][0]['run_id'];self.wait(run)
        self.restart()
        with patch.object(Runtime,'run') as execute,self.assertLogs('agent_framework.workspace_scheduler',level='ERROR'):
            tick(self.app);execute.assert_not_called()
        daily=WorkspaceScheduler(self.app);self.assertEqual(daily.get(plan['id'])['dispatch']['state'],'FAILED')
        daily.dispatch(plan['id']);self.assertEqual(self.wait(run)['run']['status'],'SUCCEEDED')

    def test_workflow_recovery_pauses_interrupted_child_until_new_explicit_request(self):
        agent=role(self.app);flows=self.app.workflows();definition_row=flows.save(definition([agent]));flow=flows.start(definition_row['id'],{'revision':1,'grant':True})
        paused=flows.execute(flow['id'],pause_after=1);child=next(iter(paused['nodes'].values()))['run_id']
        self.fail_worker(self.app.control_store.load(self.app.tenant,child),register=False)
        interrupted=flows.execute(flow['id']);self.assertEqual(interrupted['status'],'INTERRUPTED')
        self.assertIn('interruption',self.app.control_store.load(self.app.tenant,child))
        flows.request_dispatch(flow['id'],'resume');finished=flows.execute(flow['id']);self.assertEqual(finished['status'],'SUCCEEDED')
        self.assertNotIn('interruption',self.app.control_store.load(self.app.tenant,child))
        self.assertEqual(self.app.detail(child)['external']['calls']['report.draft.create@1.0.0'],1)

    def test_backup_preserves_interruption_without_unattended_restart(self):
        root=self.root();failed=self.fail_worker(root);archive=Path(self.tmp.name)/'backup.zip';target=Path(self.tmp.name)/'restored'
        create_backup(self.tmp.name,archive);restore_backup(archive,target)
        restored=Application(target,lease_seconds=.5,tool_timeout=.2);self.addCleanup(restored.close)
        with patch.object(Runtime,'run') as execute:TaskConversations.tick(restored);execute.assert_not_called()
        self.assertEqual(restored.detail(root['run_id'])['run']['interruption'],failed['run']['interruption'])
        restored.mutate(root['run_id'],'resume')
        deadline=time.monotonic()+5
        while (restored.job(root['run_id']) or {}).get('active') and time.monotonic()<deadline:time.sleep(.02)
        self.assertEqual(restored.detail(root['run_id'])['run']['status'],'SUCCEEDED')
        self.assertIn('interruption',self.app.control_store.load(self.app.tenant,root['run_id']))
