"""A new task accepts the reviewed configuration at the commit boundary."""
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.contracts import digest
from agent_framework.agent_domains import AgentDomains
from agent_framework.agents import AgentRegistry
from agent_framework.definitions import default_definition
from agent_framework.runtime import Runtime
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from agent_framework.workflows import Workflows
from tests import test_web as web_tests


def agent_data():
    return dict(name='提交边界助手',description='核对任务接受配置',runtime='mock',model='builtin',options={},
                prompt='按确认的配置完成任务',skills=[],mcp_servers=[],revision=0,
                definition=default_definition('提交边界助手','general-assistant@1.0.0'))


@contextmanager
def before_submit(action):
    submit=Runtime.submit;called=False
    def interleave(runtime,*args,**kwargs):
        nonlocal called
        if not called:called=True;action()
        return submit(runtime,*args,**kwargs)
    with patch.object(Runtime,'submit',interleave):yield


class TaskAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='task-acceptance-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.other=Application(self.tmp.name);self.addCleanup(self.other.close)
        self.agent=self.app.agents.save(agent_data())
        self.payload={'goal':'使用确认的指令整理材料','agent_id':self.agent['id'],'agent_revision':1,'request_id':'commit-check'}
        self.draft=self.app.save_task_draft({'revision':0,'draft':{'goal':self.payload['goal'],'agent_id':self.agent['id']}})

    def identity(self):
        return 'task-'+digest([self.app.tenant,self.app.workspace['id'],self.app.principal,self.payload['request_id']])[:32]

    def submit(self,*,start=False):
        return self.app.start_task({**self.payload,'clear_draft':True,'draft_revision':self.draft['revision']},start=start)

    def assert_not_accepted(self):
        with self.app.control_store.connect() as db:
            for table,key in (('runs','id'),('events','run_id'),('grants','run_id'),('task_conversations','id'),('task_conversation_turns','task_id')):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table+' WHERE '+key+'=?',(self.identity(),)).fetchone()[0],0,table)
        self.assertEqual(self.app.task_draft(),self.draft)
        self.assertNotIn(self.identity(),self.app.jobs)

    def edit_agent(self):
        data=agent_data();data.update(revision=1,prompt='另一页新保存的指令')
        return self.other.agents.save(data,self.agent['id'])

    def skill(self,enabled=True):
        registry=self.app.skills()
        saved=registry.save({'folder':'acceptance-method','revision':0,'files':{'SKILL.md':{'encoding':'utf-8','content':'---\nname: acceptance-method\ndescription: 整理材料时使用的方法\n---\n\n先核对来源再总结。\n'}}})
        saved=registry.lifecycle(saved['id'],saved['revision'],'publish',1)
        data=agent_data();data.update(revision=1,skill_bindings=[{'skill_id':saved['id'],'version':1,'enabled':enabled}])
        self.agent=self.app.agents.save(data,self.agent['id']);self.payload['agent_revision']=2
        return saved

    def change_runtime(self):
        current=self.other.configuration.get()
        return self.other.configuration.save({key:current[key] for key in ('default_runtime','profiles','revision')})

    def test_agent_edit_before_commit_rejects_the_whole_submission_and_keeps_draft(self):
        with before_submit(self.edit_agent),patch.object(self.app,'schedule') as schedule:
            with self.assertRaisesRegex(ConfigConflict,'智能体|Agent'):self.submit(start=True)
        schedule.assert_not_called();self.assert_not_accepted()
        self.payload['agent_revision']=2
        result=self.submit();self.assertEqual(result['run']['snapshot']['agent_profile']['revision'],2)
        self.assertEqual(result['run']['run_id'],self.identity());self.assertIsNone(self.app.task_draft()['draft'])

    def test_agent_archive_before_commit_rejects_even_after_initial_version_check(self):
        with before_submit(lambda:self.other.agents.archive(self.agent['id'],1)):
            with self.assertRaisesRegex(ConfigConflict,'归档|更新'):self.submit()
        self.assert_not_accepted()

    def test_withdrawn_skill_before_commit_does_not_enter_the_execution_queue(self):
        skill=self.skill()
        with before_submit(lambda:self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)):
            with self.assertRaisesRegex(ConfigConflict,'Skill'):self.submit(start=True)
        self.assert_not_accepted()

    def test_archived_skill_before_commit_does_not_accept_a_new_task(self):
        skill=self.skill()
        with before_submit(lambda:self.other.skills().lifecycle(skill['id'],skill['revision'],'archive',1)):
            with self.assertRaisesRegex(ConfigConflict,'Skill'):self.submit()
        self.assert_not_accepted()

    def test_runtime_settings_change_during_preparation_conflicts_at_acceptance(self):
        with before_submit(self.change_runtime):
            with self.assertRaisesRegex(ConfigConflict,'运行时'):
                self.app.create({'runtime':'mock','runtime_revision':0,'start':False},run_id=self.identity())
        self.assert_not_accepted()

    def test_default_runtime_change_without_client_revision_is_also_checked(self):
        with before_submit(self.change_runtime),self.assertRaises(ConfigConflict):
            self.app.create({'start':False},run_id=self.identity())
        self.assert_not_accepted()

    def test_agent_task_does_not_depend_on_unrelated_runtime_defaults(self):
        with before_submit(self.change_runtime):result=self.submit()
        self.assertEqual(result['run']['snapshot']['agent_profile']['revision'],1)
        self.assertEqual(result['run']['snapshot']['agent_profile']['runtime'],'mock')

    def test_new_skill_version_does_not_replace_a_still_published_binding(self):
        skill=self.skill();frozen=deepcopy(self.agent['skill_packages'])
        def publish_next():
            registry=self.other.skills();files={path:{key:value[key] for key in ('encoding','content')} for path,value in skill['package']['files'].items()}
            files['SKILL.md']['content']+='\n新版本的额外指导。\n'
            saved=registry.save({'folder':skill['name'],'files':files,'revision':skill['revision']},skill['id'])
            registry.lifecycle(skill['id'],saved['revision'],'publish',2)
        with before_submit(publish_next):result=self.submit()
        self.assertEqual(result['run']['snapshot']['agent_profile']['skill_packages'],frozen)
        self.assertEqual(self.other.skills().get(skill['id'])['version'],2)

    def test_withdrawing_a_disabled_binding_does_not_block_submission(self):
        skill=self.skill(enabled=False)
        with before_submit(lambda:self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)):
            result=self.submit()
        self.assertFalse(result['run']['snapshot']['agent_profile']['skill_packages'][0]['enabled'])

    def test_accepted_submission_replays_after_agent_archive_and_skill_withdrawal(self):
        skill=self.skill();first=self.submit()
        self.other.agents.archive(self.agent['id'],self.agent['revision'])
        self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)
        second=self.submit()
        self.assertEqual(second['run']['run_id'],first['run']['run_id'])
        self.assertEqual(second['run']['snapshot'],first['run']['snapshot'])
        self.assertEqual(sum(e['kind']=='task.created' for e in second['events']),1)

    def test_followup_still_uses_accepted_profile_after_agent_archive(self):
        root=self.submit()['run'];self.app.runtime().run(root['run_id'])
        self.other.agents.archive(self.agent['id'],1)
        with patch.object(self.app,'schedule'):
            result=TaskConversations(self.app).append(root['run_id'],{'content':'继续按原配置补充','request_id':'followup','revision':1})
        turn=result['conversation']['turns'][1]
        child=self.app.control_store.load(self.app.tenant,turn['run_id'])
        self.assertEqual(child['snapshot']['agent_profile']['revision'],1)
        self.assertFalse(child['snapshot']['agent_profile']['archived'])

    def test_processing_domain_guidance_keeps_the_agents_explicitly_bound_version(self):
        domains=AgentDomains(self.app.agents.store,self.app.tenant,self.app.workspace['id'])
        domain=domains.create({'name':'材料整理','work_method':'先核对材料。'})
        data=agent_data();data.update(revision=1,processing_domain_id=domain['id'])
        self.agent=self.app.agents.save(data,self.agent['id']);self.payload['agent_revision']=2
        def change_domain():
            AgentDomains(self.other.agents.store,self.other.tenant,self.other.workspace['id']).update(domain['id'],{'revision':1,'name':domain['name'],'description':'','work_method':'改用其他指导。'})
        with before_submit(change_domain):result=self.submit()
        self.assertEqual(result['run']['snapshot']['agent_profile']['processing_domain'],domain)

    def test_deleted_workspace_cannot_accept_a_prepared_task_or_clear_its_draft(self):
        self.other.workspaces.save({'name':'保留空间','description':'','business':'测试','scenario':'隔离','revision':0})
        with before_submit(lambda:self.other.workspaces.lifecycle(self.app.workspace['id'],1,True)):
            with self.assertRaises(KeyError):self.submit()
        self.assert_not_accepted()

    def test_update_after_the_acceptance_check_waits_for_the_same_transaction(self):
        checked=threading.Event();release=threading.Event();waiting=threading.Event()
        check=AgentRegistry.assert_submission_current;transaction=self.other.agents.store.transaction
        def hold(registry,db,profile):
            check(registry,db,profile);checked.set()
            if not release.wait(5):raise RuntimeError('acceptance test not released')
        @contextmanager
        def observe_writer():
            waiting.set()
            with transaction() as db:yield db
        with patch.object(AgentRegistry,'assert_submission_current',hold),patch.object(self.other.agents.store,'transaction',observe_writer),ThreadPoolExecutor(max_workers=2) as pool:
            accepting=pool.submit(self.submit)
            try:
                self.assertTrue(checked.wait(2))
                archiving=pool.submit(self.other.agents.archive,self.agent['id'],1)
                self.assertTrue(waiting.wait(2));self.assertFalse(archiving.done())
            finally:release.set()
            result=accepting.result(3);archived=archiving.result(3)
        self.assertEqual(result['run']['snapshot']['agent_profile']['revision'],1)
        self.assertTrue(archived['archived']);self.assertEqual(archived['revision'],2)


