"""Non-streaming cognition keeps bounded collection and responsive cancellation."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_framework.llm import CodexConfig,CursorConfig,QoderConfig,LLMPlanner,ModelError
from agent_framework.model_stream import collect
from agent_framework.runtime import Runtime
from agent_framework.processes import stop_process_group


class WorkflowModelCancellationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='workflow-model-stop-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)

    def process(self,script):
        process=subprocess.Popen([sys.executable,'-u','-c',script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        def cleanup():
            stop_process_group(process)
            for pipe in (process.stdin,process.stdout,process.stderr):
                if not pipe.closed:pipe.close()
        self.addCleanup(cleanup);return process

    def test_collection_without_public_progress_honors_cancel(self):
        process=self.process('import time;time.sleep(3)')
        with self.assertRaisesRegex(ModelError,'task_cancelled'):
            collect(process,'goal',.2,'codex',cancel=lambda:True)
        self.assertIsNotNone(process.poll())

    def test_collection_without_public_progress_enforces_output_budget(self):
        process=self.process("import sys;sys.stdin.read();sys.stdout.write('x'*200000)")
        with patch('agent_framework.model_stream.LIMIT',65536),self.assertRaisesRegex(ModelError,'invalid_model_envelope'):
            collect(process,'goal',2,'codex')
        self.assertIsNotNone(process.poll())

    def test_saved_stop_prevents_workflow_format_retry(self):
        runtime=Runtime(self.tmp.name,planner=LLMPlanner(CodexConfig('fixture','low',timeout=1,max_attempts=2)))
        state=runtime.submit();requests=[]
        def generate(*args):
            requests.append(1)
            if len(requests)==1:
                runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test')
                return '{"broken":',{'usage':{'input_tokens':1,'output_tokens':1}}
            return '{"steps":[]}',{'usage':{'input_tokens':1,'output_tokens':1}}
        runtime.planner.transport.generate=generate;result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'CANCELLED');self.assertEqual(len(requests),1);self.assertEqual(result['model_calls'],1)

    def test_collection_kills_descendants_even_if_leader_already_exited(self):
        marker=Path(self.tmp.name)/'descendant-ready'
        child="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path("+repr(str(marker))+").write_text('ready');time.sleep(3)"
        script="import subprocess,sys,time;from pathlib import Path\np=subprocess.Popen([sys.executable,'-c',"+repr(child)+"])\nwhile not Path("+repr(str(marker))+").exists():time.sleep(.001)\nprint(p.pid,flush=True)"
        process=self.process(script);self.assertTrue(process.stdout.readline().strip().isdigit());process.wait(timeout=2);started=time.monotonic()
        with self.assertRaisesRegex(ModelError,'model_timeout') as caught:collect(process,'',.15,'codex',lambda event:None)
        self.assertFalse(getattr(caught.exception,'cleanup_failure',None));self.assertTrue(all(p.closed for p in (process.stdin,process.stdout,process.stderr)))
        self.assertLess(time.monotonic()-started,1.5)

    def test_all_cli_workflow_calls_observe_stop_without_public_progress(self):
        for config in (CodexConfig('fixture','low',timeout=3),CursorConfig('fixture',timeout=3),QoderConfig('fixture',timeout=3)):
            with self.subTest(provider=type(config).__name__):
                runtime=Runtime(self.tmp.name,planner=LLMPlanner(config));state=runtime.submit();children=[];original=subprocess.Popen
                def launch(command,**kwargs):
                    process=original([sys.executable,'-u','-c','import sys,time;sys.stdin.read();time.sleep(5)'],**kwargs);children.append(process)
                    runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test');return process
                started=time.monotonic()
                with patch('agent_framework.llm.subprocess.Popen',launch),patch('agent_framework.llm.Path.home',return_value=Path(self.tmp.name)):
                    result=runtime.run(state['run_id'])
                self.assertEqual(result['status'],'CANCELLED');self.assertEqual(result['model_calls'],1)
                self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll());self.assertLess(time.monotonic()-started,1.5)
                failed=[e['data']['code'] for e in runtime.store.events('tenant-demo',state['run_id']) if e['kind']=='model.failed']
                self.assertEqual(failed,['task_cancelled']);self.assertIsNone(runtime.planner.transport.should_cancel)
                self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['calls'],{})

    def test_stop_during_successful_response_prevents_applying_workflow_plan(self):
        runtime=Runtime(self.tmp.name,planner=LLMPlanner(CodexConfig('fixture','low',timeout=1)))
        state=runtime.submit()
        def generate(*args):
            runtime.store.request_cancellation('tenant-demo',state['run_id'],source='test')
            return json.dumps({'steps':[{'id':'late','description':'Do not apply after stop','tool_ref':None}]}),{'usage':{'input_tokens':1,'output_tokens':1}}
        runtime.planner.transport.generate=generate;result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'CANCELLED');self.assertEqual(result['plan'],[])
        self.assertFalse(any(e['kind']=='plan.created' for e in runtime.store.events('tenant-demo',state['run_id'])))

    def test_quiet_collection_preserves_unicode_input_and_bounds_stderr_without_parsing_progress(self):
        prompt='输入材料😀'*20000
        process=self.process("import sys,json;value=sys.stdin.read();sys.stderr.write('e'*200000);sys.stderr.flush();print(json.dumps({'echo':value},ensure_ascii=False))")
        with patch('agent_framework.model_stream.PublicProgress',side_effect=AssertionError('no public progress requested')):
            stdout,stderr=collect(process,prompt,3,'qoder')
        self.assertEqual(json.loads(stdout)['echo'],prompt);self.assertLessEqual(len(stderr.encode()),65536)
        self.assertTrue(all(pipe.closed for pipe in (process.stdin,process.stdout,process.stderr)))

    def test_quiet_collection_cancels_while_child_does_not_read_large_input(self):
        process=self.process('import time;time.sleep(5)');started=time.monotonic()
        with self.assertRaisesRegex(ModelError,'task_cancelled'):
            collect(process,'x'*500000,3,'cursor',cancel=lambda:time.monotonic()-started>.05)
        self.assertLess(time.monotonic()-started,1.5);self.assertIsNotNone(process.poll())
        self.assertTrue(all(pipe.closed for pipe in (process.stdin,process.stdout,process.stderr)))

    def test_quiet_collection_timeout_has_model_error_and_reaps_child(self):
        process=self.process('import time;time.sleep(5)');started=time.monotonic()
        with self.assertRaisesRegex(ModelError,'model_timeout'):collect(process,'',.15,'codex')
        self.assertLess(time.monotonic()-started,1.5);self.assertIsNotNone(process.poll())


if __name__=='__main__':unittest.main()
