"""Every actual model request rechecks governed context, including format retries."""
from collections import Counter
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical,digest
from agent_framework.llm import CodexConfig,LLMPlanner
from agent_framework.runtime import Runtime
from agent_framework.knowledge import Access,Library
from tests import test_task_conversations as fixtures


class ModelContextRefreshTests(unittest.TestCase):
    setUp=fixtures.TaskConversationTests.setUp
    start=fixtures.TaskConversationTests.start
    wait=fixtures.TaskConversationTests.wait
    send=fixtures.TaskConversationTests.send

    def install(self,history=False,on_reject=None):
        library=Library(self.app.control_store);owner=self.app.library_access()
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'会议规则','content':{'text':'RETRY_PRIVATE_SENTINEL：会议规则。'}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        attempts=Counter()
        def generate(transport,prompt,schema,config,timeout):
            request=json.loads(prompt[prompt.index('\n{')+1:]);self.fixture.requests.append(deepcopy(request))
            context=request['context'];turn=context['task']['conversation_context']['turn'];attempts[turn]+=1
            if turn==(2 if history else 1) and attempts[turn]==1:
                self.assertIn('RETRY_PRIVATE_SENTINEL',canonical(context))
                if on_reject:on_reject(library,owner,source,request)
                else:library.transition(owner,source['ref'],'WITHDRAWN')
                return '{"broken":',{'usage':{'input_tokens':2,'output_tokens':1}}
            result={'title':'结果','content':'请按当前有效资料处理。','citations':[],'limitations':[]}
            if history and turn==1:
                doc=next(d for d in context['knowledge'] if d['ref']==source['ref'])
                result['content']=doc['content']['text']
                result['citations']=[{'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'quote':doc['content']['text'],'evidence_ref':context['context_manifest']['id']}]
            return json.dumps({'kind':'result','summary':'已处理。','result':result},ensure_ascii=False),{'usage':{'input_tokens':2,'output_tokens':1}}
        self.fixture.generate=generate
        return library,owner,source

    def test_format_retry_rechecks_current_optional_knowledge(self):
        self.install();root=self.start('会议规则');self.wait(root,status='SUCCEEDED')
        self.assertEqual(len(self.fixture.requests),2)
        self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(self.fixture.requests[-1]['context']))

    def test_format_retry_rechecks_historical_source_dependencies(self):
        self.install(history=True);root=self.start('会议规则');self.wait(root,status='SUCCEEDED')
        self.send(root,'继续整理');self.wait(root,2,'SUCCEEDED')
        self.assertEqual(len(self.fixture.requests),3)
        self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(self.fixture.requests[-1]['context']))
        self.assertIn('来源已失效',canonical(self.fixture.requests[-1]['context']))

    def assert_request_manifests(self,root,expected):
        detail=self.app.detail(root);child=detail['conversation']['active_run_id']
        manifests=self.app.control_store.contexts(self.app.tenant,child)
        requested=[event['data'] for event in self.app.control_store.events(self.app.tenant,child) if event['kind']=='model.requested']
        self.assertEqual(len(manifests),expected);self.assertEqual(len(requested),expected)
        self.assertEqual(len({m['id'] for m in manifests}),expected)
        for event,request in zip(requested,self.fixture.requests[-expected:]):
            metadata=request['context']['context_manifest'];manifest=next(m for m in manifests if m['id']==metadata['id'])
            self.assertEqual(event['context_manifest_id'],manifest['id']);self.assertEqual(event['context_manifest_hash'],manifest['hash'])
            self.assertEqual(metadata['hash'],manifest['hash']);self.assertEqual(manifest['hash'],digest({k:v for k,v in manifest.items() if k!='hash'}))
            self.assertEqual(manifest['model_attempt'],event['attempt']);self.assertEqual(manifest['phase'],request['phase'])
            self.assertEqual(manifest['conversation_context_hash'],digest(request['context']['task']['conversation_context']))
        return manifests,requested

    def test_each_retry_has_a_distinct_auditable_manifest_and_accurate_usage(self):
        self.install();root=self.start('会议规则');detail=self.wait(root,status='SUCCEEDED')
        manifests,events=self.assert_request_manifests(root,2)
        self.assertEqual([e['attempt'] for e in events],[1,2]);self.assertNotEqual(manifests[0]['hash'],manifests[1]['hash'])
        self.assertEqual(detail['run']['model_calls'],2);self.assertEqual(detail['run']['model_tokens'],6)
        self.assertTrue(self.fixture.requests[-1]['format_feedback']);self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(self.fixture.requests[-1]))

    def required_workflow_retry(self):
        # Required standards belong to the legacy workflow; conversations deliberately
        # treat knowledge as optional. Exercise the real frozen workflow binding.
        runtime=Runtime(self.temp.name,planner=LLMPlanner(CodexConfig('fixture','low',timeout=5,max_attempts=2)))
        state=runtime.submit();required=state['snapshot']['context_policy']['required_assets'][0]
        library=Library(runtime.store);owner=Access('tenant-demo','kurt','project-demo',roles=('curator','reviewer'))
        def generate(transport,prompt,schema,config,timeout):
            request=json.loads(prompt[prompt.index('\n{')+1:]);self.fixture.requests.append(deepcopy(request))
            library.transition(owner,required['ref'],'WITHDRAWN')
            return '{"broken":',{'usage':{'input_tokens':2,'output_tokens':1}}
        self.fixture.generate=generate
        return runtime,runtime.run(state['run_id'])

    def test_required_source_withdrawal_blocks_retry_without_counting_an_unsent_call(self):
        runtime,state=self.required_workflow_retry()
        self.assertEqual(state['status'],'WAITING_INPUT');self.assertIn('required knowledge',state['last_error'])
        self.assertEqual(len(self.fixture.requests),1);self.assertEqual(state['model_calls'],1)
        manifests=runtime.store.contexts(state['tenant_id'],state['run_id']);self.assertEqual(len(manifests),1)
        self.assertEqual(manifests[0]['phase'],'plan');self.assertEqual(manifests[0]['model_attempt'],1)

    def test_cancellation_between_attempts_prevents_second_request(self):
        def cancel(library,owner,source,request):
            self.app.control_store.request_cancellation(self.app.tenant,request['context']['task']['conversation_context']['task_id'],principal=self.app.principal)
        self.install(on_reject=cancel);root=self.start('会议规则');detail=self.wait(root,status='CANCELLED')
        self.assertEqual(len(self.fixture.requests),1);self.assertEqual(detail['run']['model_calls'],1)
        self.assert_request_manifests(root,1)

    def test_call_budget_stops_retry_before_building_an_unused_manifest(self):
        self.install(on_reject=lambda *args:None)
        with patch.object(self.app,'schedule'):root=self.start('会议规则')
        state=self.app.control_store.load(self.app.tenant,root);state['task']['budget']['max_model_calls']=1
        with self.app.control_store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,root))
        runtime=self.app.runtime(LLMPlanner.restore(state['snapshot']['planner']));result=runtime.run(root)
        self.assertEqual(result['status'],'EXPIRED');self.assertIn('model_call_budget',result['last_error'])
        self.assertEqual(len(self.fixture.requests),1);self.assert_request_manifests(root,1)
        self.assertIsNone(runtime.planner.prepare_context);self.assertIsNone(runtime.planner.observer)

    def test_new_published_version_is_available_to_retry(self):
        versions=[]
        def publish(library,owner,source,request):
            newer=library.create(owner,{'id':source['id'],'kind':'KNOWLEDGE','title':'会议规则','content':{'text':'CURRENT_VERSION_SENTINEL：会议规则新版本。'}})
            library.transition(owner,newer['ref'],'REVIEW');library.transition(owner,newer['ref'],'PUBLISHED');versions.append(newer['ref'])
        self.install(on_reject=publish);root=self.start('会议规则');self.wait(root,status='SUCCEEDED')
        context=self.fixture.requests[-1]['context'];self.assertIn('CURRENT_VERSION_SENTINEL',canonical(context))
        self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(context));self.assertIn(versions[0],[d['ref'] for d in context['knowledge']])
        self.assert_request_manifests(root,2)

    def test_request_hooks_and_governed_session_are_cleared_after_context_failure(self):
        runtime,state=self.required_workflow_retry();self.assertEqual(state['status'],'WAITING_INPUT')
        planner=runtime.planner
        self.assertIsNone(planner.prepare_context);self.assertIsNone(planner.observer)
        self.assertIsNone(planner.transport.governed_profile);self.assertIsNone(planner.transport.should_cancel)

    def skill_phases(self,native=False):
        from tests.test_skill_packages import package,agent_data
        from agent_framework.definitions import default_definition
        from agent_framework.history_dependencies import dependencies
        from agent_framework.read_proxy import ReadCapabilityProxy
        library,owner,source=self.install();registry=self.app.skills();skill=registry.save(package('refresh-check'))
        skill=registry.lifecycle(skill['id'],skill['revision'],'publish',skill['version'])
        data=agent_data([{'skill_id':skill['id'],'version':skill['version'],'enabled':True}],'codex')
        data.update(model='fixture',definition=default_definition('上下文核对','general-assistant@1.0.0'))
        data['definition']['native_read_refs']=['knowledge.read@1.0.0']
        self.agent=self.app.agents.save(data)
        def generate(transport,prompt,schema,config,timeout):
            request=json.loads(prompt[prompt.index('\n{')+1:]);self.fixture.requests.append(deepcopy(request));context=request['context'];phase=request['phase']
            ref=context['configured_agent']['available_skills'][0]['ref']
            if phase=='skill_activate':
                self.assertIn('RETRY_PRIVATE_SENTINEL',canonical(context))
                if native:
                    token=transport.governed_profile['mcp_servers'][0]['args'][-1]
                    ReadCapabilityProxy(self.temp.name).call(token,'knowledge_read',{'project_id':owner.project,'asset_refs':[source['ref']]})
                library.transition(owner,source['ref'],'WITHDRAWN');value={'activate':[ref]}
            elif phase=='skill_resources':
                self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(context));self.assertTrue(context['activated_skills']);value={'reads':[{'ref':ref,'path':'references/check.md'}]}
            else:
                self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(context));self.assertIn('REF_ONLY_AFTER_READ',canonical(context['activated_skills']))
                value={'kind':'result','summary':'已核对。','result':{'title':'结果','content':'按当前资料处理。','citations':[],'limitations':[]}}
            return json.dumps(value,ensure_ascii=False),{'usage':{'input_tokens':2,'output_tokens':1}}
        self.fixture.generate=generate;root=self.start('会议规则 $refresh-check');detail=self.wait(root,status='SUCCEEDED')
        self.assertEqual([r['phase'] for r in self.fixture.requests],['skill_activate','skill_resources','execute'])
        self.assertEqual(detail['run']['model_calls'],3);self.assert_request_manifests(root,3)
        self.assertEqual(len(detail['run']['native_reads']),int(native))
        with self.app.control_store.read_snapshot() as db:
            lineage=dependencies(self.app.control_store,db,self.app.tenant,self.app.principal,owner.project,[root])[root]
        self.assertTrue(lineage['valid']);self.assertEqual(lineage['sources'],[{'asset_ref':source['ref'],'content_hash':source['content_hash']}])

    def test_skill_phases_refresh_sources_and_preserve_disclosed_resources(self):
        self.skill_phases()

    def test_skill_phase_can_read_already_supplied_knowledge(self):
        self.skill_phases(native=True)

    def native_retry(self,revoke):
        from agent_framework.definitions import default_definition
        from agent_framework.read_proxy import ReadCapabilityProxy
        library,owner,source=self.install();definition=default_definition('重试读取助手','general-assistant@1.0.0')
        definition['native_read_refs']=['knowledge.read@1.0.0']
        self.agent=self.app.agents.save({'name':'重试读取助手','description':'隔离验收','runtime':'codex','model':'fixture','options':{'timeout':5,'max_attempts':2,'reasoning_effort':'low'},
            'prompt':'按当前资料处理。','skills':[],'mcp_servers':[],'revision':0,'definition':definition})
        observed=[]
        def generate(transport,prompt,schema,config,timeout):
            request=json.loads(prompt[prompt.index('\n{')+1:]);self.fixture.requests.append(deepcopy(request))
            if len(self.fixture.requests)==1:
                token=transport.governed_profile['mcp_servers'][0]['args'][-1]
                observed.append(ReadCapabilityProxy(self.temp.name).call(token,'knowledge_read',{'project_id':owner.project,'asset_refs':[source['ref']]}))
                if revoke:library.transition(owner,source['ref'],'WITHDRAWN')
                return '{"broken":',{'usage':{'input_tokens':1,'output_tokens':1}}
            result={'kind':'result','summary':'已重新核对。','result':{'title':'结果','content':'已按当前有效信息处理。','citations':[],'limitations':[]}}
            return json.dumps(result,ensure_ascii=False),{'usage':{'input_tokens':1,'output_tokens':1}}
        self.fixture.generate=generate;root=self.start('会议规则');detail=self.wait(root,status='SUCCEEDED')
        context=self.fixture.requests[-1]['context'];ref=observed[0]['evidence_ref']
        if revoke:
            self.assertNotIn(ref,context['evidence']);self.assertNotIn('RETRY_PRIVATE_SENTINEL',canonical(context))
        else:
            self.assertIn(ref,context['evidence']);self.assertEqual(context['evidence'][ref]['data'],observed[0]['data'])
        self.assertEqual(len(detail['run']['native_reads']),1);self.assertEqual(detail['run']['model_calls'],2)
        self.assert_request_manifests(root,2)

    def test_retry_receives_valid_native_evidence_without_repeating_the_read(self):
        self.native_retry(False)

    def test_retry_removes_withdrawn_native_evidence(self):
        self.native_retry(True)


if __name__=='__main__':unittest.main()
