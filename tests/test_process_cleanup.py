"""Owned process groups are reaped without replacing model failures."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import LeaseLost
from agent_framework.llm import CodexConfig,CodexTransport,ModelError
from agent_framework.model_execution import SCHEMA
from agent_framework.processes import stop_process_group


class ProcessCleanupTests(unittest.TestCase):
    def process(self,script):
        child=subprocess.Popen([sys.executable,'-u','-c',script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.addCleanup(self.cleanup,child);return child

    def cleanup(self,child):
        stop_process_group(child)
        for pipe in (child.stdin,child.stdout,child.stderr):
            try:pipe.close()
            except OSError:pass

    def test_exited_unreaped_leader_is_cleaned_up(self):
        child=self.process('import os;os._exit(23)')
        self.assertEqual(child.stdout.read(),'');self.assertIsNone(child.returncode)
        stop_process_group(child)
        self.assertEqual(child.returncode,23)

    def rpc(self,script,cancel=None,already_exited=False):
        original=subprocess.Popen;children=[]
        def launch(command,**kwargs):
            child=original([sys.executable,'-u','-c',script],**kwargs);children.append(child);self.addCleanup(self.cleanup,child)
            if already_exited:self.assertEqual(child.stdout.read(),'');self.assertIsNone(child.returncode)
            return child
        transport=CodexTransport();transport.stream_output=True;transport.should_cancel=cancel
        try:
            with patch('agent_framework.codex_stream.subprocess.Popen',launch):
                return transport.generate('A bounded task',SCHEMA,CodexConfig('fixture',timeout=1),1)
        finally:self.children=children

    def test_exited_rpc_does_not_replace_the_original_lease_error(self):
        failure=LeaseLost('replacement owns the task')
        def cancel():raise failure
        with self.assertRaises(LeaseLost) as caught:self.rpc('import os;os._exit(23)',cancel,already_exited=True)
        self.assertIs(caught.exception,failure)
        self.assertTrue(all(pipe.closed for pipe in (self.children[0].stdin,self.children[0].stdout,self.children[0].stderr)))
        self.assertEqual(self.children[0].returncode,23)

    def test_early_rpc_exit_remains_a_model_error_and_closes_pipes(self):
        with self.assertRaises(ModelError):self.rpc('import sys,os;sys.stdin.readline();os._exit(23)')
        self.assertTrue(all(pipe.closed for pipe in (self.children[0].stdin,self.children[0].stdout,self.children[0].stderr)))
        self.assertEqual(self.children[0].returncode,23)

    def test_reaped_leader_still_has_its_stubborn_descendant_stopped(self):
        with tempfile.TemporaryDirectory(prefix='group-descendant-',dir='/private/tmp') as tmp:
            ready=Path(tmp)/'ready'
            descendant="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path("+repr(str(ready))+").write_text('ready');time.sleep(5)"
            script="import os,subprocess,sys,time;from pathlib import Path\nchild=subprocess.Popen([sys.executable,'-c',"+repr(descendant)+"])\nwhile not Path("+repr(str(ready))+").exists():time.sleep(.01)\nprint(child.pid,flush=True);os._exit(0)"
            child=self.process(script);self.assertTrue(child.stdout.readline().strip().isdigit());child.wait(timeout=2)
            started=time.monotonic();stop_process_group(child)
            self.assertEqual(child.stdout.read(),'');self.assertLess(time.monotonic()-started,1.5)

    def test_exit_between_poll_and_signal_is_reaped_then_retried(self):
        child=self.process('import time;time.sleep(.08)');original=os.killpg;attempted=[]
        def send(pid,sig):
            if not attempted:
                attempted.append(sig);child.wait(timeout=2)
                raise PermissionError('exit raced with signaling')
            return original(pid,sig)
        with patch('agent_framework.processes.os.killpg',send):stop_process_group(child)
        self.assertEqual(child.returncode,0);self.assertTrue(attempted)

    def test_denied_live_group_is_not_reported_as_cleaned_up(self):
        child=self.process('import time;time.sleep(5)')
        with patch('agent_framework.processes.os.killpg',side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):stop_process_group(child)
        self.assertIsNone(child.poll())

    def test_denied_group_after_leader_exit_remains_an_error(self):
        child=self.process('pass');child.wait(timeout=2)
        with patch('agent_framework.processes.os.killpg',side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):stop_process_group(child)

    def test_repeated_cleanup_after_exit_is_safe(self):
        child=self.process('pass');child.wait(timeout=2)
        stop_process_group(child);stop_process_group(child)
        self.assertEqual(child.returncode,0)


if __name__=='__main__':unittest.main()
