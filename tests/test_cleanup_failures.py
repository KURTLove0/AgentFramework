"""Cleanup denial must not lose primary failures or retain blocked pipe workers."""
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from agent_framework.contracts import LeaseLost
from agent_framework.llm import CodexConfig,CodexTransport,ModelError
from agent_framework.model_execution import SCHEMA
from agent_framework.model_stream import collect
from agent_framework.processes import stop_process_group


class CleanupFailureTests(unittest.TestCase):
    def child(self,script,**kwargs):
        child=subprocess.Popen([sys.executable,'-u','-c',script],**(kwargs or dict(stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)))
        self.addCleanup(self.reap,child);return child

    def reap(self,child):
        stop_process_group(child)
        for pipe in (child.stdin,child.stdout,child.stderr):pipe.close()

    def test_denied_signal_can_finish_only_after_group_absence_is_confirmed(self):
        child=self.child('pass');child.wait(timeout=2);original=os.killpg;calls=[]
        def send(pid,sig):
            calls.append(sig)
            if sig:raise PermissionError('signal denied after exit')
            return original(pid,sig)
        with patch('agent_framework.processes.os.killpg',send):stop_process_group(child)
        self.assertIn(0,calls);self.assertEqual(child.returncode,0)

    def test_live_descendant_is_not_treated_as_absent_when_signals_are_denied(self):
        with tempfile.TemporaryDirectory(prefix='denied-descendant-',dir='/private/tmp') as directory:
            marker=Path(directory)/'ready'
            descendant="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path("+repr(str(marker))+").write_text('ready');time.sleep(10)"
            script="import subprocess,sys,time;from pathlib import Path\nsubprocess.Popen([sys.executable,'-c',"+repr(descendant)+"])\nwhile not Path("+repr(str(marker))+").exists():time.sleep(.001)"
            child=self.child(script);child.wait(timeout=2);original=os.killpg;probes=[]
            def denied(pid,sig):
                if sig:raise PermissionError('denied')
                probes.append(pid);return original(pid,0)
            started=time.monotonic()
            with patch('agent_framework.processes.os.killpg',denied),self.assertRaises(PermissionError):stop_process_group(child)
            self.assertTrue(probes);self.assertLess(time.monotonic()-started,.6);original(child.pid,0)

    def test_rpc_lease_failure_keeps_identity_and_closes_pipes_after_cleanup_denial(self):
        original=subprocess.Popen;children=[];failure=LeaseLost('new worker owns task');before=set(threading.enumerate())
        def launch(command,**kwargs):
            child=original([sys.executable,'-u','-c','import time;time.sleep(10)'],**kwargs);children.append(child);self.addCleanup(self.reap,child);return child
        def lost():raise failure
        transport=CodexTransport();transport.stream_output=True;transport.should_cancel=lost
        with patch('agent_framework.codex_stream.subprocess.Popen',launch),patch('agent_framework.codex_stream.stop_process_group',side_effect=PermissionError('denied')):
            with self.assertRaises(LeaseLost) as caught:transport.generate('bounded',SCHEMA,CodexConfig('fixture',timeout=2),2)
        self.assertIs(caught.exception,failure);self.assertEqual(failure.cleanup_failure['kind'],'PermissionError')
        self.assertTrue(all(p.closed for p in (children[0].stdin,children[0].stdout,children[0].stderr)))
        self.assertEqual(set(threading.enumerate())-before,set());self.assertIsNone(children[0].poll())

    def test_collect_cancel_with_blocked_stdin_closes_locally_without_claiming_process_stopped(self):
        child=self.child('import time;time.sleep(10)');before=set(threading.enumerate());started=time.monotonic()
        with patch('agent_framework.model_stream.stop_process_group',side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(ModelError,'task_cancelled') as caught:collect(child,'x'*4_000_000,3,'cursor',cancel=lambda:True)
        self.assertEqual(caught.exception.cleanup_failure['kind'],'PermissionError');self.assertLess(time.monotonic()-started,1)
        self.assertTrue(all(p.closed for p in (child.stdin,child.stdout,child.stderr)));self.assertEqual(set(threading.enumerate())-before,set())
        self.assertIsNone(child.poll())

    def test_valid_output_with_denied_cleanup_cannot_be_reported_successful(self):
        child=self.child("import sys;sys.stdin.read();print('finished')")
        with patch('agent_framework.model_stream.stop_process_group',side_effect=PermissionError('PRIVATE_DENIAL_DETAIL')):
            with self.assertRaisesRegex(ModelError,'^model_cleanup_failed$') as caught:collect(child,'bounded',2,'cursor')
        self.assertEqual(caught.exception.cleanup_failure['kind'],'PermissionError')
        self.assertNotIn('PRIVATE',str(caught.exception.cleanup_failure));self.assertTrue(all(p.closed for p in (child.stdin,child.stdout,child.stderr)))

    def test_nonblocking_io_drains_output_while_writing_large_input(self):
        # The child fills stdout before reading a prompt larger than pipe capacity.
        child=self.child("import sys;sys.stdout.write('中'*60000);sys.stdout.flush();value=sys.stdin.read();sys.stderr.write(str(len(value)))")
        stdout,stderr=collect(child,'输入'*100000,3,'cursor')
        self.assertEqual(stdout,'中'*60000);self.assertEqual(stderr,'200000')

    def test_partial_utf8_and_crlf_events_are_decoded_without_losing_output(self):
        child=self.child("import os,time;data='中文😀\\r\\n'.encode();[(os.write(1,bytes([b])),time.sleep(.001)) for b in data]")
        stdout,stderr=collect(child,'',2,'qoder');self.assertEqual(stdout,'中文😀\n');self.assertEqual(stderr,'')

    def test_invalid_unicode_is_a_bounded_model_failure_with_closed_pipes(self):
        child=self.child("import os;os.write(1,b'\\xff')")
        with self.assertRaisesRegex(ModelError,'invalid_model_envelope'):collect(child,'',2,'cursor')
        self.assertTrue(all(p.closed for p in (child.stdin,child.stdout,child.stderr)))

    def test_runtime_records_original_failure_and_unconfirmed_cleanup_without_private_stderr(self):
        from agent_framework.runtime import Runtime
        from agent_framework.llm import LLMPlanner
        original=subprocess.Popen;children=[]
        with tempfile.TemporaryDirectory(prefix='cleanup-runtime-',dir='/private/tmp') as directory:
            planner=LLMPlanner(CodexConfig('fixture',timeout=.2));planner.transport.stream_output=True
            runtime=Runtime(directory,planner=planner);run=runtime.submit()
            script="import sys,time;sys.stderr.write('PRIVATE_STDERR');sys.stderr.flush();time.sleep(10)"
            def launch(command,**kwargs):
                child=original([sys.executable,'-u','-c',script],**kwargs);children.append(child);self.addCleanup(self.reap,child);return child
            with patch('agent_framework.codex_stream.subprocess.Popen',launch),patch('agent_framework.codex_stream.stop_process_group',side_effect=PermissionError('PRIVATE_DENIAL')),patch('agent_framework.model_stream.stop_process_group',side_effect=PermissionError('PRIVATE_DENIAL')):
                result=runtime.run(run['run_id'])
            self.assertEqual(result['status'],'FAILED');self.assertIn('model_timeout',result['last_error']);self.assertIn('清理未确认',result['last_error'])
            events=runtime.store.events('tenant-demo',run['run_id']);failure=next(e for e in events if e['kind']=='model.failed')
            self.assertEqual(failure['data']['code'],'model_timeout');self.assertFalse(failure['data']['cleanup_failure']['confirmed'])
            self.assertTrue(any(e['kind']=='model.cleanup_unconfirmed' for e in events));self.assertNotIn('PRIVATE',json.dumps(events))
            self.assertEqual(result['model_calls'],1);self.assertTrue(all(p.closed for p in (children[0].stdin,children[0].stdout,children[0].stderr)))

    def test_runtime_cancellation_keeps_the_cleanup_inspection_requirement(self):
        from agent_framework.runtime import Runtime
        from agent_framework.llm import LLMPlanner
        original=subprocess.Popen
        with tempfile.TemporaryDirectory(prefix='cleanup-cancel-',dir='/private/tmp') as directory:
            runtime=Runtime(directory,planner=LLMPlanner(CodexConfig('fixture',timeout=2)));run=runtime.submit()
            def launch(command,**kwargs):
                child=original([sys.executable,'-u','-c','import time;time.sleep(10)'],**kwargs);self.addCleanup(self.reap,child)
                runtime.store.request_cancellation('tenant-demo',run['run_id']);return child
            with patch('agent_framework.llm.subprocess.Popen',launch),patch('agent_framework.model_stream.stop_process_group',side_effect=PermissionError('denied')):
                result=runtime.run(run['run_id'])
            self.assertEqual(result['status'],'CANCELLED');self.assertIn('清理未确认',result['last_error'])
            self.assertFalse(result['cleanup_failure']['confirmed']);self.assertTrue(result['cleanup_failure']['pipes_closed'])