class WorkflowAcceptanceTests(unittest.TestCase):
    setUp=TaskAcceptanceTests.setUp
    skill=TaskAcceptanceTests.skill
    edit_agent=TaskAcceptanceTests.edit_agent

    def workflow(self):
        self.flows=self.app.workflows()
        self.saved=self.flows.save({'name':'接受边界流程','description':'核对流程启动版本','revision':0,'nodes':[
            {'id':'prepare','name':'整理','agent_id':self.agent['id'],'agent_revision':self.agent['revision'],'goal':'整理材料并给出可核验的总结','depends_on':[]}]})
        self.request={'revision':1,'request_id':'flow-acceptance'}
        self.run_id='flowrun-'+digest([self.app.tenant,self.app.workspace['id'],self.app.principal,'flow-acceptance'])[:24]

    @contextmanager
    def before_accept(self,action):
        transaction=self.flows.store.transaction;called=False
        @contextmanager
        def interleave():
            nonlocal called
            if not called:called=True;action()
            with transaction() as db:yield db
        with patch.object(self.flows.store,'transaction',interleave):yield

    def start(self):return self.flows.start(self.saved['id'],self.request)

    def assert_not_accepted(self):
        with self.app.control_store.connect() as db:
            for table,key in (('workflow_runs','id'),('workflow_events','run_id'),('workflow_dispatches','run_id')):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table+' WHERE '+key+'=?',(self.run_id,)).fetchone()[0],0,table)
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_workflow_definition_changed_after_preflight_cannot_start_the_old_version(self):
        self.workflow()
        def edit():
            self.other.workflows().save({**{key:self.saved[key] for key in ('description','nodes','revision')},'name':'另一页新配置'},self.saved['id'])
        with self.before_accept(edit),self.assertRaisesRegex(ConfigConflict,'工作流'):self.start()
        self.assert_not_accepted()

    def test_workflow_archived_after_preflight_cannot_create_dispatch_intent(self):
        self.workflow()
        with self.before_accept(lambda:self.other.workflows().archive(self.saved['id'],1,True)):
            with self.assertRaisesRegex(ConfigConflict,'工作流'):self.start()
        self.assert_not_accepted()

    def test_node_agent_changed_before_acceptance_rejects_the_whole_workflow(self):
        self.workflow()
        with self.before_accept(self.edit_agent),self.assertRaisesRegex(ConfigConflict,'智能体|Agent'):self.start()
        self.assert_not_accepted()

    def test_node_agent_archived_before_acceptance_rejects_the_whole_workflow(self):
        self.workflow()
        with self.before_accept(lambda:self.other.agents.archive(self.agent['id'],1)):
            with self.assertRaisesRegex(ConfigConflict,'归档|更新'):self.start()
        self.assert_not_accepted()

    def test_node_skill_withdrawn_before_acceptance_rejects_without_a_dispatch(self):
        skill=self.skill();self.workflow()
        with self.before_accept(lambda:self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)):
            with self.assertRaisesRegex(ConfigConflict,'Skill'):self.start()
        self.assert_not_accepted()

    def test_accepted_workflow_replay_and_children_keep_the_original_snapshot(self):
        skill=self.skill();self.workflow();accepted=self.start()
        self.other.workflows().archive(self.saved['id'],1,True)
        self.other.agents.archive(self.agent['id'],self.agent['revision'])
        self.other.skills().lifecycle(skill['id'],skill['revision'],'withdraw',1)
        replay=self.start();self.assertEqual(replay['id'],accepted['id']);self.assertEqual(replay['snapshot'],accepted['snapshot'])
        finished=self.flows.execute(accepted['id']);self.assertEqual(finished['status'],'SUCCEEDED')
        child=self.flows.accepted_child(finished['nodes']['prepare'])
        self.assertEqual(child['snapshot']['agent_profile'],accepted['snapshot']['profiles']['prepare'])


