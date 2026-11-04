"""CLI installation probes stay bounded and never run a model prompt."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import RuntimeConfiguration
from agent_framework.processes import finish_process,stop_process_group


class RuntimeDetectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='runtime-detect-');self.addCleanup(self.tmp.cleanup)
        self.config=RuntimeConfiguration(self.tmp.name,'detection-test')

    @contextmanager
    def cli(self,script,timeout=2):
        original=subprocess.Popen;children=[];before=set(threading.enumerate())
        def launch(command,**kwargs):
            self.assertIn(command[0],('codex','cursor-agent','qodercli','qoder'));self.assertEqual(command[1:],['--version'])
            self.assertTrue(kwargs['start_new_session']);self.assertNotIn('shell',kwargs)
            child=original([sys.executable,'-u','-c',script],**kwargs);children.append(child);return child
        try:
            with patch('agent_framework.runtime_config.shutil.which',return_value='/fixture/cli'),patch('agent_framework.runtime_detection.subprocess.Popen',launch),patch('agent_framework.runtime_detection.DETECTION_TIMEOUT',timeout):yield children
        finally:
            for child in children:
                try:stop_process_group(child)
                finally:
                    for pipe in (child.stdin,child.stdout,child.stderr):pipe.close()
            self.assertEqual(set(threading.enumerate())-before,set(),'probe leaked a thread')

    def closed(self,children):
        self.assertTrue(children)
        for child in children:
            self.assertIsNotNone(child.poll());self.assertTrue(all(p.closed for p in (child.stdin,child.stdout,child.stderr)))

    def test_all_provider_commands_close_stdin_without_prompt_and_return_first_line(self):
        for provider in ('codex','cursor','qoder'):
            with self.subTest(provider=provider),self.cli("import sys;assert sys.stdin.read()=='';print('Fixture 中文 1.0');print('extra');print('PRIVATE_STDERR',file=sys.stderr)") as children:
                result=self.config.detect(provider);self.assertTrue(result['ok']);self.assertEqual(result['version'],'Fixture 中文 1.0');self.assertNotIn('PRIVATE',json.dumps(result));self.closed(children)

    def test_mock_missing_command_and_invalid_provider_never_start_a_process(self):
        with patch('agent_framework.runtime_detection.subprocess.Popen') as launch,patch('agent_framework.runtime_config.shutil.which',return_value=None):
            self.assertTrue(self.config.detect('mock')['ok']);self.assertFalse(self.config.detect('codex')['installed'])
            with self.assertRaises(ValueError):self.config.detect('custom-shell')
            launch.assert_not_called()

    def test_silent_and_continuously_writing_probes_cannot_extend_deadline(self):
        for script in ('import time;time.sleep(10)',"import time\nwhile True: print('still checking',flush=True);time.sleep(.005)"):
            with self.subTest(script=script),self.cli(script,timeout=.15) as children:
                start=time.monotonic();result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertIn('超时',result['message']);self.assertLess(time.monotonic()-start,2);self.closed(children)

    def test_closed_output_does_not_hide_a_live_process(self):
        with self.cli('import os,time;os.close(1);os.close(2);time.sleep(10)',timeout=.15) as children:
            result=self.config.detect('cursor');self.assertFalse(result['ok']);self.assertIn('超时',result['message']);self.closed(children)

    def test_stdout_stderr_and_combined_outputs_are_bounded(self):
        for script in ("import os,time;os.write(1,b'x'*200000);time.sleep(10)","import os,time;os.write(2,b'x'*200000);time.sleep(10)","import os;os.write(1,b'x'*20000);os.write(2,b'y'*20000)"):
            with self.subTest(script=script),self.cli(script) as children,patch('agent_framework.runtime_detection.OUTPUT_LIMIT',32768):
                result=self.config.detect('cursor');self.assertFalse(result['ok']);self.assertIn('过大',result['message']);self.closed(children)

    def test_invalid_unicode_is_a_safe_failure(self):
        with self.cli("import os;os.write(1,b'\\xff')") as children:
            result=self.config.detect('qoder');self.assertFalse(result['ok']);self.assertIn('输出无效',result['message']);self.closed(children)

    def test_split_unicode_and_crlf_are_decoded_and_long_version_is_limited(self):
        with self.cli("import os,time\nfor byte in '版本😀 1.0\\r\\n'.encode():os.write(1,bytes([byte]));time.sleep(.001)") as children:
            self.assertEqual(self.config.detect('codex')['version'],'版本😀 1.0');self.closed(children)
        with self.cli("print('x'*1000)") as children:
            self.assertEqual(len(self.config.detect('codex')['version']),160);self.closed(children)

    def test_nonzero_exit_never_exposes_failure_stdout_or_stderr_and_retry_works(self):
        with self.cli("import sys;print('PRIVATE_OUTPUT');print('PRIVATE_STDERR',file=sys.stderr);sys.exit(1)") as children:
            result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertIsNone(result['version']);self.assertNotIn('PRIVATE',json.dumps(result));self.closed(children)
        with self.cli("print('Fixed 2.0')") as children:
            self.assertTrue(self.config.detect('codex')['ok']);self.closed(children)

    def test_descendant_holding_pipes_is_stopped_after_leader_exit(self):
        marker=Path(self.tmp.name)/'ready';child="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path("+repr(str(marker))+").write_text('ready');time.sleep(10)"
        script="import subprocess,sys,time;from pathlib import Path\nsubprocess.Popen([sys.executable,'-c',"+repr(child)+"])\nwhile not Path("+repr(str(marker))+").exists():time.sleep(.001)\nprint('Fixture 1.0',flush=True)"
        observed=[]
        def finish(process,pipes,error,**kwargs):
            fd=os.dup(process.stdout.fileno());os.set_blocking(fd,False);observed.append(fd);self.addCleanup(os.close,fd);return finish_process(process,pipes,error,**kwargs)
        with self.cli(script,timeout=.4) as children,patch('agent_framework.runtime_detection.finish_process',finish):
            result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertIn('超时',result['message']);self.closed(children)
            deadline=time.monotonic()+1
            while True:
                try:
                    if os.read(observed[0],65536)==b'':break
                except BlockingIOError:pass
                if time.monotonic()>deadline:self.fail('descendant kept the output pipe open')
                time.sleep(.01)

    def test_cleanup_failure_does_not_claim_success_or_hide_original_timeout(self):
        for script,timeout in (("print('Fixture 1.0')",2),('import time;time.sleep(10)',.1)):
            with self.subTest(timeout=timeout),self.cli(script,timeout) as children,patch('agent_framework.runtime_detection.stop_process_group',side_effect=PermissionError('PRIVATE_PATH')):
                result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertIn('清理未确认',result['message']);self.assertNotIn('PRIVATE',json.dumps(result));self.assertTrue(all(p.closed for p in (children[0].stdin,children[0].stdout,children[0].stderr)))
                if timeout==.1:self.assertIn('超时',result['message'])

    def test_start_or_pipe_initialization_failure_is_safe_and_releases_owned_resources(self):
        with patch('agent_framework.runtime_config.shutil.which',return_value='/fixture/cli'),patch('agent_framework.runtime_detection.subprocess.Popen',side_effect=FileNotFoundError('PRIVATE_PATH')):
            result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertNotIn('PRIVATE',json.dumps(result))
        with self.cli('import time;time.sleep(10)') as children,patch('agent_framework.runtime_detection.ProcessPipes',side_effect=OSError('PRIVATE_PATH')):
            result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertNotIn('PRIVATE',json.dumps(result));self.closed(children)

    def test_callers_unrelated_handled_exception_cannot_hide_cleanup_failure(self):
        with self.cli("print('Fixture 1.0')"),patch('agent_framework.runtime_detection.stop_process_group',side_effect=PermissionError('PRIVATE_PATH')):
            try:raise ValueError('unrelated caller failure')
            except ValueError as original:
                result=self.config.detect('codex');self.assertFalse(result['ok']);self.assertIn('清理未确认',result['message'])
                self.assertFalse(hasattr(original,'cleanup_failure'))


if __name__=='__main__':unittest.main()
