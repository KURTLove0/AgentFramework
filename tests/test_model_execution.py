"""Ordinary model turns, real pipe streaming and historical protocol isolation."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.agents import agent_ref
from agent_framework.contracts import TaskContract,PolicyDenied,digest
from agent_framework.definitions import default_definition,domain_for,AgentCompiler
from agent_framework.knowledge import Library,Access
from agent_framework.llm import LLMPlanner,CodexConfig,CursorConfig,QoderConfig,ModelError
from agent_framework.model_execution import ModelExecutionDomain
from agent_framework.model_stream import PublicProgress,collect
from agent_framework.runtime import Runtime

class DirectFixture:
    def __init__(self,reply=None):self.requests=[];self.reply=reply;self.progress=None
    def generate(self,prompt,schema,config,timeout):
        request=json.loads(prompt[prompt.index('\n{')+1:]);self.requests.append(request)
        assert request['phase']=='execute',request['phase']
        if self.progress:
            self.progress({'kind':'status','text':'运行时已开始处理任务。','source':'fixture'})
            self.progress({'kind':'summary','text':'已核对用户提供的要求，正在整理交付内容。','source':'fixture'})
        result={'kind':'result','summary':'已按要求完成交付。','result':{'title':'客户回访邮件','content':'您好，感谢您的反馈。\n我们将在周五前向您反馈处理进展。','citations':[],'limitations':[]}}
        if self.reply:result=self.reply(request,result)
        return json.dumps(result,ensure_ascii=False),{'usage':{'input_tokens':30,'output_tokens':20}}

class ModelExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='model-execution-',dir='/private/tmp');self.addCleanup(self.temp.cleanup)
    def profile(self,provider='codex',domain='knowledge-answer@1.0.0'):
        return {'id':'agent-0123456789abcdef','revision':1,'name':'客户支持助手','description':'解决客户问题','runtime':provider,'model':'fixture-model',
                'options':{'timeout':5,'max_attempts':2,**({'reasoning_effort':'low'} if provider=='codex' else {})},
                'prompt':'请按用户要求交付，不使用固定处理步骤。邮件最多两段。','skills':[],'mcp_servers':[],
                'definition':default_definition('客户支持助手',domain)}
    def run_model(self,profile=None,fixture=None,mode='direct'):
        profile=profile or self.profile();fixture=fixture or DirectFixture()
        config={'codex':CodexConfig,'cursor':CursorConfig,'qoder':QoderConfig}[profile['runtime']](profile['model'],**profile['options'])
        planner=LLMPlanner(config,fixture,agent_profile=profile)
        runtime=Runtime(self.temp.name,planner=planner)
        state=runtime.submit(TaskContract(domain_pack_ref=profile['definition']['domain_pack_ref'],agent_ref=agent_ref(profile),execution_mode=mode,goal='撰写客户回访邮件'),agent_profile=profile,grant=True)
        result=runtime.run(state['run_id']);return runtime,result,fixture
    def test_each_cli_uses_one_execute_turn_no_plan_decide_compose_chain(self):
        for provider in ('codex','cursor','qoder'):
            with self.subTest(provider=provider):
                runtime,result,fixture=self.run_model(self.profile(provider))
                self.assertEqual(result['status'],'SUCCEEDED',result['last_error'])
                self.assertEqual([r['phase'] for r in fixture.requests],['execute'])
                self.assertEqual(result['model_calls'],1);self.assertEqual(result['plan'],[])
                self.assertEqual(result['report']['content'],'您好，感谢您的反馈。\n我们将在周五前向您反馈处理进展。')
                context=fixture.requests[0]['context'];self.assertEqual(context['configured_agent']['prompt'],self.profile(provider)['prompt'])
                self.assertNotIn('request_finish',context['constraints']['completion_gate'])
                self.assertEqual(context['constraints']['write'],'forbidden')
                events=runtime.store.events(result['tenant_id'],result['run_id'])
                self.assertFalse(any(e['kind'] in ('plan.created','decision.proposed','report.validated') for e in events))
                self.assertTrue(any(e['kind']=='model.progress' for e in events))
                self.assertIsNone(runtime.store.get_grant(result))
    def test_original_agent_and_legacy_contract_are_not_mutated(self):
        profile=self.profile(domain='change-assessment@2.0.0');original=deepcopy(profile)
        runtime,result,_=self.run_model(profile)
        self.assertEqual(profile,original);self.assertEqual(result['snapshot']['agent_profile'],original)
        self.assertEqual(result['snapshot']['compiled_agent']['definition'],original['definition'])
        self.assertEqual(result['snapshot']['compiled_agent']['domain_pack']['ref'],original['definition']['domain_pack_ref'])
        self.assertNotIn('execution_mode',TaskContract().to_dict())
        self.assertFalse(AgentCompiler().compile(profile).get('execution_protocol'))
        self.assertEqual(runtime.external.stats(result['tenant_id'],result['run_id']),{'calls':{},'drafts':[]})
        with self.assertRaises(PolicyDenied):domain_for(result['snapshot']).prepare_args(result,'report.draft.create@1.0.0',{},{} )
    def test_missing_information_is_requested_by_model_without_preflight_review(self):
        fixture=DirectFixture(lambda request,result:{'kind':'request_input','summary':'请补充客户的问题与期望回复时间。','result':None})
        runtime,result,_=self.run_model(fixture=fixture)
        self.assertEqual(result['status'],'WAITING_INPUT');self.assertIn('客户的问题',result['last_error'])
        self.assertEqual(result['plan'],[]);self.assertIsNone(result['report']);self.assertEqual(result['model_calls'],1)
    def test_selected_context_can_be_cited_without_a_mandatory_search_read_chain(self):
        library=Library(Runtime(self.temp.name).store);owner=Access('tenant-demo','kurt','project-demo',roles=('curator','reviewer'))
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'客户回访邮件','content':{'text':'客户回访邮件：周五之前反馈处理进展。'}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        def reply(request,result):
            context=request['context'];doc=next(d for d in context['knowledge'] if d['ref']==source['ref'])
            result['result']['citations']=[{'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'evidence_ref':context['context_manifest']['id'],'quote':doc['content']['text']}]
            return result
        runtime,result,_=self.run_model(fixture=DirectFixture(reply))
        self.assertEqual(result['status'],'SUCCEEDED',result['last_error']);self.assertEqual(result['actions'],[])
        library.transition(owner,source['ref'],'WITHDRAWN')
        checks=domain_for(result['snapshot']).task_checks(result,runtime.store.evidence(result),store=runtime.store)
        self.assertFalse(checks['result-evidence']['passed'])
    def test_model_chooses_native_reads_inside_one_turn_without_host_search_steps(self):
        from agent_framework.read_proxy import ReadCapabilityProxy
        library=Library(Runtime(self.temp.name).store);owner=Access('tenant-demo','kurt','project-demo',roles=('curator','reviewer'))
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'客户回访邮件','content':{'text':'客户回访邮件：请在周五之前反馈处理进展。'}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        for search_first in (False,True):
            with self.subTest(search_first=search_first):
                profile=self.profile();profile['definition']['native_read_refs']=['knowledge.read@1.0.0']
                if search_first:profile['definition']['native_read_refs'].insert(0,'knowledge.search@1.0.0')
                fixture=DirectFixture()
                def reply(request,result):
                    server=fixture.governed_profile['mcp_servers'][0];token=server['args'][-1];proxy=ReadCapabilityProxy(self.temp.name)
                    if search_first:proxy.call(token,'knowledge_search',{'project_id':'project-demo','query':'客户回访邮件'})
                    observed=proxy.call(token,'knowledge_read',{'project_id':'project-demo','asset_refs':[source['ref']]})
                    doc=observed['data']['documents'][0]
                    result['result']['citations']=[{'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'evidence_ref':observed['evidence_ref'],'quote':doc['content']['text']}]
                    return result
                fixture.reply=reply
                runtime,result,_=self.run_model(profile,fixture)
                self.assertEqual(result['status'],'SUCCEEDED',result['last_error']);self.assertEqual(result['model_calls'],1)
                self.assertEqual(result['plan'],[]);self.assertEqual(result['actions'],[])
                self.assertEqual(runtime.store.native_read_count(result),2 if search_first else 1)

    def test_fabricated_citation_preserves_output_but_does_not_claim_success(self):
        def reply(request,result):
            result['result']['citations']=[{'asset_ref':'fake@1','content_hash':'fake','evidence_ref':'fake','quote':'invented'}];return result
        _,result,_=self.run_model(fixture=DirectFixture(reply))
        self.assertEqual(result['status'],'NEEDS_REVIEW');self.assertIsNotNone(result['report'])
        self.assertFalse(result['checks']['result-evidence']['passed'])
    def test_frozen_direct_descriptor_restores_and_rejects_protocol_drift(self):
        runtime,result,_=self.run_model()
        frozen=result['snapshot']['planner'];self.assertEqual(LLMPlanner.restore(frozen).descriptor(),frozen)
        AgentCompiler.validate(result['snapshot']['compiled_agent'])
        snapshot=deepcopy(result['snapshot']);snapshot['compiled_agent']['execution_protocol']['schema_hash']='tampered'
        with self.assertRaisesRegex(ValueError,'protocol'):domain_for(snapshot)
    def test_direct_turn_does_not_infer_fixed_workflow_experience(self):
        runtime,result,_=self.run_model()
        library=Library(runtime.store);owner=Access.task(result['task'])
        self.assertFalse(any(a['kind']=='EXPERIENCE' for a in library.list(owner,include_unpublished=True)))
        with runtime.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM episodic_memories').fetchone()[0],1)

class ModelStreamTests(unittest.TestCase):
    def process(self,script):
        process=subprocess.Popen([sys.executable,'-u','-c',script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        self.addCleanup(lambda:process.poll() is None and process.kill())
        return process
    def test_live_public_progress_arrives_before_cli_completion_and_private_reasoning_is_dropped(self):
        process=self.process("import sys,json,time;sys.stdin.read();print(json.dumps({'type':'turn.started'}),flush=True);print(json.dumps({'type':'item.completed','item':{'type':'reasoning','text':'PRIVATE_REASONING_SECRET','summary':[{'type':'summary_text','text':'已识别用户的交付要求。'}]}}),flush=True);time.sleep(.25);print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}),flush=True)")
        progress=[];observed=[]
        stdout,stderr=collect(process,'goal',2,'codex',lambda event:(progress.append(event),observed.append(process.poll())))
        self.assertIsNone(observed[0]);self.assertIn('turn.completed',stdout)
        self.assertIn('已识别用户',json.dumps(progress,ensure_ascii=False));self.assertNotIn('PRIVATE_REASONING_SECRET',json.dumps(progress))
    def test_qoder_and_cursor_thinking_is_never_promoted_to_public_text(self):
        for provider in ('qoder','cursor'):
            progress=[];parser=PublicProgress(provider,progress.append)
            parser.feed({'type':'thinking','text':'PRIVATE_ONE'})
            parser.feed({'type':'assistant','message':{'content':[{'type':'thinking','thinking':'PRIVATE_TWO'},{'type':'text','text':'正在核对已提供的信息。'}]}})
            parser.feed({'type':'assistant','message':{'content':[{'type':'text','text':'{"kind":"result","summary":"已整理邮件。","result":{"content":"交付正文"}}'}]}})
            wire=json.dumps(progress,ensure_ascii=False)
            self.assertNotIn('PRIVATE',wire);self.assertIn('正在核对',wire);self.assertIn('已整理邮件',wire)
    def test_timeout_and_cancellation_terminate_child_without_waiting_for_stdout(self):
        for cancelled in (False,True):
            process=self.process('import time;time.sleep(10)')
            started=time.monotonic()
            with self.assertRaisesRegex(ModelError,'task_cancelled' if cancelled else 'model_timeout'):
                collect(process,'',.15,'qoder',lambda data:None,cancel=lambda:cancelled)
            self.assertIsNotNone(process.poll());self.assertLess(time.monotonic()-started,2)
    def test_both_pipes_are_drained_and_output_budget_is_enforced(self):
        process=self.process("import sys,json;sys.stdin.read();sys.stderr.write('x'*200000);sys.stderr.flush();print(json.dumps({'type':'turn.started'}),flush=True)")
        progress=[];stdout,stderr=collect(process,'',2,'codex',progress.append)
        self.assertTrue(progress);self.assertLessEqual(len(stderr),65536)
        process=self.process("print('x'*8192,flush=True)")
        with patch('agent_framework.model_stream.LIMIT',1024),self.assertRaisesRegex(ModelError,'invalid_model_envelope'):
            collect(process,'',2,'codex',lambda data:None)
    def test_observer_failure_stops_cli_and_preserves_failure(self):
        process=self.process("import json,time;print(json.dumps({'type':'turn.started'}),flush=True);time.sleep(10)")
        def stale(data):raise RuntimeError('lease lost')
        with self.assertRaisesRegex(RuntimeError,'lease lost'):collect(process,'',2,'codex',stale)
        self.assertIsNotNone(process.poll())

if __name__=='__main__':unittest.main()
