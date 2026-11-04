"""Immutable workflow receipts and archived write protection."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application
from agent_framework.workflows import Workflows,WorkflowSaveReceiptNotFound
from tests import test_web as web_tests


def payload():
    draft={'id':'draft-agent-helper','name':'资料整理','description':'整理输入资料','prompt':'汇总输入资料中的事实。','source_agent_id':'','source_agent_revision':0}
    node={'id':'node-one','name':'整理','agent_id':draft['id'],'agent_revision':1,'goal':'整理资料','depends_on':[]}
    return {'name':'保存恢复流程','description':'隔离测试','nodes':[node],'agent_drafts':[draft],'revision':0,'request_id':'save-original'}


class WorkflowSaveRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.flows=self.app.workflows()

    def test_receipt_survives_restart_and_is_original_after_edit_and_archive(self):
        first=self.flows.save(payload())
        edited=self.flows.save({k:deepcopy(first[k]) for k in ('name','description','nodes','revision')}|{'name':'另一窗口修改','request_id':'save-edited'},first['id'])
        archived=self.flows.archive(first['id'],edited['revision'],True)
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(restarted.workflows().save_request('save-original'),{'request_id':'save-original','saved':first})
        self.assertEqual(restarted.workflows().get(first['id']),archived)
        self.assertEqual(self.flows.save(payload()),first)
        self.assertEqual(len(self.app.agents.list()),1)

    def test_receipts_are_private_to_principal_workspace_and_tenant(self):
        self.flows.save(payload())
        other=Application(self.tmp.name,principal='other');self.addCleanup(other.close)
        tenant=Application(self.tmp.name,tenant='another');self.addCleanup(tenant.close)
        space=self.app.workspaces.save({'name':'另一个空间','description':'','business':'测试','scenario':'流程','revision':0})
        for app in (other,tenant,self.app.scoped(space['id'])):
            with self.subTest(scope=app.workflows().scope),self.assertRaises(WorkflowSaveReceiptNotFound):app.workflows().save_request('save-original')
        self.assertEqual(len(self.flows.list()),1)

    def test_missing_receipt_read_never_creates_records(self):
        for _ in range(2):
            with self.assertRaises(WorkflowSaveReceiptNotFound):self.flows.save_request('not-yet-committed')
        self.assertEqual(self.flows.list(),[]);self.assertEqual(self.app.agents.list(),[])

    def test_same_key_cannot_change_payload_or_workflow(self):
        first=self.flows.save(payload())
        with self.assertRaises(ConfigConflict):self.flows.save(payload()|{'name':'已变更'})
        with self.assertRaises(ConfigConflict):self.flows.save(payload(),first['id'])
        self.assertEqual(self.flows.save_request('save-original')['saved'],first)

    def test_archived_current_revision_rejects_edit_and_new_inline_agents(self):
        first=self.flows.save(payload());archived=self.flows.archive(first['id'],1,True)
        with self.assertRaisesRegex(ConfigConflict,'归档'):
            self.flows.save(payload()|{'revision':archived['revision'],'request_id':'edit-archived'},first['id'])
        self.assertEqual(self.flows.get(first['id']),archived);self.assertEqual(len(self.app.agents.list()),1)
        with self.assertRaises(WorkflowSaveReceiptNotFound):self.flows.save_request('edit-archived')

    def test_archived_guard_runs_inside_transaction_after_validation(self):
        first=self.flows.save(payload());validate=self.flows.validate
        def archive_during_validation(*args,**kwargs):
            result=validate(*args,**kwargs)
            self.flows.archive(first['id'],1,True)
            return result
        with patch.object(self.flows,'validate',side_effect=archive_during_validation),self.assertRaises(ConfigConflict):
            self.flows.save(payload()|{'revision':1,'request_id':'racing-edit'},first['id'])
        self.assertEqual(self.flows.get(first['id'])['revision'],2);self.assertEqual(len(self.app.agents.list()),1)

    def test_restored_flow_can_save_and_reuses_existing_agent(self):
        first=self.flows.save(payload());self.flows.archive(first['id'],1,True);restored=self.flows.archive(first['id'],2,False)
        data={k:deepcopy(restored[k]) for k in ('name','description','nodes','revision')}
        saved=self.flows.save(data|{'request_id':'after-restore'},first['id'])
        self.assertEqual(saved['revision'],4);self.assertEqual(len(self.app.agents.list()),1)

    def test_concurrent_retry_creates_one_flow_and_one_agent(self):
        other=Application(self.tmp.name);self.addCleanup(other.close);other_flows=other.workflows();barrier=threading.Barrier(2);validate=Workflows.validate
        def simultaneous(flows,*args,**kwargs):
            value=validate(flows,*args,**kwargs);barrier.wait(10);return value
        with patch.object(Workflows,'validate',simultaneous),ThreadPoolExecutor(max_workers=2) as pool:
            replies=[f.result(15) for f in [pool.submit(flows.save,payload()) for flows in (self.flows,other_flows)]]
        self.assertEqual(replies[0],replies[1]);self.assertEqual(len(self.flows.list()),1);self.assertEqual(len(self.app.agents.list()),1)


class WorkflowSaveHTTPTests(unittest.TestCase):
    setUp=web_tests.HTTPTests.setUp
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_lookup_is_read_only_and_has_an_explicit_missing_code(self):
        status,_,body=self.request('/api/workflow-saves/save-original')
        self.assertEqual(status,404);self.assertEqual(json.loads(body)['code'],'workflow_save_not_found')
        status,_,body=self.request('/api/workflows','POST',json.dumps(payload()))
        self.assertEqual(status,201);saved=json.loads(body)
        status,_,body=self.request('/api/workflow-saves/save-original')
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['saved'],saved)
        self.assertEqual(len(self.app.agents.list()),1);self.assertEqual(len(self.app.workflows().list()),1)

    def test_receipt_workspace_header_and_static_script(self):
        self.app.workflows().save(payload())
        space=self.app.workspaces.save({'name':'其他空间','description':'','business':'测试','scenario':'流程','revision':0})
        status,_,body=self.request('/api/workflow-saves/save-original',headers={'X-Agent-Workspace':space['id']})
        self.assertEqual(status,404);self.assertEqual(json.loads(body)['code'],'workflow_save_not_found')
        status,headers,body=self.request('/workflow_save.js');self.assertEqual(status,200);self.assertIn('text/javascript',headers['Content-Type']);self.assertIn(b'flowSaveBegin',body)
        status,headers,body=self.request('/workflow_draft.js');self.assertEqual(status,200);self.assertIn('text/javascript',headers['Content-Type']);self.assertIn(b'persistFlowDraft',body)

    def test_archived_write_returns_conflict_without_a_receipt(self):
        saved=self.app.workflows().save(payload());self.app.workflows().archive(saved['id'],1,True)
        status,_,_=self.request('/api/workflows/'+saved['id'],'POST',json.dumps(payload()|{'revision':2,'request_id':'archived-edit'}))
        self.assertEqual(status,409)
        status,_,body=self.request('/api/workflow-saves/archived-edit');self.assertEqual(status,404);self.assertEqual(json.loads(body)['code'],'workflow_save_not_found')
