from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.cli import export_result
from agent_framework.contracts import TaskContract, Decision, ActionProposal, PolicyDenied, TOOLS
from agent_framework.definitions import AgentCompiler, default_definition
from agent_framework.domains.knowledge_answer import KnowledgePlanner, REF, TOOLS as READS, SCHEMAS
from agent_framework.experience import ExperienceService
from agent_framework.knowledge import Library, Access
from agent_framework.llm import CodexConfig, LLMPlanner, ModelError
from agent_framework.runtime import Runtime
from test_governance import profile


class QAFormatFixture:
    def __init__(self,mutate=None):self.requests=[];self.mutate=mutate
    def generate(self,prompt,schema,config,timeout):
        request=json.loads(prompt[prompt.index('\n{')+1:]);self.requests.append(request)
        wire=request['context'];phase=request['phase']
        state={**wire['work'],'task':wire['task']}
        context={'state':state,'evidence':wire['evidence']};planner=KnowledgePlanner()
        value={'steps':planner.plan(context)} if phase=='plan' else asdict(planner.decide(context)) if phase=='decide' else planner.compose(context)
        if self.mutate:value=self.mutate(phase,value)
        return json.dumps(value,ensure_ascii=False),{'usage':{'input_tokens':2,'output_tokens':1},'model':config.model}


class KnowledgeDomainTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.runtime=Runtime(self.tmp.name);self.library=Library(self.runtime.store)
        self.owner=Access('tenant-demo','kurt','project-demo',roles=('curator','reviewer'))

    def task(self,**kw):return TaskContract(domain_pack_ref=REF,goal='变更评估的风险规则是什么？',**kw)

    def test_second_domain_compiles_two_read_capabilities_and_zero_business_writes(self):
        c=AgentCompiler().compile(domain_ref=REF)
        self.assertEqual(set(c['capabilities']),set(READS))
        self.assertTrue(all(a['effect']=='READ' for a in c['capabilities'].values()))
        state=self.runtime.submit(self.task());result=self.runtime.run(state['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED');self.assertTrue(all(c['passed'] for c in result['checks'].values()))
        self.assertEqual(result['report']['answer'],'\n'.join(c['quote'] for c in result['report']['citations']))
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id']),{'calls':{},'drafts':[]})
        export_result(self.runtime,result,Path(self.tmp.name)/'export')
        self.assertIn('## 来源',(Path(self.tmp.name)/'export/report.md').read_text())

    def test_runtime_selects_domain_without_changing_recovery_kernel(self):
        for task in (TaskContract(),self.task(),TaskContract()):
            state=self.runtime.submit(task);self.assertEqual(self.runtime.run(state['run_id'])['status'],'SUCCEEDED')

    def test_source_missing_requests_input_instead_of_inventing_answer(self):
        task=TaskContract(domain_pack_ref=REF,goal='完全不存在的量子园艺主题')
        state=self.runtime.submit(task);result=self.runtime.run(state['run_id'])
        self.assertEqual(result['status'],'WAITING_INPUT');self.assertIsNone(result['report'])
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['drafts'],[])

    def test_supplementing_sources_resumes_same_task_with_new_read_revision(self):
        task=TaskContract(domain_pack_ref=REF,goal='独角兽数据格式规范')
        state=self.runtime.submit(task);waiting=self.runtime.run(state['run_id'])
        self.assertEqual(waiting['status'],'WAITING_INPUT')
        before=waiting['actions'][0]
        asset=self.library.create(self.owner,{'kind':'KNOWLEDGE','title':'独角兽数据格式规范','content':{'text':'独角兽数据格式规范：记录需要包含版本、来源和摘要。'}})
        self.library.transition(self.owner,asset['ref'],'REVIEW');self.library.transition(self.owner,asset['ref'],'PUBLISHED')
        resumed=self.runtime.run(state['run_id'])
        self.assertEqual(resumed['status'],'SUCCEEDED');self.assertEqual(resumed['replans'],1)
        self.assertEqual(resumed['snapshot'],waiting['snapshot'])
        self.assertEqual(resumed['actions'][0],before)
        self.assertIn(asset['ref'],[c['asset_ref'] for c in resumed['report']['citations']])
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['calls'],{})

    def test_unread_source_and_write_capability_are_rejected(self):
        state=self.runtime.submit(self.task())
        for ref,args in [(TOOLS[2],{}),(READS[1],{'project_id':'project-demo','asset_refs':['other@1']})]:
            with self.assertRaises(PolicyDenied):self.runtime.gateway.prepare(state,ActionProposal(ref,args,[],[],'bad'),{})
        with self.assertRaises(ValueError):self.runtime.submit(self.task(),scenario='response-lost')

    def test_unsupported_answer_fails_independent_grounding_check(self):
        class Bad(KnowledgePlanner):
            def compose(self,context):
                result=super().compose(context);result['answer']='无引用证据的事实';return result
        runtime=Runtime(self.tmp.name,planner=Bad());state=runtime.submit(self.task());result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'FAILED');self.assertEqual(result['replans'],2)
        self.assertFalse(result['checks']['answer-grounded']['passed'])
        self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['calls'],{})

    def test_restarting_after_reads_keeps_frozen_intents_and_returns_answer(self):
        state=self.runtime.submit(self.task());paused=self.runtime.run(state['run_id'],pause_after=2)
        actions=paused['actions'];snapshot=paused['snapshot']
        resumed=Runtime(self.tmp.name).run(state['run_id'])
        self.assertEqual(resumed['status'],'SUCCEEDED');self.assertEqual(resumed['snapshot'],snapshot)
        self.assertEqual(resumed['actions'],actions)

    def test_withdrawn_read_is_not_sent_to_further_cognition(self):
        state=self.runtime.submit(self.task());paused=self.runtime.run(state['run_id'],pause_after=2)
        ref=paused['observations']['knowledge_documents']['data']['documents'][0]['ref']
        self.library.transition(self.owner,ref,'WITHDRAWN')
        result=self.runtime.run(state['run_id'])
        self.assertEqual(result['status'],'WAITING_INPUT');self.assertIsNone(result['report'])

    def test_withdrawn_historical_evidence_does_not_leak_into_resumed_model_context(self):
        question='私有格式规范主题'
        old=self.library.create(self.owner,{'kind':'KNOWLEDGE','title':question,'content':{'text':'私有格式规范主题：REVOKED_SECRET'}})
        self.library.transition(self.owner,old['ref'],'REVIEW');self.library.transition(self.owner,old['ref'],'PUBLISHED')
        fixture=QAFormatFixture();runtime=Runtime(self.tmp.name,planner=LLMPlanner(CodexConfig('fixture-model','low'),fixture))
        state=runtime.submit(TaskContract(domain_pack_ref=REF,goal=question));runtime.run(state['run_id'],pause_after=2)
        self.library.transition(self.owner,old['ref'],'WITHDRAWN')
        self.assertEqual(runtime.run(state['run_id'])['status'],'WAITING_INPUT')
        replacement=self.library.create(self.owner,{'kind':'KNOWLEDGE','title':question,'content':{'text':'私有格式规范主题：NEW_ALLOWED'}})
        self.library.transition(self.owner,replacement['ref'],'REVIEW');self.library.transition(self.owner,replacement['ref'],'PUBLISHED')
        boundary=len(fixture.requests)
        result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        self.assertNotIn('REVOKED_SECRET',json.dumps(fixture.requests[boundary:],ensure_ascii=False))
        self.assertIn('NEW_ALLOWED',result['report']['answer'])
        self.assertIn('REVOKED_SECRET',json.dumps(runtime.store.evidence(result)))
        self.assertTrue(any(i['reason']=='historical-source-access-withdrawn' for m in runtime.store.contexts('tenant-demo',state['run_id']) for i in m['excluded']))

    def test_source_revoked_at_read_dispatch_can_resume_with_a_new_read_intent(self):
        question='独角兽撤回测试'
        old=self.library.create(self.owner,{'kind':'KNOWLEDGE','title':question,'content':{'text':question+'：旧资料'}})
        self.library.transition(self.owner,old['ref'],'REVIEW');self.library.transition(self.owner,old['ref'],'PUBLISHED')
        library,owner=self.library,self.owner
        class RevokeOnce(KnowledgePlanner):
            revoked=False
            def decide(self,context):
                decision=super().decide(context)
                if decision.action and decision.action.tool_ref==READS[1] and not self.revoked:
                    library.transition(owner,old['ref'],'WITHDRAWN');self.revoked=True
                return decision
        runtime=Runtime(self.tmp.name,planner=RevokeOnce());state=runtime.submit(TaskContract(domain_pack_ref=REF,goal=question))
        waiting=runtime.run(state['run_id']);self.assertEqual(waiting['status'],'WAITING_INPUT')
        prepared=next(a for a in waiting['actions'] if a['status']=='PREPARED')
        new=library.create(owner,{'kind':'KNOWLEDGE','title':question,'content':{'text':question+'：新资料'}})
        library.transition(owner,new['ref'],'REVIEW');library.transition(owner,new['ref'],'PUBLISHED')
        result=runtime.run(state['run_id']);self.assertEqual(result['status'],'SUCCEEDED')
        old_action=next(a for a in result['actions'] if a['logical_id']==prepared['logical_id'])
        self.assertEqual(old_action['status'],'REJECTED');self.assertEqual(old_action['args_hash'],prepared['args_hash'])
        self.assertIn(new['ref'],[c['asset_ref'] for c in result['report']['citations']])

    def test_verifier_rechecks_current_source_even_if_withdrawn_during_finish(self):
        library=self.library;owner=self.owner
        class Withdraw(KnowledgePlanner):
            def decide(self,context):
                decision=super().decide(context)
                if decision.kind=='request_finish':
                    library.transition(owner,context['state']['report']['citations'][0]['asset_ref'],'WITHDRAWN')
                return decision
        runtime=Runtime(self.tmp.name,planner=Withdraw());state=runtime.submit(self.task());result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'NEEDS_REVIEW');self.assertFalse(result['checks']['answer-current']['passed'])

    def test_structured_model_uses_qa_schema_and_freezes_restore_descriptor(self):
        fixture=QAFormatFixture();planner=LLMPlanner(CodexConfig('fixture-model','low'),fixture)
        runtime=Runtime(self.tmp.name,planner=planner);state=runtime.submit(self.task());result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        self.assertEqual(result['snapshot']['planner']['domain_pack_ref'],REF)
        self.assertEqual(LLMPlanner.restore(planner.descriptor()).descriptor(),planner.descriptor())
        self.assertEqual(fixture.requests[-1]['schema'],SCHEMAS['decide'])
        self.assertTrue(any(r['context'].get('context_manifest') for r in fixture.requests))
        self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['calls'],{})

    def test_model_cannot_select_draft_tool_or_finish_without_quotes(self):
        for mutate in [lambda phase,v: {'kind':'request_finish','summary':'done','action':None} if phase=='decide' else v,
                       lambda phase,v: ({**v,'action':{**v['action'],'tool_ref':TOOLS[2]}} if phase=='decide' and v.get('action') else v)]:
            runtime=Runtime(self.tmp.name,planner=LLMPlanner(CodexConfig('fixture-model','low'),QAFormatFixture(mutate)))
            state=runtime.submit(self.task());result=runtime.run(state['run_id'])
            self.assertNotEqual(result['status'],'SUCCEEDED')
            self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['calls'],{})

    def test_custom_role_binding_cannot_smuggle_extra_write_capability(self):
        p=profile();p['definition']=default_definition(p['name'],REF)
        c=AgentCompiler().compile(p);self.assertEqual(c['domain_pack']['ref'],REF)
        p['definition']['capability_refs'].append(TOOLS[2])
        with self.assertRaises(ValueError):AgentCompiler().compile(p)

    def test_read_only_experience_is_evaluated_against_its_own_domain(self):
        state=self.runtime.submit(self.task());self.runtime.run(state['run_id'])
        service=ExperienceService(self.runtime.store);candidate=service.list(self.owner)[0]
        evaluation=service.evaluate(self.owner,candidate['ref'])
        self.assertTrue(evaluation['passed']);self.assertEqual(evaluation['domain_ref'],REF)
        self.assertEqual(len(evaluation['cases']),3)
        self.assertTrue(all(c['write_calls']==0 and c['draft_count']==0 for c in evaluation['cases']))
        self.assertEqual(service.publish(self.owner,candidate['ref'],evaluation['id'])['status'],'PUBLISHED')


if __name__=='__main__':unittest.main()