class AcceptanceHTTPTests(unittest.TestCase):
    setUp=web_tests.HTTPTests.setUp
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_task_api_conflict_keeps_inputs_draft_and_request_id_reusable(self):
        agent=self.app.agents.save(agent_data());draft=self.app.save_task_draft({'revision':0,'draft':{'goal':'保留输入'}})
        data={'goal':'保留输入','agent_id':agent['id'],'agent_revision':1,'request_id':'http-acceptance','clear_draft':True,'draft_revision':draft['revision']}
        other=Application(self.tmp.name);self.addCleanup(other.close)
        def edit():other.agents.save(agent_data()|{'revision':1,'prompt':'新指令'},agent['id'])
        with before_submit(edit):status,_,body=self.request('/api/tasks','POST',json.dumps(data))
        self.assertEqual(status,409);self.assertIn('提交期间',json.loads(body)['error'])
        self.assertEqual(self.app.runs()['counts']['total'],0);self.assertEqual(self.app.task_draft(),draft)
        status,_,body=self.request('/api/tasks','POST',json.dumps(data|{'agent_revision':2}))
        self.assertEqual(status,202);self.assertEqual(json.loads(body)['run']['snapshot']['agent_profile']['revision'],2)

    def test_legacy_run_api_reports_runtime_change_as_conflict(self):
        other=Application(self.tmp.name);self.addCleanup(other.close)
        def edit():
            settings=other.configuration.get();other.configuration.save({key:settings[key] for key in ('default_runtime','profiles','revision')})
        with before_submit(edit):status,_,body=self.request('/api/runs','POST',json.dumps({'start':False,'runtime_revision':0}))
        self.assertEqual(status,409);self.assertIn('运行时',json.loads(body)['error'])
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_workflow_start_api_does_not_queue_a_definition_archived_during_preflight(self):
        agent=self.app.agents.save(agent_data());flows=self.app.workflows()
        saved=flows.save({'name':'HTTP 接受流程','description':'启动检查','revision':0,'nodes':[
            {'id':'one','name':'整理','agent_id':agent['id'],'agent_revision':1,'goal':'整理材料','depends_on':[]}]})
        other=Application(self.tmp.name);self.addCleanup(other.close);start=Workflows.start
        def interleave(service,*args,**kwargs):
            transaction=service.store.transaction
            @contextmanager
            def changed():
                other.workflows().archive(saved['id'],1,True)
                with transaction() as db:yield db
            with patch.object(service.store,'transaction',changed):return start(service,*args,**kwargs)
        with patch.object(Workflows,'start',interleave):
            status,_,body=self.request('/api/workflows/'+saved['id']+'/start','POST',json.dumps({'revision':1,'request_id':'http-workflow'}))
        self.assertEqual(status,409);self.assertIn('启动期间',json.loads(body)['error'])
        self.assertEqual(flows.runs(),[])
