"""A superseded cognition stops its local process without touching the new owner."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.agents import agent_ref
from agent_framework.contracts import LeaseLost,TaskContract
from agent_framework.llm import CodexConfig,CursorConfig,QoderConfig,LLMPlanner
from agent_framework.model_stream import collect
from agent_framework.runtime import Runtime
from tests import test_model_execution as fixtures


class CognitionLeaseLossTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='cognition-lease-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)

    def replaced_call(self,mode='legacy',provider='codex',finish=False):
        profile=None
        if mode=='direct':
            profile=fixtures.ModelExecutionTests.profile(self,provider);profile['options']['timeout']=3
        config={'codex':CodexConfig,'cursor':CursorConfig,'qoder':QoderConfig}[provider]('fixture-model',**(profile['options'] if profile else {'timeout':3}))
        runtime=Runtime(self.tmp.name,planner=LLMPlanner(config,agent_profile=profile),lease_seconds=.3,tool_timeout=.1)
        task=TaskContract() if profile is None else TaskContract(domain_pack_ref=profile['definition']['domain_pack_ref'],agent_ref=agent_ref(profile),execution_mode='direct',goal='撰写客户回访邮件')
        state=runtime.submit(task,agent_profile=profile);children=[];replacement=[];saved=[];saved_events=[];saved_owners=[];original=subprocess.Popen
        def launch(command,**kwargs):
            child=original([sys.executable,'-u','-c','import time;time.sleep(5)'],**kwargs);children.append(child)
            # Simulate lease expiration and actual takeover through Store.acquire,
            # with a newer checkpoint. Keep the local heartbeat out of this gap.
            with runtime._state_lock:
                with runtime.store.transaction() as db:
                    db.execute('UPDATE runs SET lease_until=0 WHERE tenant_id=? AND id=?',('tenant-demo',state['run_id']))
                lease=runtime.store.acquire('tenant-demo',state['run_id'],10);replacement.append(lease)
                current=runtime.store.load('tenant-demo',state['run_id']);runtime.store.checkpoint(current,lease,'test.new_owner')
                if finish:
                    runtime.store.release(current,lease)
                    planner=LLMPlanner.restore(current['snapshot']['planner']);planner.transport=fixtures.DirectFixture()
                    recovered=Runtime(self.tmp.name,planner=planner).run(state['run_id'])
                    self.assertEqual(recovered['status'],'SUCCEEDED')
                saved.append(runtime.store.load('tenant-demo',state['run_id']))
                saved_events.append(runtime.store.events('tenant-demo',state['run_id']))
                with runtime.store.connect() as db:
                    saved_owners.append(tuple(db.execute('SELECT owner,epoch FROM runs WHERE id=?',(state['run_id'],)).fetchone()))
            return child
        started=time.monotonic()
        try:
            with patch('agent_framework.llm.subprocess.Popen',launch),patch('agent_framework.llm.Path.home',return_value=Path(self.tmp.name)):
                with self.assertRaises(LeaseLost):runtime.run(state['run_id'])
            elapsed=time.monotonic()-started
            self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll())
            self.assertEqual(runtime.store.load('tenant-demo',state['run_id']),saved[0])
            self.assertIsNone(runtime.store.cancellation('tenant-demo',state['run_id']))
            with runtime.store.connect() as db:
                row=db.execute('SELECT owner,epoch FROM runs WHERE id=?',(state['run_id'],)).fetchone()
                self.assertEqual(tuple(row),saved_owners[0]);self.assertEqual(db.execute('SELECT COUNT(*) FROM read_sessions WHERE revoked=0').fetchone()[0],0)
            events=runtime.store.events('tenant-demo',state['run_id']);self.assertEqual(events,saved_events[0])
            self.assertFalse(any(e['kind'] in ('model.failed','run.cancel_requested','plan.created','run.failed') for e in events))
            self.assertIsNone(runtime.planner.observer);self.assertIsNone(runtime.planner.prepare_context);self.assertIsNone(runtime.planner.transport.should_cancel)
            self.assertLess(elapsed,1.5)
        finally:
            if replacement:runtime.store.release(runtime.store.load('tenant-demo',state['run_id']),replacement[0])
            for child in children:
                from agent_framework.processes import stop_process_group
                stop_process_group(child)

    def test_legacy_silent_model_process_stops_when_lease_is_replaced(self):
        self.replaced_call()

    def test_direct_rpc_model_process_stops_when_lease_is_replaced(self):
        self.replaced_call('direct')

    def test_cursor_and_qoder_preserve_replacement_in_both_execution_modes(self):
        for provider in ('cursor','qoder'):
            for mode in ('legacy','direct'):
                with self.subTest(provider=provider,mode=mode):self.replaced_call(mode,provider)

    def test_stale_cognition_does_not_overwrite_a_completed_replacement(self):
        self.replaced_call('direct',finish=True)

    def test_healthy_heartbeat_keeps_a_silent_call_running(self):
        runtime=Runtime(self.tmp.name,planner=LLMPlanner(CodexConfig('fixture',timeout=2)),lease_seconds=.3,tool_timeout=.1)
        state=runtime.submit();lease=runtime.store.acquire('tenant-demo',state['run_id'],.3)
        steps=[{'id':'scope','description':'核对任务范围','tool_ref':None}]
        def generate(*args):
            child=subprocess.Popen([sys.executable,'-u','-c','import sys,time;sys.stdin.read();time.sleep(.5);print(sys.argv[1])',json.dumps({'steps':steps})],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
            stdout,_=collect(child,'goal',2,'codex',cancel=runtime.planner.transport.should_cancel)
            return stdout,{'usage':{'input_tokens':1,'output_tokens':1}}
        runtime.planner.transport.generate=generate
        try:
            self.assertEqual(runtime.cognize(state,lease,'plan'),steps);runtime.store.renew(state,lease,.3)
            self.assertEqual(state['model_calls'],1);self.assertIsNone(runtime.store.cancellation('tenant-demo',state['run_id']))
        finally:runtime.store.release(state,lease)


if __name__=='__main__':unittest.main()
