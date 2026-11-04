"""Read-only lookup of an accepted workflow start, scoped to its submitter."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application
from agent_framework.workflows import Workflows,WorkflowStartReceiptNotFound
from tests.test_workflows import role,definition
from tests import test_web as web_tests


class WorkflowStartRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=role(self.app);self.flows=self.app.workflows();self.workflow=self.flows.save(definition([self.agent]))
        self.data={'revision':1,'request_id':'start-original','grant':False,'consent':False,'mcp_consent':False,'change_id':'change-original'}

    def test_lookup_after_restart_recovers_the_original_identity_and_frozen_definition(self):
        started=self.flows.start(self.workflow['id'],self.data);other=Application(self.tmp.name);self.addCleanup(other.close)
        self.assertEqual(other.workflows().start_request('start-original')['id'],started['id'])
        self.assertEqual(other.workflows().start_request('start-original')['snapshot'],started['snapshot'])

    def test_lookup_and_retry_work_after_the_definition_is_updated_and_archived(self):
        run=self.flows.start(self.workflow['id'],self.data)
        edited=self.flows.save(definition([self.agent])|{'name':'后来修改','revision':1},self.workflow['id']);self.flows.archive(edited['id'],2,True)
        found=self.flows.start_request('start-original');self.assertEqual(found['snapshot']['revision'],1);self.assertEqual(found['id'],run['id'])
        self.assertEqual(self.flows.start(self.workflow['id'],self.data)['id'],run['id']);self.assertEqual(len(self.flows.runs()),1)

    def test_missing_lookup_does_not_create_a_run_dispatch_or_event(self):
        with self.assertRaises(WorkflowStartReceiptNotFound):self.flows.start_request('not-accepted')
        with self.flows.store.connect() as db:
            for table in ('workflow_runs','workflow_dispatches','workflow_events'):self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)

    def test_lookup_is_private_to_principal_tenant_and_workspace(self):
        self.flows.start(self.workflow['id'],self.data)
        other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close)
        tenant=Application(self.tmp.name,tenant='other-tenant');self.addCleanup(tenant.close)
        space=self.app.workspaces.save({'name':'另一个空间','description':'','business':'测试','scenario':'启动','revision':0})
        for app in (other,tenant,self.app.scoped(space['id'])):
            with self.subTest(scope=app.workflows().scope),self.assertRaises(WorkflowStartReceiptNotFound):app.workflows().start_request('start-original')

    def test_lookup_preserves_dispatch_errors_and_does_not_enqueue_a_retry(self):
        run=self.flows.start(self.workflow['id'],self.data);request=self.flows.dispatch_request(run['id']);self.flows.dispatch_error(run['id'],request['generation'],'fixture queue failure')
        before=self.flows.dispatch_request(run['id']);events=self.flows.events(run['id'])
        for _ in range(2):self.assertEqual(self.flows.start_request('start-original')['id'],run['id'])
        self.assertEqual(self.flows.dispatch_request(run['id']),before);self.assertEqual(self.flows.events(run['id']),events)

    def test_lookup_returns_cancellation_and_terminal_state_without_clearing_it(self):
        run=self.flows.start(self.workflow['id'],self.data);self.flows.cancel(run['id']);self.assertTrue(self.flows.start_request('start-original')['cancel_requested'])
        self.flows.execute(run['id']);found=self.flows.start_request('start-original');self.assertEqual(found['status'],'CANCELLED')
        self.assertEqual(self.flows.start(self.workflow['id'],self.data)['status'],'CANCELLED');self.assertEqual(len(self.flows.runs()),1)

    def test_parameter_or_workflow_changes_cannot_reuse_an_accepted_key(self):
        run=self.flows.start(self.workflow['id'],self.data);other=self.flows.save(definition([self.agent]))
        for identity,data in [(self.workflow['id'],self.data|{'change_id':'another'}),(self.workflow['id'],self.data|{'consent':True}),(other['id'],self.data)]:
            with self.assertRaises(ConfigConflict):self.flows.start(identity,data)
        self.assertEqual(self.flows.start_request('start-original')['id'],run['id'])

    def test_concurrent_duplicate_starts_share_one_run_and_dispatch_generation(self):
        other=Application(self.tmp.name);self.addCleanup(other.close);other_flows=other.workflows();barrier=threading.Barrier(2);validate=Workflows.validate
        def together(flows,*args,**kwargs):
            result=validate(flows,*args,**kwargs);barrier.wait(10);return result
        with patch.object(Workflows,'validate',together),ThreadPoolExecutor(max_workers=2) as pool:
            results=[f.result(15) for f in [pool.submit(flows.start,self.workflow['id'],deepcopy(self.data)) for flows in (self.flows,other_flows)]]
        self.assertEqual(results[0]['id'],results[1]['id']);self.assertEqual(len(self.flows.runs()),1);self.assertEqual(self.flows.dispatch_request(results[0]['id'])['generation'],1)

    def test_corrupt_snapshot_is_not_misreported_as_a_missing_request(self):
        run=self.flows.start(self.workflow['id'],self.data)
        with self.flows.store.connect() as db:
            raw=json.loads(db.execute('SELECT data FROM workflow_runs WHERE id=?',(run['id'],)).fetchone()[0]);raw['snapshot']['revision']=99;db.execute('UPDATE workflow_runs SET data=? WHERE id=?',(json.dumps(raw),run['id']))
        with self.assertRaisesRegex(ValueError,'摘要'):self.flows.start_request('start-original')

    def test_missing_stored_fields_do_not_claim_no_run_was_committed(self):
        run=self.flows.start(self.workflow['id'],self.data)
        with self.flows.store.connect() as db:
            raw=json.loads(db.execute('SELECT data FROM workflow_runs WHERE id=?',(run['id'],)).fetchone()[0]);del raw['snapshot'];db.execute('UPDATE workflow_runs SET data=? WHERE id=?',(json.dumps(raw),run['id']))
        for action in (lambda:self.flows.start_request('start-original'),lambda:self.flows.start(self.workflow['id'],self.data)):
            with self.assertRaises(KeyError) as caught:action()
            self.assertNotIsInstance(caught.exception,WorkflowStartReceiptNotFound)
        with self.flows.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM workflow_runs').fetchone()[0],1)


class WorkflowStartHTTPTests(unittest.TestCase):
    def setUp(self):
        # This suite checks that GET leaves a queued receipt untouched. Keep
        # the independent recovery worker from advancing it during the read.
        recovery=patch.object(Workflows,'tick',return_value=None)
        recovery.start();self.addCleanup(recovery.stop)
        web_tests.HTTPTests.setUp(self)
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_missing_code_static_script_and_scoped_read_only_result(self):
        status,_,body=self.request('/api/workflow-starts/start-test');self.assertEqual(status,404);self.assertEqual(json.loads(body)['code'],'workflow_start_not_found')
        agent=role(self.app);workflow=self.app.workflows().save(definition([agent]));run=self.app.workflows().start(workflow['id'],{'revision':1,'request_id':'start-test','grant':False})
        before=self.app.workflows().events(run['id']);status,_,body=self.request('/api/workflow-starts/start-test');self.assertEqual(status,200);packet=json.loads(body)
        self.assertEqual(packet['request_id'],'start-test');self.assertEqual(packet['run']['id'],run['id']);self.assertEqual(packet['queue']['state'],'QUEUED');self.assertEqual(before,self.app.workflows().events(run['id']))
        space=self.app.workspaces.save({'name':'其他空间','description':'','business':'测试','scenario':'启动','revision':0});status,_,body=self.request('/api/workflow-starts/start-test',headers={'X-Agent-Workspace':space['id']});self.assertEqual(status,404);self.assertEqual(json.loads(body)['code'],'workflow_start_not_found')
        status,headers,body=self.request('/workflow_start.js');self.assertEqual(status,200);self.assertIn('text/javascript',headers['Content-Type']);self.assertIn(b'reviewFlowStart',body)

    def test_lookup_never_calls_enqueue_or_execute(self):
        workflow=self.app.workflows().save(definition([role(self.app)]));self.app.workflows().start(workflow['id'],{'revision':1,'request_id':'start-readonly'})
        with patch.object(Application,'enqueue_flow',side_effect=AssertionError('read dispatched a run')),patch.object(Workflows,'execute',side_effect=AssertionError('read executed a run')):
            for _ in range(2):self.assertEqual(self.request('/api/workflow-starts/start-readonly')[0],200)
