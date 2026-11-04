"""The conversation reuse entry keeps independent execution and source lineage."""
from copy import deepcopy
import unittest

from agent_framework.contracts import PolicyDenied
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests import test_simple_tasks as task_fixtures
from tests import test_web as web_fixtures


class TaskReuseTests(unittest.TestCase):
    agent=task_fixtures.SimpleTaskTests.agent
    payload=task_fixtures.SimpleTaskTests.payload

    def setUp(self):
        task_fixtures.SimpleTaskTests.setUp(self)
        self.profile=self.agent();self.original=self.app.start_task(self.payload(self.profile),start=False)['run']['run_id']
        self.app.runtime().run(self.original)

    def copy(self,**overrides):
        return self.app.start_task(self.payload(self.profile,source_run_id=self.original,request_id='copy-request',clear_draft=False,**overrides),start=False)

    def test_new_task_uses_current_config_and_empty_history_without_mutating_source(self):
        store=self.app.control_store;before=store.result(self.app.tenant,self.original);events=store.events(self.app.tenant,self.original)
        fields={k:deepcopy(self.profile[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')};fields.update(revision=self.profile['revision'],prompt='新的工作方式')
        self.profile=self.app.agents.save(fields,self.profile['id']);result=self.copy();run=result['run']
        self.assertNotEqual(run['run_id'],self.original);self.assertEqual(run['task']['source_run_id'],self.original)
        self.assertEqual(run['snapshot']['agent_profile']['revision'],2);self.assertEqual(run['snapshot']['agent_profile']['prompt'],'新的工作方式')
        self.assertEqual(run['task']['conversation_context']['messages'],[]);self.assertEqual(run['task']['conversation_context']['task_id'],run['run_id'])
        self.assertEqual(run['status'],'CREATED');self.assertIsNone(run['report']);self.assertEqual(run['scenario'],'normal');self.assertIsNone(store.get_grant(run))
        self.assertEqual(len(TaskConversations(self.app).view(run['run_id'])['turns']),1)
        self.assertEqual(store.result(self.app.tenant,self.original),before);self.assertEqual(store.events(self.app.tenant,self.original),events)

    def test_reuse_preserves_an_existing_unrelated_settings_draft(self):
        saved=self.app.save_task_draft({'revision':0,'draft':{'goal':'未提交的重要目标','agent_id':self.profile['id']}})
        result=self.copy();self.assertEqual(result['task_draft'],saved);self.assertEqual(self.app.task_draft(),saved)
        self.assertNotEqual(result['run']['task']['goal'],saved['draft']['goal'])

    def test_repeated_submission_returns_the_same_new_task(self):
        first=self.copy();second=self.copy()
        self.assertEqual(first['run']['run_id'],second['run']['run_id']);self.assertEqual(self.app.runs()['counts']['total'],2)
        with self.assertRaises(ConfigConflict):self.app.start_task(self.payload(self.profile,request_id='copy-request',source_run_id=first['run']['run_id']),start=False)

    def test_stale_selected_configuration_is_rejected_without_a_copy(self):
        fields={k:deepcopy(self.profile[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')};fields.update(revision=1,prompt='已经修改')
        self.app.agents.save(fields,self.profile['id'])
        with self.assertRaises(ConfigConflict):self.copy()
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_archived_source_is_reusable_with_a_different_current_agent(self):
        self.app.archive_task(self.original,{'archived':True,'revision':0});self.app.agents.archive(self.profile['id'],1)
        with self.assertRaises((ValueError,ConfigConflict)):self.copy()
        self.profile=self.agent();result=self.copy()
        self.assertEqual(result['run']['task']['source_run_id'],self.original);self.assertEqual(result['run']['snapshot']['agent_profile']['id'],self.profile['id'])
        self.assertTrue(TaskConversations(self.app).view(self.original)['archive']['archived'])

    def test_foreign_source_is_rejected_without_creating_a_task(self):
        other=Application(self.temp.name,principal='other-person');self.addCleanup(other.close)
        profile=other.agents.get(self.profile['id'])
        with self.assertRaises(PolicyDenied):other.start_task(self.payload(profile,request_id='foreign-copy',source_run_id=self.original),start=False)
        space=self.app.workspaces.save({'name':'另一空间','business':'验证','scenario':'测试','description':'','revision':0})
        isolated=self.app.scoped(space['id']);profile=isolated.agents.save({k:deepcopy(self.profile[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')}|{'revision':0})
        with self.assertRaises(PolicyDenied):isolated.start_task(self.payload(profile,request_id='foreign-workspace-copy',source_run_id=self.original),start=False)
        self.assertEqual(self.app.runs()['counts']['total'],1);self.assertEqual(isolated.runs()['counts']['total'],0)


class TaskReuseHTTPTests(unittest.TestCase):
    setUp=web_fixtures.HTTPTests.setUp
    tearDown=web_fixtures.HTTPTests.tearDown
    request=web_fixtures.HTTPTests.request

    def test_source_explanation_is_bundled_and_served_offline(self):
        status,headers,body=self.request('/task_reuse.js');self.assertEqual(status,200);self.assertIn('text/javascript',headers['Content-Type']);self.assertIn('renderTaskSource',body.decode())
        self.assertIn('/task_reuse.js',self.request('/')[2].decode())


if __name__=='__main__':unittest.main()
