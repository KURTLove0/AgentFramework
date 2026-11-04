"""Stop intent is durable, independent of worker ownership and queue capacity."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.backups import create_backup,restore_backup
from agent_framework.contracts import LeaseBusy,PolicyDenied,canonical
from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime import Runtime,CrashInjected
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,APIError
from tests.test_workflows import role,definition


class CancellationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.6,tool_timeout=.1);self.addCleanup(lambda:self.app.close())

    def root(self,paused=False,**options):
        state=self.app.create({'runtime':'mock','start':False,**options})['run']
        if paused:self.app.runtime().run(state['run_id'],pause_after=1)
        return self.app.control_store.load(self.app.tenant,state['run_id'])

    def wait_stop(self,identity,app=None,status='CANCELLED'):
        app=app or self.app;deadline=time.monotonic()+7
        while time.monotonic()<deadline:
            detail=app.detail(identity)
            if detail['run']['status']==status and not (app.job(identity) or {}).get('active') and not app.cancel_jobs.get(identity,{}).get('active'):return detail
            time.sleep(.01)
        self.fail('stop did not finish: '+str(app.control_store.load(app.tenant,identity)['status']))

    def restart(self):
        self.app.close();self.app=Application(self.tmp.name,lease_seconds=.6,tool_timeout=.1)

    def test_other_process_view_accepts_stop_without_changing_active_checkpoint_version(self):
        root=self.root();store=self.app.control_store;lease=store.acquire(self.app.tenant,root['run_id'],30)
        other=Application(self.tmp.name,lease_seconds=.6,tool_timeout=.1);self.addCleanup(other.close)
        try:
            result=other.mutate(root['run_id'],'cancel')
            self.assertTrue(result['cancellation']['pending']);self.assertEqual(result['conversation']['status'],'CANCELLING')
            saved=store.load(self.app.tenant,root['run_id']);self.assertEqual(saved['version'],root['version'])
            self.assertEqual(saved['task'],root['task']);self.assertEqual(saved['snapshot'],root['snapshot'])
            store.renew(saved,lease,30)
            again=other.mutate(root['run_id'],'cancel');self.assertEqual(again['cancellation']['generation'],1)
            self.assertEqual(again['cancellation']['requested_at'],result['cancellation']['requested_at'])
            self.assertEqual(sum(e['kind']=='run.cancel_requested' for e in result['events']),1)
        finally:store.release(root,lease)

    def test_remote_stop_interrupts_actual_model_call_without_local_job_signal(self):
        entered=threading.Event()
        def generate(transport,*args,**kwargs):
            entered.set();deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if transport.should_cancel and transport.should_cancel():raise ModelError('task_cancelled')
                time.sleep(.01)
            raise RuntimeError('cancel signal was not observed')
        with patch.object(ModelCatalog,'list',return_value={'models':[{'id':'fixture','efforts':['low']}],'source':'fixture'}),patch.object(CodexTransport,'generate',generate):
            agent=self.app.agents.save(dict(name='停止验收助手',description='合成模型',runtime='codex',model='fixture',options={'timeout':5,'max_attempts':1,'reasoning_effort':'low'},prompt='按目标处理',skills=[],mcp_servers=[],revision=0,definition=default_definition('停止验收助手','general-assistant@1.0.0')))
            root=self.app.start_task({'goal':'等待另一个进程发出停止','agent_id':agent['id'],'agent_revision':1,'request_id':'remote-stop'})['run']
            self.assertTrue(entered.wait(3));other=Application(self.tmp.name,lease_seconds=.6,tool_timeout=.1);self.addCleanup(other.close)
            receipt=other.mutate(root['run_id'],'cancel');self.assertTrue(receipt['cancellation']['pending'])
            self.assertFalse(self.app.jobs[root['run_id']]['cancel'].is_set())
            finished=self.wait_stop(root['run_id']);self.assertEqual(finished['cancellation']['outcome'],'CANCELLED')
            self.assertNotIn('interruption',finished['run']);self.assertFalse(finished['external']['drafts'])

    def test_queued_task_can_stop_before_an_agent_worker_slot_is_free(self):
        root=self.root();release=threading.Event();barrier=threading.Barrier(5)
        def busy():barrier.wait(timeout=5);release.wait(5)
        for _ in range(4):self.app.pool.submit(busy)
        try:
            barrier.wait(timeout=5);self.app.schedule(root['run_id']);future=self.app.jobs[root['run_id']]['future']
            result=self.app.mutate(root['run_id'],'cancel');self.assertEqual(result['run']['status'],'CANCELLED')
            self.assertTrue(future.cancelled());self.assertFalse(self.app.jobs[root['run_id']]['active'])
            self.assertFalse(result['external']['drafts']);self.assertEqual(result['cancellation']['outcome'],'CANCELLED')
        finally:release.set()

    def test_cleanup_is_not_starved_by_a_full_agent_execution_pool(self):
        root=self.root(paused=True);release=threading.Event();barrier=threading.Barrier(5)
        def busy():barrier.wait(timeout=5);release.wait(5)
        for _ in range(4):self.app.pool.submit(busy)
        try:
            barrier.wait(timeout=5);self.app.jobs.update({'capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
            self.app.mutate(root['run_id'],'cancel');finished=self.wait_stop(root['run_id'])
            self.assertFalse(release.is_set());self.assertEqual(finished['cancellation']['outcome'],'CANCELLED')
        finally:release.set();self.app.jobs={k:v for k,v in self.app.jobs.items() if not k.startswith('capacity-')}

    def test_saved_stop_survives_restart_and_expired_owner_without_resuming_task(self):
        root=self.root(paused=True);lease=self.app.control_store.acquire(self.app.tenant,root['run_id'],30)
        self.app.mutate(root['run_id'],'cancel');self.restart()
        self.assertTrue(self.app.control_store.cancellation(self.app.tenant,root['run_id'])['pending'])
        with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET lease_until=0 WHERE id=?',(root['run_id'],))
        with patch.object(Runtime,'run',side_effect=AssertionError('a stop must not resume execution')):
            self.app.recover_cancellations();finished=self.wait_stop(root['run_id'])
        self.assertFalse(finished['external']['drafts']);self.assertEqual(finished['run']['deadline'],root['deadline'])

    def test_stop_failure_is_durable_and_only_explicit_retry_restarts_cleanup(self):
        root=self.root(paused=True)
        with patch.object(Runtime,'cancel',side_effect=RuntimeError('PRIVATE_STOP_DETAIL')):
            self.app.mutate(root['run_id'],'cancel');deadline=time.monotonic()+4
            while self.app.cancel_jobs.get(root['run_id'],{}).get('active') and time.monotonic()<deadline:time.sleep(.01)
        failed=self.app.detail(root['run_id']);self.assertTrue(failed['cancellation']['error'])
        self.assertEqual(failed['conversation']['status'],'INTERRUPTED');self.assertNotIn('PRIVATE_STOP_DETAIL',canonical(failed))
        self.restart()
        with patch.object(Runtime,'cancel') as stop:self.app.recover_cancellations();stop.assert_not_called()
        self.assertEqual(self.app.attention()['tasks'][0]['attention_kind'],'cancel')
        self.app.mutate(root['run_id'],'cancel');done=self.wait_stop(root['run_id'])
        self.assertEqual(done['cancellation']['generation'],2);self.assertEqual(done['cancellation']['requested_at'],failed['cancellation']['requested_at'])
        self.assertFalse(done['cancellation']['error']);self.assertEqual(sum(e['kind']=='run.cancel_retried' for e in done['events']),1)

    def test_control_executor_rejection_preserves_stop_intent_and_retry_action(self):
        root=self.root(paused=True)
        with patch.object(self.app.cancellation_pool,'submit',side_effect=RuntimeError('PRIVATE_POOL_DETAIL')):
            receipt=self.app.mutate(root['run_id'],'cancel')
        self.assertTrue(receipt['cancellation']['pending']);self.assertTrue(receipt['cancellation']['error'])
        self.assertFalse(receipt['conversation']['resumable']);self.assertNotIn('PRIVATE_POOL_DETAIL',canonical(receipt))
        self.app.mutate(root['run_id'],'cancel');self.wait_stop(root['run_id'])

    def test_existing_execution_exits_once_when_stop_cleanup_has_failed(self):
        root=self.root(paused=True);entered=threading.Event();release=threading.Event();original=Runtime.run;calls=[]
        def controlled(runtime,*args,**kwargs):
            calls.append(1);entered.set();release.wait(5);return original(runtime,*args,**kwargs)
        with patch.object(Runtime,'run',controlled):
            self.app.schedule(root['run_id']);self.assertTrue(entered.wait(3))
            try:
                with patch.object(self.app.cancellation_pool,'submit',side_effect=RuntimeError('unavailable')):
                    self.app.mutate(root['run_id'],'cancel')
            finally:release.set()
            deadline=time.monotonic()+3
            while self.app.jobs[root['run_id']]['active'] and time.monotonic()<deadline:time.sleep(.01)
            self.assertFalse(self.app.jobs[root['run_id']]['active']);self.assertEqual(len(calls),1)
        saved=self.app.control_store.cancellation(self.app.tenant,root['run_id']);self.assertTrue(saved['error']);self.assertEqual(saved['generation'],1)
        self.app.mutate(root['run_id'],'cancel');self.wait_stop(root['run_id'])

    def test_resume_and_new_grant_cannot_override_pending_stop(self):
        root=self.root(paused=True);lease=self.app.control_store.acquire(self.app.tenant,root['run_id'],30)
        try:
            self.app.mutate(root['run_id'],'cancel')
            with self.assertRaises(APIError):self.app.schedule(root['run_id'])
            with self.assertRaises(PolicyDenied):self.app.control_store.grant(root,'new-grant')
        finally:self.app.control_store.release(root,lease)
        with self.assertRaisesRegex(LeaseBusy,'停止请求'):self.app.control_store.begin_execution(self.app.tenant,root['run_id'])
        self.app.recover_cancellations();self.wait_stop(root['run_id'])

    def test_write_after_crash_is_reconciled_once_before_cancellation(self):
        root=self.root(scenario='crash-after-write')
        with self.assertRaises(CrashInjected):self.app.runtime().run(root['run_id'])
        receipt=self.app.mutate(root['run_id'],'cancel');self.assertTrue(receipt['cancellation']['pending'])
        self.assertEqual(len(receipt['external']['drafts']),1);time.sleep(.65)
        self.app.recover_cancellations();finished=self.wait_stop(root['run_id'])
        self.assertEqual(finished['external']['calls']['report.draft.create@1.0.0'],1)
        self.assertEqual(len(finished['external']['drafts']),1);self.assertEqual(finished['cancellation']['outcome'],'CANCELLED')

    def test_terminal_task_keeps_its_actual_result(self):
        root=self.root();self.app.runtime().run(root['run_id'])
        detail=self.app.mutate(root['run_id'],'cancel');self.assertEqual(detail['run']['status'],'SUCCEEDED')
        self.assertIsNone(detail['cancellation']);self.assertEqual(detail['external']['calls']['report.draft.create@1.0.0'],1)

    def test_cli_can_save_stop_request_while_another_process_holds_run(self):
        root=self.root(paused=True);lease=self.app.control_store.acquire(self.app.tenant,root['run_id'],30)
        try:
            result=subprocess.run([sys.executable,'-m','agent_framework','--data-dir',self.tmp.name,'cancel',root['run_id']],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr);body=json.loads(result.stdout)
            self.assertTrue(body['cancellation']['pending']);self.assertEqual(body['status'],'RUNNING')
        finally:self.app.control_store.release(root,lease)
        self.app.recover_cancellations();self.wait_stop(root['run_id'])

    def test_backup_restores_pending_stop_as_stop_instead_of_execution(self):
        root=self.root(paused=True);self.app.control_store.request_cancellation(self.app.tenant,root['run_id'],source='test')
        archive=Path(self.tmp.name)/'stops.zip';target=Path(self.tmp.name)/'restored'
        create_backup(self.tmp.name,archive);restore_backup(archive,target)
        restored=Application(target,lease_seconds=.6,tool_timeout=.1);self.addCleanup(restored.close)
        with patch.object(Runtime,'run',side_effect=AssertionError('restored stop must not execute')):
            restored.recover_cancellations();finished=self.wait_stop(root['run_id'],restored)
        self.assertFalse(finished['external']['drafts']);self.assertTrue(self.app.control_store.cancellation(self.app.tenant,root['run_id'])['pending'])

    def test_stop_request_remains_private_and_inside_workspace(self):
        root=self.root(paused=True);other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):other.mutate(root['run_id'],'cancel')
        self.assertIsNone(self.app.control_store.cancellation(self.app.tenant,root['run_id']))
        self.app.control_store.request_cancellation(self.app.tenant,root['run_id'])
        other.recover_cancellations();self.assertEqual(other.runs()['counts']['total'],0)
        self.assertEqual(self.app.control_store.load(self.app.tenant,root['run_id'])['status'],'RUNNING')

    def test_failed_or_stale_cleanup_cannot_overwrite_completed_stop(self):
        root=self.root();done=self.app.mutate(root['run_id'],'cancel')
        self.assertEqual(done['run']['status'],'CANCELLED')
        self.assertFalse(self.app.control_store.fail_cancellation(self.app.tenant,root['run_id'],1,'old failure'))
        self.assertFalse(self.app.control_store.cancellation(self.app.tenant,root['run_id'])['error'])

    def test_recovery_resolves_old_failed_stop_when_runtime_has_already_finished(self):
        root=self.root(paused=True);store=self.app.control_store
        request=store.request_cancellation(self.app.tenant,root['run_id'])
        store.fail_cancellation(self.app.tenant,root['run_id'],request['generation'],'旧进程的停止错误')
        # An older process can finish without this version's completion hook.
        with store.transaction() as db:
            db.execute("UPDATE runs SET state=json_set(state,'$.status','SUCCEEDED') WHERE tenant_id=? AND id=?",(self.app.tenant,root['run_id']))
        with patch.object(Runtime,'run',side_effect=AssertionError('finished work must not be resumed')):
            self.app.recover_cancellations()
        resolved=store.cancellation(self.app.tenant,root['run_id'])
        self.assertFalse(resolved['pending']);self.assertEqual(resolved['outcome'],'SUCCEEDED');self.assertIsNone(resolved['error'])

    def test_workflow_waits_for_child_stop_instead_of_busy_looping_or_resuming(self):
        profile=role(self.app);flows=self.app.workflows();saved=flows.save(definition([profile]))
        flow=flows.start(saved['id'],{'revision':1,'grant':True});paused=flows.execute(flow['id'],pause_after=1)
        child=next(iter(paused['nodes'].values()))['run_id'];request=self.app.control_store.request_cancellation(self.app.tenant,child)
        self.app.control_store.fail_cancellation(self.app.tenant,child,request['generation'],'请重试停止')
        with patch.object(Runtime,'run',side_effect=AssertionError('a stopping node must not execute')):
            blocked=flows.execute(flow['id'])
        self.assertEqual(blocked['status'],'INTERRUPTED');self.assertIn('重试停止',blocked['last_error'])
        self.assertTrue(self.app.control_store.cancellation(self.app.tenant,child)['error'])

    def test_owner_process_exit_and_cli_stop_survive_until_lease_expires(self):
        root=self.root(paused=True)
        program='''
import os,sys
from agent_framework.store import Store
store=Store(sys.argv[1]+'/runtime.sqlite3')
store.acquire('tenant-demo',sys.argv[2],.3)
os._exit(73)
'''
        process=subprocess.run([sys.executable,'-c',program,self.tmp.name,root['run_id']],cwd=Path(__file__).resolve().parents[1],capture_output=True,timeout=5)
        self.assertEqual(process.returncode,73)
        self.assertTrue(self.app.mutate(root['run_id'],'cancel')['cancellation']['pending'])
        time.sleep(.35);self.app.recover_cancellations();self.wait_stop(root['run_id'])
