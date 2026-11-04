"""A saved stop request wins over a concurrent cognition error, with write drain."""
from pathlib import Path
import unittest
from uuid import uuid4

from agent_framework.agents import agent_ref
from agent_framework.contracts import LeaseLost,PolicyDenied,TaskContract,TOOLS,digest
from agent_framework.knowledge import KnowledgeUnavailable
from agent_framework.llm import CodexConfig,LLMPlanner,ModelError
from agent_framework.runtime import CrashInjected,Runtime
from agent_framework.store import Store
from tests import test_model_execution as fixtures


class CognitionCancellationTests(unittest.TestCase):
    setUp=fixtures.ModelExecutionTests.setUp
    profile=fixtures.ModelExecutionTests.profile
    def run_model(self,fixture,mode='direct'):
        profile=self.profile();runtime=Runtime(self.temp.name,planner=LLMPlanner(CodexConfig(profile['model'],**profile['options']),fixture,agent_profile=profile))
        identity='run-'+uuid4().hex;goal='撰写客户回访邮件'
        context={'task_id':identity,'turn':1,'goal':goal,'messages':[],'history_hash':digest([]),'omitted_messages':0} if mode=='conversation' else None
        task=TaskContract(domain_pack_ref=profile['definition']['domain_pack_ref'],agent_ref=agent_ref(profile),execution_mode=mode,goal=goal,conversation_context=context)
        state=runtime.submit(task,agent_profile=profile,run_id=identity)
        return runtime,runtime.run(state['run_id']),fixture

    def test_concurrent_model_and_source_errors_after_stop_finish_as_cancelled(self):
        for mode in ('direct','conversation'):
            for error in (PolicyDenied('blocked'),ModelError('model_timeout'),KnowledgeUnavailable('withdrawn'),ValueError('invalid output')):
                with self.subTest(mode=mode,error=type(error).__name__):
                    def reply(request,result):
                        run_id=request['context']['draft_key'].rsplit(':report:',1)[0]
                        Store(Path(self.temp.name)/'runtime.sqlite3').request_cancellation('tenant-demo',run_id,source='test')
                        raise error
                    runtime,result,fixture=self.run_model(fixture=fixtures.DirectFixture(reply),mode=mode)
                    self.assertEqual(result['status'],'CANCELLED');self.assertIsNone(result['report'])
                    self.assertEqual(len(fixture.requests),1);self.assertEqual(result['model_calls'],1)
                    stop=runtime.store.cancellation('tenant-demo',result['run_id'])
                    self.assertFalse(stop['pending']);self.assertEqual(stop['outcome'],'CANCELLED')

    def test_errors_without_a_saved_stop_keep_their_failure_state(self):
        for error,status in ((ModelError('model_timeout'),'FAILED'),(KnowledgeUnavailable('withdrawn'),'WAITING_INPUT')):
            with self.subTest(error=type(error).__name__):
                def reply(request,result):raise error
                runtime,result,_=self.run_model(fixture=fixtures.DirectFixture(reply))
                self.assertEqual(result['status'],status);self.assertIsNone(runtime.store.cancellation('tenant-demo',result['run_id']))

    def test_workflow_cognition_error_after_stop_cancels_without_new_business_actions(self):
        runtime=Runtime(self.temp.name,planner=LLMPlanner(CodexConfig('fixture','low',timeout=5)))
        state=runtime.submit()
        def generate(*args):
            runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test')
            raise PolicyDenied('native read blocked')
        runtime.planner.transport.generate=generate
        result=runtime.run(state['run_id']);self.assertEqual(result['status'],'CANCELLED')
        self.assertEqual(result['model_calls'],1);self.assertEqual(result['actions'],[])

    def test_cognition_error_after_stop_reconciles_an_existing_write_once(self):
        runtime=Runtime(self.temp.name,lease_seconds=.5,tool_timeout=.2);state=runtime.submit(scenario='crash-after-write')
        with self.assertRaises(CrashInjected):runtime.run(state['run_id'])
        with runtime.store.transaction() as db:
            db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',('tenant-demo',state['run_id']))
        lease=runtime.store.acquire('tenant-demo',state['run_id'],.5);state=runtime.store.load('tenant-demo',state['run_id'])
        try:
            runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test')
            runtime.cognition_failed(state,lease,ModelError('model_timeout'))
        finally:runtime.store.release(state,lease)
        result=runtime.store.result('tenant-demo',state['run_id']);self.assertEqual(result['status'],'CANCELLED')
        self.assertTrue(any(a['tool_ref']==TOOLS[2] and a['status']=='OBSERVED' for a in result['actions']))
        stats=runtime.external.stats('tenant-demo',state['run_id'])
        self.assertEqual(stats['calls'][TOOLS[2]],1);self.assertEqual(len(stats['drafts']),1)

    def test_lease_loss_still_precedes_cancellation_cleanup(self):
        runtime=Runtime(self.temp.name);state=runtime.submit();lease=runtime.store.acquire('tenant-demo',state['run_id'],10)
        runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test');runtime.store.release(state,lease)
        replacement=runtime.store.acquire('tenant-demo',state['run_id'],10)
        try:
            with self.assertRaises(LeaseLost):runtime.cognition_failed(state,lease,LeaseLost('replaced'))
            self.assertEqual(runtime.store.load('tenant-demo',state['run_id'])['status'],'CREATED')
            self.assertTrue(runtime.store.cancellation('tenant-demo',state['run_id'])['pending'])
        finally:runtime.store.release(state,replacement)


if __name__=='__main__':unittest.main()
