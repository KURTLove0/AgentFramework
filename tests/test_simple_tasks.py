"""Goal-driven instructions and the two-field task start contract."""
from copy import deepcopy
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.agents import agent_ref
from agent_framework.cli import artifact_markdown
from agent_framework.contracts import TaskContract, PolicyDenied, Decision, ActionProposal, digest
from agent_framework.definitions import default_definition
from agent_framework.domains.general_assistant import DOMAIN, CHECKS, GeneralPlanner
from agent_framework.knowledge import Access, Library
from agent_framework.llm import CodexConfig, LLMPlanner
from agent_framework.runtime import Runtime
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application, APIError
from agent_framework.experience import ExperienceService

GENERAL='general-assistant@1.0.0'

class GoalFixture:
    def __init__(self):self.requests=[]
    def generate(self,prompt,schema,config,timeout):
        request=json.loads(prompt[prompt.index('\n{')+1:]);self.requests.append(request)
        phase=request['phase'];wire=request['context']
        if phase=='plan':value={'steps':[{'id':'compose','description':'按自定义邮件格式交付','tool_ref':None}]}
        elif phase=='decide':value={'kind':'request_finish' if wire['work']['report'] else 'compose_report','summary':'完成目标','action':None}
        else:value={'title':'客户回访邮件','content':'您好，感谢您的反馈。\n我们将在周五前回复处理进展。','citations':[],'limitations':[]}
        return json.dumps(value,ensure_ascii=False),{'usage':{'input_tokens':20,'output_tokens':20}}

class SimpleTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='simple-task-',dir='/private/tmp');self.addCleanup(self.temp.cleanup)
        self.app=Application(self.temp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(self.app.close)
        self.schedule=patch.object(self.app,'schedule');self.scheduled=self.schedule.start();self.addCleanup(self.schedule.stop)
        self.scheduled.side_effect=lambda run_id:self.app.jobs.update({run_id:{'active':True,'state':'QUEUED','cancel':threading.Event()}})

    def agent(self,domain=GENERAL):
        return self.app.agents.save({'name':'客户支持助手','description':'按目标完成撰写和整理','runtime':'mock','model':'builtin',
          'options':{},'prompt':'先说明问题，再按用户要求交付。邮件不要超过两段。','skills':[],'mcp_servers':[],
          'definition':default_definition('客户支持助手',domain),'revision':0})

    def payload(self,agent=None,**overrides):
        agent=agent or self.agent()
        return {'goal':'为客户写一封简短回访邮件','agent_id':agent['id'],'agent_revision':agent['revision'],'request_id':'request-first',**overrides}

    def test_generic_completion_requires_no_sources_or_fake_seed(self):
        agent=self.agent();created=self.app.start_task(self.payload(agent));run=created['run']
        self.assertEqual(run['task']['domain_pack_ref'],GENERAL)
        self.assertEqual(run['snapshot']['agent_profile']['prompt'],agent['prompt'])
        self.assertFalse(created['grant']['valid'])
        self.scheduled.assert_called_once_with(run['run_id'])
        result=self.app.runtime().run(run['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED',result['last_error'])
        self.assertEqual(set(result['checks']),set(CHECKS))
        self.assertEqual(result['report']['citations'],[])
        self.assertIn('离线模拟',result['report']['content'])
        self.assertEqual(Library(self.app.runtime().store).list(Access.task(result['task'])),[])
        self.assertEqual(created['external']['drafts'],[])
        self.assertIn(result['report']['content'],artifact_markdown(result['report']))
        self.assertEqual(self.app.runtime().run(run['run_id'])['status'],'SUCCEEDED')

    def test_idempotency_and_payload_collision(self):
        data=self.payload();a=self.app.start_task(data);b=self.app.start_task(data)
        self.assertEqual(a['run']['run_id'],b['run']['run_id']);self.scheduled.assert_called_once()
        self.assertEqual(self.app.runs()['counts']['total'],1)
        with self.assertRaises(ConfigConflict):self.app.start_task({**data,'goal':'不同目标'})
        with self.assertRaises(ConfigConflict):self.app.start_task({**data,'agent_revision':2})
        self.app.start_task({**data,'request_id':'request-second'})
        self.assertEqual(self.app.runs()['counts']['total'],2)

    def test_two_required_fields_validation_and_no_write_grant_field(self):
        data=self.payload()
        for override in ({'goal':''},{'goal':'   '},{'goal':'x'*2001},{'agent_id':''},{'request_id':''},
                         {'agent_revision':True},{'grant':True},{'planner':'codex'},{'consent':True},{'clear_draft':1}):
            with self.subTest(override=override),self.assertRaises((ValueError,TypeError)):
                self.app.start_task({**data,**override})
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_archived_revision_and_workspace_checks_before_start(self):
        agent=self.agent();data=self.payload(agent)
        self.app.agents.archive(agent['id'],1)
        with self.assertRaisesRegex(ValueError,'归档'):self.app.start_task(data)
        restored=self.app.agents.archive(agent['id'],2,False)
        with self.assertRaises(ConfigConflict):self.app.start_task(data)
        workspace=self.app.workspaces.save({'name':'另一空间','description':'','business':'客户支持','scenario':'日常工作','revision':0})
        other=self.app.scoped(workspace['id'])
        with self.assertRaises(KeyError):other.start_task(self.payload(restored))
        self.scheduled.assert_not_called()

    def test_normal_task_uses_direct_execution_even_with_legacy_change_agent(self):
        agent=self.agent('change-assessment@2.0.0')
        run=self.app.start_task(self.payload(agent))['run'];result=self.app.runtime().run(run['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED',result['last_error'])
        self.assertEqual(result['task']['execution_mode'],'conversation');self.assertEqual(result['plan'],[])
        self.assertEqual(result['snapshot']['agent_profile'],agent)
        self.assertEqual(result['actions'],[])
        # Explicit business workflows preserve their concrete write-authorization behavior.
        started=self.app.create({'agent_id':agent['id'],'agent_revision':agent['revision'],
            'goal':'评估指定变更并生成草稿','change_id':'change-client-101','grant':False,'start':False})
        result=self.app.runtime().run(started['run']['run_id'])
        self.assertEqual(result['status'],'WAITING_AUTH',result['last_error'])
        self.assertTrue(any(a['status']=='PREPARED' and a['tool_ref'].startswith('report.draft.create') for a in result['actions']))
        self.assertEqual(self.app.detail(result['run_id'])['external']['drafts'],[])

    def test_custom_instructions_and_generic_schema_reach_real_model_adapter(self):
        profile=self.agent();profile={**profile,'runtime':'codex','model':'fixture-model','options':{'timeout':5,'max_attempts':2,'reasoning_effort':'low'}}
        fixture=GoalFixture();planner=LLMPlanner(CodexConfig('fixture-model','low',timeout=5),fixture,agent_profile=profile)
        runtime=Runtime(self.temp.name,planner=planner)
        task=TaskContract(domain_pack_ref=GENERAL,agent_ref=agent_ref(profile),principal=self.app.principal,goal='写一份回访邮件')
        state=runtime.submit(task,agent_profile=profile,grant=False)
        self.assertEqual(LLMPlanner.restore(state['snapshot']['planner']).descriptor(),state['snapshot']['planner'])
        result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED',result['last_error'])
        self.assertIn('周五',result['report']['content'])
        configured=fixture.requests[0]['context']['configured_agent']
        self.assertEqual(configured['prompt'],profile['prompt'])
        self.assertIn('content',fixture.requests[-2]['schema']['properties'])
        self.assertNotIn('sections',fixture.requests[-2]['schema']['properties'])
        self.assertFalse(self.app.detail(state['run_id'])['grant']['valid'])

    def test_forged_citations_and_malformed_results_fail_verification(self):
        created=self.app.start_task(self.payload())['run'];result=self.app.runtime().run(created['run_id'])
        forged=deepcopy(result);forged['report']['citations']=[{'asset_ref':'fake@1','evidence_ref':'e-fake','quote':'伪造内容','content_hash':'abc'}]
        self.assertFalse(DOMAIN.task_checks(forged,{},store=self.app.runtime().store)[CHECKS[1]]['passed'])
        for report in (None,[],{'title':'','content':''}):
            forged['report']=report
            self.assertFalse(any(c['passed'] for c in DOMAIN.task_checks(forged,{}).values()))

    def test_retry_can_start_a_task_after_queue_was_full_without_recreating(self):
        data=self.payload();normal=self.scheduled.side_effect
        self.scheduled.side_effect=APIError(429,'执行队列已满')
        pending=self.app.start_task(data);self.assertEqual(pending['run']['status'],'CREATED');self.assertIsNone(pending['job'])
        self.assertEqual(self.app.runs()['counts']['total'],1)
        self.scheduled.side_effect=normal
        result=self.app.start_task(data)
        self.assertTrue(result['job']['active'])
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_optional_knowledge_reads_are_grounded_and_revocation_invalidates(self):
        runtime=self.app.runtime();library=Library(runtime.store);owner=self.app.library_access()
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'退换货期限','content':{'text':'退换货期限为收到商品后的七个自然日。'}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        class WithSources(GeneralPlanner):
            def decide(self,context):
                work=context['state'];observations=work['observations'];project=work['task']['project_id']
                if 'knowledge_hits' not in observations:
                    return Decision('propose_action','查询资料',ActionProposal('knowledge.search@1.0.0',{'project_id':project,'query':'退换货期限'},[],list(CHECKS),'查询已发布来源'))
                if 'knowledge_documents' not in observations:
                    return Decision('propose_action','读取资料',ActionProposal('knowledge.read@1.0.0',{'project_id':project,'asset_refs':[source['ref']]},list(context['evidence']),list(CHECKS),'核对来源原文'))
                return super().decide(context)
            def compose(self,context):
                observation=context['state']['observations']['knowledge_documents'];doc=observation['data']['documents'][0]
                return {'title':'退换货答复','content':'您好，您可在收货后七个自然日内申请退换货。','citations':[{'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'evidence_ref':observation['id'],'quote':doc['content']['text']}],'limitations':[]}
        runtime=Runtime(self.temp.name,planner=WithSources());task=TaskContract(domain_pack_ref=GENERAL,goal='用一段客服话术说明退换货期限',principal=self.app.principal)
        created=runtime.submit(task,grant=False);result=runtime.run(created['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED',result['last_error'])
        self.assertEqual(result['report']['citations'][0]['asset_ref'],source['ref'])
        self.assertEqual(len(result['actions']),2)
        with self.assertRaises(PolicyDenied):DOMAIN.prepare_args(result,'knowledge.search@1.0.0',{'project_id':'other-project','query':'退换货期限'},{})
        library.transition(owner,source['ref'],'WITHDRAWN')
        checks=DOMAIN.task_checks(result,runtime.store.evidence(result),store=runtime.store)
        self.assertTrue(checks[CHECKS[0]]['passed']);self.assertFalse(checks[CHECKS[1]]['passed'])

    def test_general_experience_candidates_use_generic_lessons_and_can_be_evaluated(self):
        agent=self.agent();created=self.app.create({'goal':'按目标生成结果','agent_id':agent['id'],'agent_revision':1,'start':False,'grant':False})['run'];result=self.app.runtime().run(created['run_id'])
        service=ExperienceService(self.app.runtime().store);owner=self.app.library_access()
        candidates=service.list(owner);self.assertEqual(len(candidates),1)
        self.assertIn('自定义工作指令',candidates[0]['content']['lesson'])
        self.assertNotIn('变更',candidates[0]['content']['lesson'])
        evaluation=service.evaluate(owner,candidates[0]['ref'])
        self.assertTrue(evaluation['passed'],evaluation)
        self.assertEqual(len(evaluation['cases']),3)

if __name__=='__main__':unittest.main()
