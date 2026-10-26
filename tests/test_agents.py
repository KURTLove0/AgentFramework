"""Agent CRUD, frozen execution and explicit native MCP configuration contracts."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.agents import AgentRegistry, agent_ref, validate_extensions
from agent_framework.agent_extensions import codex_mcp_args, cursor_mcp_config, allowed_mcp_call
from agent_framework.contracts import TaskContract, TOOLS
from agent_framework.definitions import default_definition
from agent_framework.llm import CodexConfig, CursorConfig, LLMPlanner, SYSTEM, CURSOR_POLICY
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime import CrashInjected, Runtime
from agent_framework.runtime_config import ConfigConflict, RuntimeConfiguration
from agent_framework.web import Application
from test_llm import FixtureTransport

MCP={'name':'facts','transport':'stdio','command':'python3','args':['mock_mcp.py'],'url':'','env_vars':['FACTS_TOKEN'],'bearer_env':'','tools':['lookup'],'enabled':True}


def definition(provider='codex'):
    return {'name':'评估专家','description':'只处理模拟变更','runtime':provider,'model':'fixture-model' if provider!='mock' else 'builtin',
            'options':({'timeout':5,'max_attempts':2}|({'reasoning_effort':'low'} if provider=='codex' else {})) if provider!='mock' else {},
            'prompt':'使用简洁中文，明确列出证据缺口。','skills':[{'name':'风险方法','instructions':'先核对测试，再形成建议。','enabled':True},
            {'name':'未启用方法','instructions':'这一段不发送给模型。','enabled':False}],'mcp_servers':[],'revision':0}


class ConfiguredFixture(FixtureTransport):
    def generate(self,prompt,*args):
        wire=prompt[prompt.index('\n{')+1:]
        return super().generate(SYSTEM+'\n'+wire,*args)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.app=Application(self.temp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(self.app.close)
        self.catalog=patch.object(ModelCatalog,'list',return_value={'models':[{'id':'fixture-model','name':'Fixture','efforts':['low']}],'source':'fixture CLI'})
        self.catalog.start();self.addCleanup(self.catalog.stop)

    def test_create_edit_archive_tenant_and_version_conflicts(self):
        profile=self.app.agents.save(definition())
        self.assertEqual(profile['revision'],1)
        registry=AgentRegistry(self.temp.name,'another',self.app.configuration,self.app.models)
        self.assertEqual(registry.list(),[])
        with self.assertRaises(KeyError):registry.get(profile['id'])
        data=definition();data['revision']=1;data['prompt']='修改后的 Prompt'
        edited=self.app.agents.save(data,profile['id']);self.assertEqual(edited['revision'],2)
        with self.assertRaises(ConfigConflict):self.app.agents.save(data,profile['id'])
        archived=self.app.agents.archive(profile['id'],2)
        self.assertTrue(archived['archived'])
        with self.assertRaisesRegex(ValueError,'归档'):self.app.agents.planner(archived)
        restored=self.app.agents.archive(profile['id'],3,False)
        self.assertFalse(restored['archived'])
        self.assertEqual(restored['revision'],4)
        with self.assertRaises(KeyError):self.app.agents.save(definition(),'agent-0000000000000000')

    def test_agent_identity_needs_no_team_and_legacy_team_survives_edits(self):
        for domain in ('change-assessment@2.0.0', 'knowledge-answer@1.0.0'):
            with self.subTest(domain=domain):
                data=definition('mock');data['definition']=default_definition(data['name'],domain)
                saved=self.app.agents.save(data)
                self.assertNotIn('owner_team',saved['definition']['identity'])
                compiled=self.app.agents.compile(saved['id'])
                self.assertEqual(compiled['definition']['identity'],saved['definition']['identity'])
                data['revision']=1;data['name']='更新岗位'
                edited=self.app.agents.save(data,saved['id'])
                self.assertEqual(edited['definition']['identity']['name'],'更新岗位')
                self.assertNotIn('owner_team',edited['definition']['identity'])
        legacy=definition('mock');legacy['definition']=default_definition(legacy['name'])
        legacy['definition']['identity']['owner_team']='历史团队'
        saved=self.app.agents.save(legacy)
        legacy.pop('definition');legacy['revision']=1
        edited=self.app.agents.save(legacy,saved['id'])
        self.assertEqual(edited['definition']['identity']['owner_team'],'历史团队')

    def test_unpublished_domain_is_rejected_before_saving_or_updating(self):
        data=definition('mock');data['definition']=default_definition(data['name'])
        saved=self.app.agents.save(data)
        data['definition']['domain_pack_ref']='custom-domain@1.0.0'
        with self.assertRaisesRegex(ValueError,'工作方式'):
            self.app.agents.save(data)
        data['revision']=1
        with self.assertRaisesRegex(ValueError,'工作方式'):
            self.app.agents.save(data,saved['id'])
        self.assertEqual(self.app.agents.list(),[saved])

    def test_models_must_be_from_cli_and_mcp_definitions_are_validated(self):
        bad=definition();bad['model']='made-up-model'
        with self.assertRaises(ValueError):self.app.agents.save(bad)
        bad=definition();bad['options']['reasoning_effort']='high'
        with self.assertRaisesRegex(ValueError,'推理强度'):self.app.agents.save(bad)
        for field,value in [('env_vars',['TOKEN=secret']),('name','bad.server'),('tools',['*']),('transport','shell')]:
            bad=definition();bad['mcp_servers']=[deepcopy(MCP)];bad['mcp_servers'][0][field]=value
            with self.assertRaises(ValueError):self.app.agents.save(bad)
        bad=definition('mock');bad['mcp_servers']=[deepcopy(MCP)]
        with self.assertRaises(ValueError):self.app.agents.save(bad)
        bad=definition();bad['mcp_servers']=[deepcopy(MCP)|{'command':'/missing/agent-framework-mcp'}]
        with self.assertRaisesRegex(ValueError,'可执行命令'):self.app.agents.save(bad)

    def test_agent_prompt_policy_is_unambiguous_and_old_snapshots_still_restore(self):
        agent=self.app.agents.save(definition())
        current=LLMPlanner(CodexConfig('fixture-model','low'),agent_profile=agent)
        self.assertNotIn('Do not invoke any tools',current.system_prompt())
        self.assertIn('ONLY the native MCP tools',current.system_prompt())
        self.assertEqual(LLMPlanner.restore(current.descriptor()).descriptor(),current.descriptor())
        legacy=LLMPlanner(CodexConfig('fixture-model','low'),agent_profile=agent,agent_prompt_version=1)
        self.assertNotIn('agent_prompt_version',legacy.descriptor())
        self.assertIn('Do not invoke any tools',legacy.system_prompt())
        self.assertEqual(LLMPlanner.restore(legacy.descriptor()).descriptor(),legacy.descriptor())
        previous=LLMPlanner(CodexConfig('fixture-model','low'),agent_profile=agent,agent_prompt_version=2)
        self.assertEqual(LLMPlanner.restore(previous.descriptor()).descriptor(),previous.descriptor())

    def test_task_agent_revision_and_separate_mcp_consent(self):
        data=definition();data['definition']=default_definition(data['name']);data['definition']['native_read_refs']=[TOOLS[0]]
        agent=self.app.agents.save(data)
        task={'agent_id':agent['id'],'agent_revision':1,'start':False,'consent':True}
        with self.assertRaisesRegex(Exception,'MCP'):self.app.create(task)
        run=self.app.create(task|{'mcp_consent':True})['run']
        self.assertEqual(run['task']['agent_ref'],agent_ref(agent))
        self.assertEqual(run['snapshot']['agent_profile'],agent)
        summary=self.app.summary(run)
        self.assertEqual((summary['agent_id'],summary['agent_revision']),(agent['id'],1))
        edited=definition();edited['revision']=1;edited['prompt']='新 Prompt'
        self.app.agents.save(edited,agent['id'])
        with self.assertRaises(ConfigConflict):self.app.create(task|{'mcp_consent':True})
        self.assertEqual(self.app.detail(run['run_id'])['run']['snapshot']['agent_profile']['prompt'],data['prompt'])
        self.assertEqual(self.app.summary(run)['agent_revision'],1)

    def test_prompt_skills_and_mcp_metadata_reach_planning_without_secrets(self):
        data=definition();data['definition']=default_definition(data['name']);data['definition']['native_read_refs']=[TOOLS[0]]
        agent=self.app.agents.save(data);fixture=ConfiguredFixture()
        planner=LLMPlanner(CodexConfig('fixture-model','low',timeout=5),fixture,agent_profile=agent)
        runtime=Runtime(self.temp.name,planner=planner)
        state=runtime.submit(TaskContract(agent_ref=agent_ref(agent)),agent_profile=agent)
        result=runtime.run(state['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        configured=fixture.requests[0]['context']['configured_agent']
        self.assertEqual(configured['prompt'],data['prompt'])
        self.assertEqual(len(configured['skills']),1)
        self.assertEqual(configured['mcp_tools'],[{'server':'governed','tools':['change_read']}])
        self.assertNotIn('FACTS_TOKEN',json.dumps(configured))
        self.assertNotIn('mock_mcp.py',json.dumps(configured))
        self.assertEqual(len(runtime.external.stats('tenant-demo',state['run_id'])['drafts']),1)

    def test_custom_cursor_frozen_agent_restores_and_never_recreates(self):
        agent=self.app.agents.save(definition('cursor'));fixture=ConfiguredFixture()
        planner=LLMPlanner(CursorConfig('fixture-model',timeout=5),fixture,agent_profile=agent)
        runtime=Runtime(self.temp.name,planner=planner,lease_seconds=.5,tool_timeout=.2)
        state=runtime.submit(TaskContract(agent_ref=agent_ref(agent)),scenario='crash-after-write',agent_profile=agent)
        with self.assertRaises(CrashInjected):runtime.run(state['run_id'])
        edited=definition('codex');edited['revision']=1;edited['prompt']='后续 Agent 配置'
        self.app.agents.save(edited,agent['id'])
        time.sleep(.55)
        with patch('agent_framework.llm.CursorTransport.generate',side_effect=fixture.generate):
            result=Runtime(self.temp.name).run(state['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        self.assertEqual(result['snapshot']['agent_profile']['revision'],1)
        self.assertEqual(result['snapshot']['planner_ref'],'cursor-planner@1.0.0')
        external=runtime.external.stats('tenant-demo',state['run_id'])
        self.assertEqual(external['calls']['report.draft.create@1.0.0'],1)
        self.assertEqual(len(external['drafts']),1)

    def test_business_authorization_and_readback_still_apply_to_custom_agents(self):
        agent=self.app.agents.save(definition())
        for scenario in ('denied','tampered-draft'):
            runtime=Runtime(self.temp.name,planner=LLMPlanner(CodexConfig('fixture-model','low',timeout=5),ConfiguredFixture(),agent_profile=agent))
            state=runtime.submit(TaskContract(agent_ref=agent_ref(agent)),scenario=scenario,agent_profile=agent)
            result=runtime.run(state['run_id'])
            self.assertEqual(result['status'],'WAITING_AUTH' if scenario=='denied' else 'NEEDS_REVIEW')
            self.assertEqual(len(runtime.external.stats('tenant-demo',state['run_id'])['drafts']),0 if scenario=='denied' else 1)


class NativeMCPTests(unittest.TestCase):
    def test_http_credentials_are_environment_references_and_missing_values_fail(self):
        server=deepcopy(MCP)|{'transport':'http','command':'','args':[],'env_vars':[],
                              'url':'https://example.invalid/mcp','bearer_env':'MCP_DEMO_AUTH'}
        profile={'mcp_servers':[server]}
        flags=codex_mcp_args(profile)
        self.assertIn('mcp_servers.facts.url="https://example.invalid/mcp"',flags)
        self.assertIn('mcp_servers.facts.bearer_token_env_var="MCP_DEMO_AUTH"',flags)
        with patch.dict('os.environ',{'MCP_DEMO_AUTH':'synthetic-token'}):
            config,policy=cursor_mcp_config(profile,CURSOR_POLICY,{})
        self.assertEqual(config['mcpServers']['facts']['headers'],{'Authorization':'Bearer synthetic-token'})
        self.assertNotIn('synthetic-token',' '.join(flags))
        self.assertIn('Mcp(*:*)',CURSOR_POLICY['permissions']['deny'])
        self.assertEqual(policy['permissions']['allow'],['Mcp(facts:lookup)'])
        with patch.dict('os.environ',{},clear=True):
            with self.assertRaisesRegex(ValueError,'环境变量'):cursor_mcp_config(profile,CURSOR_POLICY,{})

    def test_only_enabled_servers_and_explicit_tools_are_exposed(self):
        profile={'mcp_servers':[deepcopy(MCP),deepcopy(MCP)|{'name':'disabled','enabled':False}]}
        flags=codex_mcp_args(profile)
        self.assertIn('mcp_servers.facts.command="python3"',flags)
        self.assertFalse(any('disabled' in s for s in flags))
        self.assertIn('mcp_servers.facts.enabled_tools=["lookup"]',flags)
        self.assertIn('mcp_servers.facts.required=true',flags)
        with patch.dict('os.environ',{'FACTS_TOKEN':'runtime-secret'}):
            mcp,policy=cursor_mcp_config(profile,CURSOR_POLICY,{'other':{}})
        self.assertTrue(mcp['mcpServers']['other']['disabled'])
        self.assertEqual(mcp['mcpServers']['facts']['env'],{'FACTS_TOKEN':'runtime-secret'})
        self.assertEqual(policy['permissions']['allow'],['Mcp(facts:lookup)'])
        self.assertIn('Shell(*)',policy['permissions']['deny'])
        self.assertEqual(allowed_mcp_call({'type':'mcp_tool_call','server':'facts','tool':'lookup'},profile),{'server':'facts','tool':'lookup'})
        self.assertIsNone(allowed_mcp_call({'type':'mcp_tool_call','server':'facts','tool':'write'},profile))
        self.assertIsNone(allowed_mcp_call({'type':'command_execution'},profile))
        cursor={'tool_call':{'mcpToolCall':{'args':{'providerIdentifier':'facts','toolName':'lookup'}}}}
        self.assertIsNotNone(allowed_mcp_call(cursor,profile,True))


if __name__=='__main__':unittest.main()
