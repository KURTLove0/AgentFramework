"""Model directory reads have bounded process and concurrency lifetimes."""
from concurrent.futures import ThreadPoolExecutor
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

from agent_framework.model_catalog import ModelCatalog, ModelDiscoveryError
from agent_framework.model_discovery import DirectoryProcess
from agent_framework.processes import finish_process, stop_process_group


MODELS=[{'id':'fixture','name':'Fixture','efforts':[]}]


class DiscoveryConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.catalog=ModelCatalog(self.tmp.name,'catalog-test')

    def test_slow_provider_does_not_block_another_provider(self):
        entered=threading.Event();release=threading.Event();other=threading.Event()
        def slow():
            entered.set()
            if not release.wait(3):raise RuntimeError('test was not released')
            return MODELS
        def fast():other.set();return MODELS
        with ThreadPoolExecutor(max_workers=2) as pool,patch.object(ModelCatalog,'_codex',side_effect=slow),patch.object(ModelCatalog,'_cursor',side_effect=fast):
            first=pool.submit(self.catalog.list,'codex')
            try:
                self.assertTrue(entered.wait(1))
                second=pool.submit(self.catalog.list,'cursor')
                self.assertTrue(other.wait(.5),'unrelated provider blocked by CLI discovery')
                self.assertEqual(second.result(1)['models'],MODELS)
            finally:release.set();first.result(2)

    def test_simultaneous_refreshes_share_one_result_and_independent_copies(self):
        self.shared_refresh()

    def test_simultaneous_failed_refreshes_share_failure_then_allow_retry(self):
        self.shared_refresh(fail=True)

    def shared_refresh(self,fail=False):
        entered=threading.Event();release=threading.Event();joined=threading.Event()
        def slow():
            entered.set()
            if not release.wait(3):raise RuntimeError('test was not released')
            if fail:raise ModelDiscoveryError('目录未返回')
            return MODELS
        with ThreadPoolExecutor(max_workers=2) as pool,patch.object(ModelCatalog,'_codex',side_effect=slow) as discover:
            first=pool.submit(self.catalog.list,'codex',True)
            self.assertTrue(entered.wait(1))
            pending=self.catalog.inflight['codex'];original=pending.result
            def waiting(*args,**kwargs):joined.set();return original(*args,**kwargs)
            try:
                with patch.object(pending,'result',waiting):
                    second=pool.submit(self.catalog.list,'codex',True)
                    self.assertTrue(joined.wait(1));release.set()
                    if fail:
                        for request in (first,second):
                            with self.assertRaisesRegex(ModelDiscoveryError,'目录未返回'):request.result(2)
                        self.assertIsNone(self.catalog.cached('codex'))
                    else:
                        a=first.result(2);b=second.result(2);self.assertEqual(a,b)
                        a['models'][0]['name']='changed';self.assertEqual(b['models'],MODELS)
                self.assertEqual(discover.call_count,1)
            finally:release.set()
        self.assertEqual(self.catalog.inflight,{})
        with patch.object(ModelCatalog,'_codex',return_value=MODELS) as discover:
            self.catalog.list('codex',True);self.assertEqual(discover.call_count,1)

    def test_waiter_timeout_does_not_cancel_owner_or_launch_another_cli(self):
        entered=threading.Event();release=threading.Event()
        def slow():
            entered.set();release.wait(3);return MODELS
        with ThreadPoolExecutor(max_workers=1) as pool,patch.object(ModelCatalog,'_codex',side_effect=slow) as discover:
            first=pool.submit(self.catalog.list,'codex',True)
            try:
                self.assertTrue(entered.wait(1))
                with patch('agent_framework.model_catalog.WAIT_TIMEOUT',.05),self.assertRaisesRegex(ModelDiscoveryError,'仍在读取'):
                    self.catalog.list('codex',True)
                self.assertEqual(discover.call_count,1);self.assertFalse(first.done())
            finally:release.set();first.result(2)
        self.assertEqual(self.catalog.cached('codex')['models'],MODELS)

    def test_fresh_cache_remains_readable_during_explicit_refresh(self):
        with patch.object(ModelCatalog,'_codex',return_value=MODELS):self.catalog.list('codex')
        entered=threading.Event();release=threading.Event();read=threading.Event()
        def slow():
            entered.set()
            if not release.wait(3):raise RuntimeError('test was not released')
            return MODELS
        def cached():
            result=self.catalog.list('codex');read.set();return result
        with ThreadPoolExecutor(max_workers=2) as pool,patch.object(ModelCatalog,'_codex',side_effect=slow):
            first=pool.submit(self.catalog.list,'codex',True)
            try:
                self.assertTrue(entered.wait(1))
                second=pool.submit(cached)
                self.assertTrue(read.wait(.5),'valid cached choices blocked by refresh')
                self.assertTrue(second.result(1)['cached'])
            finally:release.set();first.result(2)


class DiscoveryProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='model-discovery-');self.addCleanup(self.tmp.cleanup)
        self.catalog=ModelCatalog(self.tmp.name,'catalog-test')

    @contextmanager
    def cli(self,script,timeout=2):
        original=subprocess.Popen;children=[];before=set(threading.enumerate())
        def launch(command,**kwargs):
            child=original([sys.executable,'-u','-c',script],**kwargs);children.append(child)
            return child
        try:
            with patch('agent_framework.model_discovery.subprocess.Popen',launch),patch('agent_framework.model_discovery.QUERY_TIMEOUT',timeout):yield children
        finally:
            for child in children:
                try:stop_process_group(child)
                finally:
                    for pipe in (child.stdin,child.stdout,child.stderr):pipe.close()
            self.assertEqual(set(threading.enumerate())-before,set(),'directory query leaked a reader thread')

    def closed(self,children):
        self.assertTrue(children)
        for child in children:
            self.assertIsNotNone(child.poll())
            self.assertTrue(all(p.closed for p in (child.stdin,child.stdout,child.stderr)))

    def test_silent_cli_has_absolute_deadline_for_all_providers(self):
        for provider in ('codex','cursor','qoder'):
            with self.subTest(provider=provider),self.cli('import time;time.sleep(10)',timeout=.15) as children:
                started=time.monotonic()
                with self.assertRaisesRegex(ModelDiscoveryError,'超时'):self.catalog.list(provider,True)
                self.assertLess(time.monotonic()-started,2);self.closed(children)
                self.assertIsNone(self.catalog.cached(provider))

    def test_continuous_rpc_notifications_cannot_extend_deadline(self):
        script="import json,time\nwhile True:\n print(json.dumps({'method':'status','params':{}}),flush=True);time.sleep(.001)"
        with self.cli(script,timeout=.15) as children:
            with self.assertRaisesRegex(ModelDiscoveryError,'超时'):self.catalog.list('codex')
            self.closed(children)

    def test_output_limits_apply_before_newline_or_process_exit(self):
        for provider,fd in (('codex',1),('cursor',1),('qoder',1),('codex',2),('cursor',2)):
            script=f"import os,time\nos.write({fd},b'x'*200000);time.sleep(10)"
            with self.subTest(provider=provider,fd=fd),self.cli(script) as children,patch('agent_framework.model_discovery.OUTPUT_LIMIT',32768):
                with self.assertRaises(ModelDiscoveryError):self.catalog.list(provider,True)
                self.closed(children)
                self.assertIsNone(self.catalog.cached(provider))

    def test_stalled_rpc_input_is_interruptible_without_writer_thread(self):
        with self.cli('import time;time.sleep(10)',timeout=.15) as children:
            with self.assertRaisesRegex(ModelDiscoveryError,'超时'):
                with DirectoryProcess(['fixture']) as session:session.send({'content':'中'*1_000_000})
            self.closed(children)

    def test_output_is_drained_while_rpc_input_waits(self):
        script="import os,sys,json\nos.write(1,b' '*60000+b'\\n');line=sys.stdin.readline();print(json.dumps({'id':1,'result':{'received':len(json.loads(line)['value'])}}),flush=True)"
        with self.cli(script) as children:
            with DirectoryProcess(['fixture']) as session:
                session.send({'value':'输入'*100000})
                # The prelude is deliberately not JSON: drain it before reading the response.
                while '\n' not in session.pending:
                    event=session.receive()
                    if event and event[0]=='stdout' and event[1]:session.pending+=event[1]
                session.pending=session.pending.split('\n',1)[1]
                self.assertEqual(session.response(1)['received'],200000)
            self.closed(children)

    def test_descendant_holding_pipes_is_stopped_after_leader_exit(self):
        marker=Path(self.tmp.name)/'child-ready'
        descendant="import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path("+repr(str(marker))+").write_text('ready');time.sleep(10)"
        script="import subprocess,sys,time;from pathlib import Path\nsubprocess.Popen([sys.executable,'-c',"+repr(descendant)+"])\nwhile not Path("+repr(str(marker))+").exists():time.sleep(.001)\nprint('fixture - Fixture',flush=True)"
        observed=[]
        def finish(process,pipes,error,**kwargs):
            fd=os.dup(process.stdout.fileno());os.set_blocking(fd,False)
            observed.append(fd);self.addCleanup(os.close,fd)
            return finish_process(process,pipes,error,**kwargs)
        with self.cli(script,timeout=.4) as children,patch('agent_framework.model_discovery.finish_process',finish):
            with self.assertRaisesRegex(ModelDiscoveryError,'超时'):self.catalog.list('cursor')
            self.closed(children)
            deadline=time.monotonic()+1
            while True:
                try:
                    if os.read(observed[0],65536)==b'':break
                except BlockingIOError:pass
                if time.monotonic()>deadline:self.fail('directory descendant remained alive')
                time.sleep(.01)

    def test_rpc_invalid_envelopes_never_cache_a_partial_catalog(self):
        for value in ([],{'id':1,'result':None},{'id':1,'error':{'message':'PRIVATE_ERROR'}},{'id':3,'method':'approval/request'}):
            with self.subTest(value=value),self.cli('print('+repr(json.dumps(value))+',flush=True)') as children:
                with self.assertRaises(ModelDiscoveryError) as caught:self.catalog.list('codex',True)
                self.assertNotIn('PRIVATE',str(caught.exception));self.assertIsNone(self.catalog.cached('codex'));self.closed(children)

    def test_partial_unicode_and_crlf_are_preserved(self):
        script="import os,time\ndata='fixture - 中文😀\\r\\n'.encode()\nfor byte in data:os.write(1,bytes([byte]));time.sleep(.001)"
        with self.cli(script) as children:
            self.assertEqual(self.catalog.list('cursor')['models'][0]['name'],'中文😀');self.closed(children)

    def test_invalid_unicode_preserves_previous_cache(self):
        with patch.object(ModelCatalog,'_cursor',return_value=MODELS):self.catalog.list('cursor')
        previous=self.catalog.cached('cursor')
        with self.cli("import os;os.write(1,b'\\xff')") as children:
            with self.assertRaises(ModelDiscoveryError):self.catalog.list('cursor',True)
            self.closed(children)
        self.assertEqual(self.catalog.cached('cursor'),previous)

    def test_nonzero_cli_exit_and_login_error_do_not_publish_models(self):
        for provider in ('cursor','qoder'):
            with self.subTest(provider=provider),self.cli("import sys;print('fixture - Fixture');print('Not logged in. PRIVATE_TOKEN',file=sys.stderr);sys.exit(1)") as children:
                with self.assertRaises(ModelDiscoveryError) as caught:self.catalog.list(provider,True)
                self.assertNotIn('PRIVATE',str(caught.exception));self.assertIsNone(self.catalog.cached(provider));self.closed(children)
                if provider=='qoder':self.assertIn('login',str(caught.exception))

    def test_cleanup_denial_keeps_timeout_and_closes_local_resources(self):
        with self.cli('import time;time.sleep(10)',timeout=.1) as children,patch('agent_framework.model_discovery.stop_process_group',side_effect=PermissionError('PRIVATE')):
            with self.assertRaisesRegex(ModelDiscoveryError,'超时.*清理未确认') as caught:self.catalog.list('codex')
            self.assertFalse(caught.exception.cleanup_failure['confirmed']);self.assertTrue(caught.exception.cleanup_failure['pipes_closed'])
            self.assertNotIn('PRIVATE',str(caught.exception));self.assertIsNone(children[0].poll())
            self.assertIsNone(self.catalog.cached('codex'))

    def test_successful_output_with_unconfirmed_cleanup_does_not_update_cache(self):
        with patch.object(ModelCatalog,'_cursor',return_value=MODELS):self.catalog.list('cursor')
        previous=self.catalog.cached('cursor')
        with self.cli("print('new-model - New Model')") as children,patch('agent_framework.model_discovery.stop_process_group',side_effect=PermissionError('PRIVATE')):
            with self.assertRaisesRegex(ModelDiscoveryError,'清理未确认'):self.catalog.list('cursor',True)
            self.assertTrue(all(p.closed for p in (children[0].stdin,children[0].stdout,children[0].stderr)))
        self.assertEqual(self.catalog.cached('cursor'),previous)

    def test_rpc_pages_share_one_deadline_and_do_not_publish_partial_results(self):
        script="""import json,sys,time
for line in sys.stdin:
 request=json.loads(line)
 if 'id' not in request:continue
 if request['method']=='initialize':result={}
 else:
  time.sleep(.09)
  result={'data':[{'id':'model-'+str(request['id'])}],'nextCursor':'next'}
 print(json.dumps({'id':request['id'],'result':result}),flush=True)
"""
        with self.cli(script,timeout=.22) as children:
            with self.assertRaisesRegex(ModelDiscoveryError,'超时'):self.catalog.list('codex')
            self.closed(children);self.assertIsNone(self.catalog.cached('codex'))

    def test_missing_executable_releases_inflight_for_retry(self):
        with patch('agent_framework.model_discovery.subprocess.Popen',side_effect=FileNotFoundError('PRIVATE_PATH')):
            with self.assertRaises(ModelDiscoveryError) as caught:self.catalog.list('cursor')
            self.assertNotIn('PRIVATE_PATH',str(caught.exception))
        self.assertEqual(self.catalog.inflight,{})
        with self.cli("print('fixture - Fixture')"):
            self.assertEqual(self.catalog.list('cursor')['models'],MODELS)

    def test_builtin_catalog_never_launches_cli(self):
        with patch('agent_framework.model_discovery.subprocess.Popen') as launch:
            self.assertEqual(self.catalog.list('mock',True)['source'],'built-in');launch.assert_not_called()


