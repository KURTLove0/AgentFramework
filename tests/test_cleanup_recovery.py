"""A crash between cleanup diagnostics and terminal failure cannot restart work."""
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.agents import agent_ref
from agent_framework.contracts import TaskContract,canonical,LeaseLost
from agent_framework.llm import LLMPlanner,CodexConfig,ModelError
from agent_framework.runtime import Runtime,CrashInjected
from tests import test_model_execution as fixtures


class CleanupRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)

    def runtime(self):
        profile=fixtures.ModelExecutionTests.profile(self);self.transport=fixtures.DirectFixture()
        planner=LLMPlanner(CodexConfig(profile['model'],**profile['options']),self.transport,agent_profile=profile)
        runtime=Runtime(self.tmp.name,planner=planner,lease_seconds=.5,tool_timeout=.2)
        state=runtime.submit(TaskContract(domain_pack_ref=profile['definition']['domain_pack_ref'],agent_ref=agent_ref(profile),execution_mode='direct',goal='恢复时保留原错误'),agent_profile=profile)
        return runtime,state

    def interrupted(self,stage='model.cleanup_unconfirmed',error='model_timeout'):
        runtime,state=self.runtime();failure=ModelError(error);failure.cleanup_failure={'kind':'PermissionError','pid':12345,'confirmed':False,'pipes_closed':True}
        def deny(request,result):raise failure
        self.transport.reply=deny;checkpoint=runtime.checkpoint
        def crash(current,lease,kind,data=None,**kwargs):
            checkpoint(current,lease,kind,data,**kwargs)
            if kind==stage:raise CrashInjected()
        with patch.object(runtime,'checkpoint',side_effect=crash),self.assertRaises(CrashInjected):runtime.run(state['run_id'])
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',('tenant-demo',state['run_id']))
        self.transport.reply=None
        return runtime,state

    def test_resume_after_cleanup_checkpoint_never_calls_model_again(self):
        runtime,state=self.interrupted();before=runtime.store.load('tenant-demo',state['run_id'])
        result=runtime.run(state['run_id'])
        self.assertEqual(len(self.transport.requests),1);self.assertEqual(result['model_calls'],1)
        self.assertEqual(result['status'],'FAILED');self.assertIn('model_timeout',result['last_error']);self.assertIn('清理未确认',result['last_error'])
        self.assertEqual(result['task'],before['task']);self.assertEqual(result['snapshot'],before['snapshot']);self.assertEqual(result['deadline'],before['deadline'])
        self.assertIsNone(result['report']);self.assertIsNone(runtime.store.cancellation('tenant-demo',state['run_id']))

    def test_resume_after_model_failure_event_is_also_bounded(self):
        runtime,state=self.interrupted('model.failed');result=runtime.run(state['run_id'])
        self.assertEqual(len(self.transport.requests),1);self.assertEqual(result['status'],'FAILED');self.assertIn('model_timeout',result['last_error'])
        self.assertEqual(result['cleanup_failure']['kind'],'PermissionError')

    def test_legacy_event_only_checkpoint_recovers_without_new_model(self):
        runtime,state=self.interrupted('model.failed');current=runtime.store.load('tenant-demo',state['run_id'])
        current.pop('cleanup_failure',None);current.pop('cleanup_model_error',None)
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(current),'tenant-demo',state['run_id']))
        result=runtime.run(state['run_id']);self.assertEqual(result['status'],'FAILED');self.assertEqual(len(self.transport.requests),1)
        self.assertIn('model_timeout',result['last_error'])

    def test_saved_cancellation_wins_without_losing_cleanup_or_calling_model(self):
        runtime,state=self.interrupted();runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test')
        result=runtime.run(state['run_id']);self.assertEqual(result['status'],'CANCELLED');self.assertEqual(len(self.transport.requests),1)
        self.assertIn('清理未确认',result['last_error']);self.assertFalse(result['cancellation']['pending'])

    def test_stale_execution_epoch_cannot_finish_replacement_state(self):
        runtime,state=self.interrupted();older=runtime.store.begin_execution('tenant-demo',state['run_id']);runtime.execution_epoch=older
        newer=runtime.store.begin_execution('tenant-demo',state['run_id']);before=runtime.store.load('tenant-demo',state['run_id']);events=runtime.store.events('tenant-demo',state['run_id'])
        with self.assertRaises(LeaseLost):runtime.run(state['run_id'])
        self.assertEqual(runtime.store.load('tenant-demo',state['run_id']),before);self.assertEqual(runtime.store.events('tenant-demo',state['run_id']),events)
        runtime.execution_epoch=newer;self.assertEqual(runtime.run(state['run_id'])['status'],'FAILED');self.assertEqual(len(self.transport.requests),1)

    def pending_write(self,missing=False):
        runtime=Runtime(self.tmp.name,lease_seconds=.5,tool_timeout=.2);state=runtime.submit(scenario='crash-after-write')
        with self.assertRaises(CrashInjected):runtime.run(state['run_id'])
        if missing:
            with runtime.external.connect() as db:db.execute('DELETE FROM drafts')
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',('tenant-demo',state['run_id']))
        lease=runtime.store.acquire('tenant-demo',state['run_id'],.5);current=runtime.store.load('tenant-demo',state['run_id'])
        error=ModelError('model_timeout');error.cleanup_failure={'kind':'PermissionError','pid':9999,'confirmed':False,'pipes_closed':True};checkpoint=runtime.checkpoint
        def crash(current,lease,kind,data=None,**kwargs):
            checkpoint(current,lease,kind,data,**kwargs)
            if kind=='model.cleanup_unconfirmed':raise CrashInjected()
        try:
            with patch.object(runtime,'checkpoint',side_effect=crash),self.assertRaises(CrashInjected):runtime.cognition_failed(current,lease,error)
        finally:runtime.store.release(current,lease)
        return runtime,state

    def test_recovery_reads_existing_write_without_recreating_or_planning(self):
        runtime,state=self.pending_write()
        with patch.object(runtime,'cognize',side_effect=AssertionError('no new cognition')):result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'NEEDS_REVIEW');self.assertIn('model_timeout',result['last_error'])
        self.assertTrue(any(a['tool_ref']=='report.draft.create@1.0.0' and a['status']=='OBSERVED' for a in result['actions']))
        stats=runtime.external.stats('tenant-demo',state['run_id']);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1);self.assertEqual(len(stats['drafts']),1)
        self.assertIsNone(runtime.store.cancellation('tenant-demo',state['run_id']))

    def test_absent_external_write_is_never_dispatched_again(self):
        runtime,state=self.pending_write(missing=True)
        with patch.object(runtime,'cognize',side_effect=AssertionError('no new cognition')):result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'FAILED');self.assertIn('model_timeout',result['last_error'])
        stats=runtime.external.stats('tenant-demo',state['run_id']);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1);self.assertEqual(stats['drafts'],[])
        self.assertTrue(any(a['tool_ref']=='report.draft.create@1.0.0' and a['status']=='PREPARED' for a in result['actions']))

    def test_second_crash_after_absence_readback_still_cannot_repeat_write(self):
        runtime,state=self.pending_write(missing=True);checkpoint=runtime.checkpoint
        def crash(current,lease,kind,data=None,**kwargs):
            checkpoint(current,lease,kind,data,**kwargs)
            if kind=='action.retry_after_reconcile':raise CrashInjected()
        with patch.object(runtime,'checkpoint',side_effect=crash),self.assertRaises(CrashInjected):runtime.run(state['run_id'])
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',('tenant-demo',state['run_id']))
        self.assertEqual(runtime.run(state['run_id'])['status'],'FAILED')
        self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['calls']['report.draft.create@1.0.0'],1)

    def test_denied_readback_preserves_unknown_write_for_human_review(self):
        from agent_framework.contracts import PolicyDenied
        runtime,state=self.pending_write()
        with patch.object(runtime.gateway,'authorize',side_effect=PolicyDenied('readback denied')):result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'NEEDS_REVIEW');self.assertIn('清理未确认',result['last_error'])
        self.assertEqual(result['cleanup_model_error'],'model_timeout')
        self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['calls']['report.draft.create@1.0.0'],1)

    def test_expired_recovery_preserves_deadline_and_does_not_start_model(self):
        runtime,state=self.interrupted();current=runtime.store.load('tenant-demo',state['run_id']);current['deadline']=1
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(current),'tenant-demo',state['run_id']))
        result=runtime.run(state['run_id']);self.assertEqual(result['status'],'EXPIRED');self.assertEqual(result['deadline'],1);self.assertEqual(len(self.transport.requests),1)
        self.assertEqual(result['cleanup_model_error'],'model_timeout')

    def test_cancellation_from_legacy_event_only_checkpoint_keeps_cleanup_fact(self):
        runtime,state=self.interrupted('model.failed');current=runtime.store.load('tenant-demo',state['run_id']);current.pop('cleanup_failure',None);current.pop('cleanup_model_error',None)
        with runtime.store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(current),'tenant-demo',state['run_id']))
        runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test');result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'CANCELLED');self.assertIn('清理未确认',result['last_error']);self.assertEqual(len(self.transport.requests),1)

    def test_cognition_entry_itself_refuses_persisted_cleanup(self):
        runtime,state=self.interrupted();current=runtime.store.load('tenant-demo',state['run_id']);lease=runtime.store.acquire('tenant-demo',state['run_id'],.5)
        try:
            with self.assertRaisesRegex(ModelError,'model_timeout'):runtime.cognize(current,lease,'execute')
            self.assertEqual(len(self.transport.requests),1)
        finally:runtime.store.release(current,lease)
