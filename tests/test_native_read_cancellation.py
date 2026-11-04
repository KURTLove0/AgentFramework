"""Durable stop intent fences native reads, independent of model process exit."""
import unittest
import tempfile
import json
import subprocess
import threading
from unittest.mock import patch

from agent_framework.contracts import PolicyDenied,TaskContract,TOOLS
from agent_framework.definitions import default_definition
from agent_framework.read_proxy import NativeReadCancelled,ReadCapabilityProxy
from agent_framework.runtime import Runtime


class NativeReadCancellationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='native-stop-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.runtime=Runtime(self.tmp.name,lease_seconds=10,tool_timeout=.2)
        definition=default_definition('读取助手');definition['native_read_refs']=list(TOOLS[:2])
        profile={'id':'agent-0123456789abcdef','revision':1,'name':'读取助手','description':'隔离读取验收',
            'runtime':'mock','model':'builtin','options':{},'prompt':'核对当前事实。','skills':[],'mcp_servers':[],'definition':definition}
        self.state=self.runtime.submit(TaskContract(agent_ref=profile['id']+'@1'),agent_profile=profile)
        self.lease=self.runtime.store.acquire('tenant-demo',self.state['run_id'],10)
        self.addCleanup(self.runtime.store.release,self.state,self.lease)
        self.proxy=ReadCapabilityProxy(self.tmp.name)

    def stop(self):
        return self.runtime.store.request_cancellation('tenant-demo',self.state['run_id'],source='test')

    def call(self,token):
        return self.proxy.call(token,'change_read',{'project_id':'project-demo','change_id':'change-demo-001'})

    def records(self):
        return self.runtime.store.result('tenant-demo',self.state['run_id'])['native_reads']

    def test_durable_stop_blocks_new_read_before_budget_reservation(self):
        with self.proxy.session(self.state,self.lease) as config:
            token=config['mcp_servers'][0]['args'][-1];self.stop()
            with self.assertRaises(PolicyDenied):self.call(token)
        self.assertEqual(self.records(),[]);self.assertEqual(self.runtime.store.evidence(self.state),{})
        self.assertEqual(self.runtime.external.stats('tenant-demo',self.state['run_id'])['calls'],{})

    def test_stop_during_preparation_blocks_dispatch(self):
        original=self.proxy.gateway.authorize
        def authorize(*args):
            result=original(*args);self.stop();return result
        with self.proxy.session(self.state,self.lease) as config,patch.object(self.proxy.gateway,'authorize',authorize):
            with self.assertRaises(PolicyDenied):self.call(config['mcp_servers'][0]['args'][-1])
        self.assertEqual(self.records()[0]['status'],'REJECTED');self.assertEqual(self.runtime.store.evidence(self.state),{})
        self.assertEqual(self.records()[0]['reason'],'NativeReadCancelled')
        self.assertEqual(self.runtime.external.stats('tenant-demo',self.state['run_id'])['calls'],{})

    def test_stop_during_read_prevents_result_delivery_and_trusted_evidence(self):
        original=self.proxy.gateway.invoke
        def invoke(*args):
            result=original(*args);self.stop();return result
        with self.proxy.session(self.state,self.lease) as config,patch.object(self.proxy.gateway,'invoke',invoke):
            with self.assertRaises(PolicyDenied):self.call(config['mcp_servers'][0]['args'][-1])
        self.assertEqual(self.records()[0]['status'],'REJECTED');self.assertEqual(self.runtime.store.evidence(self.state),{})
        self.assertEqual(self.records()[0]['reason'],'NativeReadCancelled')
        self.assertEqual(self.runtime.external.stats('tenant-demo',self.state['run_id'])['calls'],{TOOLS[0]:1})

    def test_failed_stop_cleanup_does_not_reenable_tools_or_reads(self):
        with self.proxy.session(self.state,self.lease) as config:
            token=config['mcp_servers'][0]['args'][-1];request=self.stop()
            self.runtime.store.fail_cancellation('tenant-demo',self.state['run_id'],request['generation'],'cleanup unavailable')
            with self.assertRaises(NativeReadCancelled):self.proxy.tools(token)
            with self.assertRaises(NativeReadCancelled):self.call(token)
        self.assertEqual(self.records(),[])

    def test_stop_in_another_run_does_not_block_this_session(self):
        other=self.runtime.submit();self.runtime.store.request_cancellation('tenant-demo',other['run_id'],source='test')
        with self.proxy.session(self.state,self.lease) as config:
            result=self.call(config['mcp_servers'][0]['args'][-1])
        self.assertIn(result['evidence_ref'],self.runtime.store.evidence(self.state))
        self.assertEqual(self.records()[0]['status'],'VERIFIED')

    def test_stop_preserves_previous_verified_evidence_and_denies_later_reads(self):
        with self.proxy.session(self.state,self.lease) as config:
            token=config['mcp_servers'][0]['args'][-1];result=self.call(token)
            before=self.runtime.store.evidence(self.state);self.stop()
            with self.assertRaises(NativeReadCancelled):self.call(token)
        self.assertEqual(self.runtime.store.evidence(self.state),before);self.assertIn(result['evidence_ref'],before)
        self.assertEqual(len(self.records()),1);self.assertEqual(self.records()[0]['status'],'VERIFIED')

    def test_separate_proxy_process_observes_saved_stop_without_parent_signal(self):
        with self.proxy.session(self.state,self.lease) as config:
            server=config['mcp_servers'][0];self.stop()
            requests=[{'jsonrpc':'2.0','id':1,'method':'tools/list'},
                {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'change_read','arguments':{'project_id':'project-demo','change_id':'change-demo-001'}}}]
            child=subprocess.run([server['command'],*server['args']],input=''.join(json.dumps(r)+'\n' for r in requests),text=True,capture_output=True,timeout=5,check=True)
            responses=[json.loads(line) for line in child.stdout.splitlines()]
            self.assertEqual(len(responses),2);self.assertTrue(all('error' in r and 'NativeReadCancelled' in r['error']['message'] for r in responses))
        self.assertEqual(self.records(),[]);self.assertEqual(self.runtime.external.stats('tenant-demo',self.state['run_id'])['calls'],{})

    def test_pending_adapter_read_does_not_hold_up_stop_and_late_result_is_rejected(self):
        entered=threading.Event();release=threading.Event();completed=[];errors=[];original=self.proxy.gateway.invoke
        def invoke(*args):
            result=original(*args);entered.set()
            if not release.wait(5):raise RuntimeError('test read barrier timed out')
            return result
        def run(token):
            try:completed.append(self.call(token))
            except Exception as exc:errors.append(exc)
        with self.proxy.session(self.state,self.lease) as config,patch.object(self.proxy.gateway,'invoke',invoke):
            thread=threading.Thread(target=run,args=(config['mcp_servers'][0]['args'][-1],));thread.start()
            try:
                self.assertTrue(entered.wait(3));request=self.stop();self.assertTrue(request['pending']);self.assertTrue(thread.is_alive())
            finally:release.set();thread.join(5)
            self.assertFalse(thread.is_alive());self.assertEqual(completed,[]);self.assertEqual(len(errors),1);self.assertIsInstance(errors[0],NativeReadCancelled)
        self.assertEqual(self.runtime.store.evidence(self.state),{});self.assertEqual(self.records()[0]['reason'],'NativeReadCancelled')


if __name__=='__main__':unittest.main()