class DiscoveryHTTPTests(unittest.TestCase):
    def setUp(self):
        import test_http_responsiveness as http_tests
        self.web=http_tests.HTTPResponsivenessTests('runTest');self.web.setUp();self.addCleanup(self.web.tearDown)

    def test_other_provider_configuration_and_tasks_respond_during_query(self):
        entered=threading.Event();release=threading.Event()
        def slow():
            entered.set()
            if not release.wait(4):raise RuntimeError('test was not released')
            return MODELS
        with patch.object(ModelCatalog,'_codex',side_effect=slow),patch.object(ModelCatalog,'_cursor',return_value=MODELS):
            pending=self.web.clients.submit(self.web.request,'/api/runtime-config/models?provider=codex')
            try:
                self.assertTrue(entered.wait(1))
                for path in ('/api/runtime-config/models?provider=cursor','/api/runtime-config','/api/runs'):
                    self.assertEqual(self.web.request(path,timeout=1)[0],200)
                self.assertFalse(pending.done())
            finally:release.set();self.assertEqual(pending.result(2)[0],200)

    def test_failed_refresh_is_explicit_and_preserves_cached_choices(self):
        with patch.object(ModelCatalog,'_cursor',return_value=MODELS):self.web.app.models.list('cursor')
        with patch.object(ModelCatalog,'_cursor',side_effect=ModelDiscoveryError('模型目录读取超时，请检查 CLI 后重试')):
            status,data=self.web.request('/api/runtime-config/models?provider=cursor&refresh=1')
            self.assertEqual(status,400);self.assertIn('超时',data['error'])
            status,data=self.web.request('/api/runtime-config/models?provider=cursor')
            self.assertEqual(status,200);self.assertTrue(data['cached']);self.assertEqual(data['models'],MODELS)
