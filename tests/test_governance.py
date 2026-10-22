"""P0 compilation, transport boundaries and unchanged legacy recovery contracts."""
from copy import deepcopy
from dataclasses import asdict
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import ActionProposal, Budget, PolicyDenied, TaskContract, TOOLS, digest
from agent_framework.definitions import ADAPTERS, AgentCompiler, DOMAIN, default_definition, capability_definitions
from agent_framework.llm import CodexConfig, CodexTransport, LLMPlanner, ModelError
from agent_framework.read_proxy import ReadCapabilityProxy
from agent_framework.runtime import CrashInjected, Runtime, legacy_registry_snapshot
from test_agents import definition, ConfiguredFixture, MCP


def profile(adapter=ADAPTERS[0], native=False):
    p = definition('mock') | {'id': 'agent-0123456789abcdef', 'revision': 1, 'archived': False}
    p['definition'] = default_definition(p['name'])
    p['definition']['adapter_bindings'] = {ref: adapter for ref in TOOLS}
    if native:
        p['definition']['native_read_refs'] = [TOOLS[0], TOOLS[1]]
    return p


class CompilationTests(unittest.TestCase):
    def test_compiles_role_dependencies_versions_and_immutable_hash(self):
        p = profile()
        c = AgentCompiler().compile(p)
        AgentCompiler.validate(c)
        self.assertEqual(c['definition']['identity']['role'], 'release_reviewer')
        self.assertEqual(c['domain_pack']['ref'], 'change-assessment@2.0.0')
        self.assertEqual(set(c['capabilities']), set(TOOLS))
        self.assertEqual(c['capabilities'][TOOLS[2]]['effect'], 'WRITE')
        self.assertEqual(c['capabilities'][TOOLS[2]]['reconcile_ref'], TOOLS[3])
        self.assertEqual(c['skills'][1]['kind'], 'instructions-only')
        p['skills'][0]['instructions'] = 'edited'
        self.assertNotEqual(c['hash'], AgentCompiler().compile(p)['hash'])
        self.assertNotEqual(c['skills'][1]['instructions'], p['skills'][0]['instructions'])

    def test_rejects_unpublished_and_incomplete_dependency_graphs(self):
        cases = [
            ('domain_pack_ref', 'other@1'), ('policy_ref', 'arbitrary@1'),
            ('runtime_profile_ref', 'unknown@1'), ('prompt_template_ref', 'unknown@1'),
            ('standard_refs', ['narrative-only@1']), ('knowledge_spaces', ['private@1']),
            ('skill_refs', ['cycle@1']), ('capability_refs', list(TOOLS[:3])),
            ('capability_refs', list(TOOLS) + ['shell.exec@1']),
            ('adapter_bindings', {TOOLS[2]: 'arbitrary-shell@1'}),
            ('native_read_refs', [TOOLS[2]]), ('native_read_refs', ['unknown@1'])]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                p = profile(); p['definition'][key] = value
                with self.assertRaises(ValueError): AgentCompiler().compile(p)
        for field, value in [('deliverable_ref', 'unknown@1'), ('check_refs', ['model-says-done'])]:
            p = profile(); p['definition']['responsibilities'][0][field] = value
            with self.assertRaises(ValueError): AgentCompiler().compile(p)
        p = profile(); p['definition']['responsibilities'] = p['definition']['responsibilities'][:1]
        with self.assertRaises(ValueError): AgentCompiler().compile(p)

    def test_legacy_mcp_configuration_never_reaches_the_cli_after_restore(self):
        p = profile(); p.pop('definition'); p['mcp_servers'] = [deepcopy(MCP)]
        planner = LLMPlanner(CodexConfig('fixture','low'), agent_profile=p, agent_prompt_version=3)
        restored = LLMPlanner.restore(planner.descriptor())
        self.assertEqual(restored.descriptor(), planner.descriptor())
        with patch('agent_framework.llm.subprocess.Popen') as popen:
            with self.assertRaises(ModelError):
                restored.transport.generate('synthetic',{},restored.config,1)
            popen.assert_not_called()

    def test_unclassified_native_endpoints_cannot_be_compiled_or_spawned(self):
        p = profile(); p['runtime'] = 'codex'; p['mcp_servers'] = [deepcopy(MCP)]
        with self.assertRaisesRegex(ValueError, 'MCP'): AgentCompiler().compile(p)
        with patch('agent_framework.llm.subprocess.Popen') as popen:
            with self.assertRaisesRegex(ModelError, 'legacy_mcp_effect_unclassified'):
                CodexTransport(p).generate('synthetic', {}, CodexConfig('fixture'), 1)
            popen.assert_not_called()

    def test_compiler_rejects_unknown_effect_and_incomplete_write_contracts(self):
        for key, value in [('effect','UNKNOWN'),('phase','PERCEIVE'),('reconcile_ref',None),('idempotency','none')]:
            with self.subTest(key=key):
                registry=capability_definitions_original()
                registry[TOOLS[2]][key]=value
                with patch('agent_framework.definitions.capability_definitions',return_value=registry):
                    with self.assertRaises(ValueError):AgentCompiler().compile(profile())

    def test_schema_or_effect_drift_invalidates_frozen_binding(self):
        c = AgentCompiler().compile(profile())
        with patch('agent_framework.definitions.capability_definitions') as definitions:
            registry = capability_definitions_original()
            registry[TOOLS[0]]['effect'] = 'UNKNOWN'
            definitions.return_value = registry
            with self.assertRaises(PolicyDenied): AgentCompiler.validate(c)
        c = AgentCompiler().compile(profile())
        c['domain_pack']['artifact_schema']['required'].append('changed')
        c['hash'] = digest({k:v for k,v in c.items() if k != 'hash'})
        with self.assertRaises(ValueError): AgentCompiler.validate(c)


capability_definitions_original = capability_definitions


class GovernanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.runtime = Runtime(self.tmp.name, lease_seconds=.5, tool_timeout=.2)

    def submit(self, scenario='normal', p=None, legacy=False):
        task = TaskContract(agent_ref=(p['id'] + '@1') if p else 'release-assistant@1.0.0')
        if legacy:
            self.runtime.external.seed(task.to_dict())
            return self.runtime.store.create(task, legacy_registry_snapshot(self.runtime.planner, p), scenario, grant=scenario != 'denied')
        return self.runtime.submit(task, scenario=scenario, agent_profile=p)

    def test_protocols_all_preserve_authorization_acceptance_and_idempotency(self):
        for adapter in ADAPTERS:
            for scenario, expected, drafts in [('normal','SUCCEEDED',1), ('response-lost','SUCCEEDED',1),
                                              ('denied','WAITING_AUTH',0), ('tampered-draft','NEEDS_REVIEW',1)]:
                with self.subTest(adapter=adapter, scenario=scenario):
                    state = self.submit(scenario, profile(adapter))
                    result = self.runtime.run(state['run_id'])
                    stats = self.runtime.external.stats('tenant-demo', state['run_id'])
                    self.assertEqual(result['status'], expected)
                    self.assertEqual(len(stats['drafts']), drafts)
                    self.assertEqual(stats['calls'].get(TOOLS[2], 0), drafts)
                    self.assertEqual(len(result['checks']) == 3 and all(c['passed'] for c in result['checks'].values()), expected == 'SUCCEEDED')
                    self.assertEqual(result['snapshot']['hash'], state['snapshot']['hash'])

    def test_legacy_prepared_action_resumes_with_same_hash_and_current_grant(self):
        state = self.submit('denied', legacy=True)
        result = self.runtime.run(state['run_id'])
        prepared = next(a for a in result['actions'] if a['status'] == 'PREPARED')
        self.assertNotIn('capability_hash', prepared)
        self.runtime.store.grant(result, prepared['args_hash'])
        resumed = Runtime(self.tmp.name).run(state['run_id'])
        after = next(a for a in resumed['actions'] if a['logical_id'] == prepared['logical_id'])
        self.assertEqual(resumed['status'], 'SUCCEEDED')
        self.assertEqual(prepared['args'], after['args'])
        self.assertEqual(prepared['args_hash'], after['args_hash'])
        self.assertEqual(resumed['snapshot'], state['snapshot'])
        self.assertNotIn('compiled_agent', resumed['snapshot'])

    def test_legacy_dispatched_write_reconciles_before_model_after_restart(self):
        state = self.submit('crash-after-write', legacy=True)
        with self.assertRaises(CrashInjected): self.runtime.run(state['run_id'])
        before = self.runtime.store.actions(state)[-1]
        time.sleep(.55)
        recovered = Runtime(self.tmp.name).run(state['run_id'])
        after = next(a for a in recovered['actions'] if a['logical_id'] == before['logical_id'])
        self.assertEqual(recovered['status'], 'SUCCEEDED')
        self.assertEqual(before['args_hash'], after['args_hash'])
        self.assertEqual(before['args'], after['args'])
        self.assertEqual(recovered['snapshot'], state['snapshot'])
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['calls'][TOOLS[2]], 1)

    def test_legacy_prompt_descriptor_restores_exactly_without_new_definition(self):
        for version in (1, 2, 3):
            p = profile(); p.pop('definition'); p.update(runtime='codex', model='fixture-model', options={'timeout':5,'max_attempts':2,'reasoning_effort':'low'})
            planner = LLMPlanner(CodexConfig('fixture-model','low',timeout=5), ConfiguredFixture(), p, version)
            task = TaskContract(agent_ref=p['id']+'@1')
            self.runtime.external.seed(task.to_dict())
            snapshot = legacy_registry_snapshot(planner, p)
            state = self.runtime.store.create(task, snapshot, 'response-lost')
            with patch('agent_framework.llm.CodexTransport.generate', side_effect=ConfiguredFixture().generate):
                result = Runtime(self.tmp.name).run(state['run_id'])
            self.assertEqual(result['status'], 'SUCCEEDED')
            self.assertEqual(result['snapshot'], snapshot)
            self.assertEqual(result['snapshot']['planner'], planner.descriptor())

    def test_current_policy_stops_prepared_write_but_allows_reconciliation(self):
        state = self.submit('denied')
        result = self.runtime.run(state['run_id'])
        prepared = next(a for a in result['actions'] if a['status'] == 'PREPARED')
        self.runtime.store.grant(result, prepared['args_hash'])
        self.runtime.store.set_capability_disabled('tenant-demo', TOOLS[2], 'emergency stop')
        blocked = self.runtime.run(state['run_id'])
        self.assertEqual(blocked['status'], 'WAITING_AUTH')
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['drafts'], [])
        self.runtime.store.set_capability_disabled('tenant-demo', TOOLS[2])
        self.assertEqual(self.runtime.run(state['run_id'])['status'], 'SUCCEEDED')
        # A disabled write must still be classified as WRITE when restoring UNKNOWN.
        state = self.submit('crash-after-write')
        with self.assertRaises(CrashInjected): self.runtime.run(state['run_id'])
        self.runtime.store.set_capability_disabled('tenant-demo', TOOLS[2], 'emergency stop')
        time.sleep(.55)
        self.assertEqual(Runtime(self.tmp.name).run(state['run_id'])['status'], 'SUCCEEDED')
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['calls'][TOOLS[2]], 1)

    def test_revocation_at_adapter_boundary_proves_no_write_and_preserves_intent(self):
        state=self.submit('denied')
        blocked=self.runtime.run(state['run_id'])
        prepared=next(a for a in blocked['actions'] if a['status']=='PREPARED')
        self.runtime.store.grant(blocked,prepared['args_hash'])
        invoke=self.runtime.gateway.invoke
        def revoke_then_invoke(current, action):
            if action['tool_ref']==TOOLS[2]:self.runtime.store.grant(current,revoke=True)
            return invoke(current,action)
        self.runtime.gateway.invoke=revoke_then_invoke
        denied=self.runtime.run(state['run_id'])
        pending=next(a for a in denied['actions'] if a['status']=='PREPARED')
        self.assertEqual(denied['status'],'WAITING_AUTH')
        self.assertEqual(pending['args_hash'],prepared['args_hash'])
        self.assertEqual(pending['attempts'],0)
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['drafts'],[])
        self.runtime.gateway.invoke=invoke
        self.runtime.store.grant(denied,prepared['args_hash'])
        self.assertEqual(self.runtime.run(state['run_id'])['status'],'SUCCEEDED')

    def test_policy_denies_readback_without_retrying_unknown_write(self):
        state = self.submit('crash-after-write')
        with self.assertRaises(CrashInjected): self.runtime.run(state['run_id'])
        self.runtime.store.set_capability_disabled('tenant-demo', TOOLS[3], 'readback unavailable')
        time.sleep(.55)
        result = Runtime(self.tmp.name).run(state['run_id'])
        self.assertEqual(result['status'], 'NEEDS_REVIEW')
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['calls'][TOOLS[2]], 1)

    def test_proposal_cannot_change_adapter_or_supply_shell_or_dedupe_key(self):
        state = self.submit()
        for args in [{'project_id':'project-demo','change_id':'change-demo-001','command':'touch /tmp/not-run'},
                     {'project_id':'another','change_id':'change-demo-001'}]:
            with self.assertRaises((ValueError, PolicyDenied)):
                self.runtime.gateway.prepare(state, ActionProposal(TOOLS[0],args,[],[],'bad'),{})
        result = self.runtime.run(state['run_id'])
        create = next(a for a in result['actions'] if a['tool_ref'] == TOOLS[2])
        create['adapter_ref'] = ADAPTERS[2]
        with self.assertRaises(PolicyDenied): self.runtime.gateway.invoke(result,create)
        self.assertEqual(self.runtime.external.stats('tenant-demo',state['run_id'])['calls'][TOOLS[2]],1)


class ReadProxyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.runtime = Runtime(self.tmp.name, lease_seconds=2, tool_timeout=.2)
        p = profile(native=True)
        self.state = self.runtime.submit(TaskContract(agent_ref=p['id']+'@1'),agent_profile=p)
        self.lease = self.runtime.store.acquire('tenant-demo',self.state['run_id'],2)
        self.addCleanup(self.runtime.store.release,self.state,self.lease)
        self.proxy = ReadCapabilityProxy(self.tmp.name)

    def test_native_read_is_scoped_authorized_and_persisted_as_evidence(self):
        with self.proxy.session(self.state,self.lease) as config:
            server = config['mcp_servers'][0]; token = server['args'][-1]
            self.assertEqual({t['name'] for t in self.proxy.tools(token)}, {'change_read','standards_read'})
            output = self.proxy.call(token,'change_read',{'project_id':'project-demo','change_id':'change-demo-001'})
            self.assertIn(output['evidence_ref'], self.runtime.store.evidence(self.state))
            self.assertEqual(self.runtime.store.result('tenant-demo',self.state['run_id'])['native_reads'][0]['status'],'VERIFIED')
            for name,args in [('report_draft_create',{}),('change_read',{'project_id':'private','change_id':'change-demo-001'})]:
                with self.assertRaises(PolicyDenied):self.proxy.call(token,name,args)
            self.assertEqual(self.runtime.external.stats('tenant-demo',self.state['run_id'])['calls'],{TOOLS[0]:1})
        with self.assertRaises(PolicyDenied): self.proxy.call(token,'change_read',{})

    def test_cognition_uses_proxy_and_cannot_bypass_business_authorization(self):
        class NativeFixture(ConfiguredFixture):
            def generate(inner, prompt, *args):
                wire = json.loads(prompt[prompt.index('\n{')+1:])
                if wire['phase'] == 'plan':
                    server = inner.governed_profile['mcp_servers'][0]
                    proxy = ReadCapabilityProxy(self.tmp.name)
                    token = server['args'][-1]
                    proxy.call(token, 'change_read', {'project_id':'project-demo','change_id':'change-demo-001'})
                    with self.assertRaises(PolicyDenied):
                        proxy.call(token, 'report_draft_create', {})
                return super().generate(prompt, *args)
        # Release this test's unrelated initial lease before running the real loop.
        self.runtime.store.release(self.state, self.lease)
        p = profile(native=True)
        p.update(runtime='codex',model='fixture-model',options={'timeout':5,'max_attempts':2,'reasoning_effort':'low'})
        fixture = NativeFixture()
        runtime = Runtime(self.tmp.name, planner=LLMPlanner(CodexConfig('fixture-model','low',timeout=5), fixture, p))
        state = runtime.submit(TaskContract(agent_ref=p['id']+'@1'),scenario='denied',agent_profile=p)
        result = runtime.run(state['run_id'])
        self.assertEqual(result['status'],'WAITING_AUTH')
        self.assertEqual(result['native_reads'][0]['status'],'VERIFIED')
        self.assertEqual(runtime.external.stats('tenant-demo',state['run_id'])['drafts'],[])
        context = fixture.requests[0]['context']
        self.assertEqual(context['agent']['identity']['role'],'release_reviewer')
        self.assertEqual(context['constraints']['capability_effects'][TOOLS[2]]['effect'],'WRITE')
        self.assertNotIn('read_sessions',json.dumps(context))

    def test_codex_materializes_only_scoped_proxy_never_upstream_configuration(self):
        with self.proxy.session(self.state,self.lease) as config:
            seen=[]
            class Process:
                returncode=0
                pid=999999
                def __init__(inner, command, **kwargs):
                    seen.extend(command)
                    Path(command[command.index('--output-last-message')+1]).write_text('{}')
                def communicate(inner,prompt,timeout):
                    return '\n'.join(json.dumps(e) for e in [
                        {'type':'item.completed','item':{'type':'mcp_tool_call','server':'governed','tool':'change_read'}},
                        {'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}]),''
            transport=CodexTransport({'mcp_servers':[MCP]})
            transport.governed_profile=config
            with patch('agent_framework.llm.subprocess.Popen',Process):
                _, meta=transport.generate('synthetic',{},CodexConfig('fixture'),1)
            self.assertTrue(any('read_proxy.py' in item for item in seen))
            self.assertFalse(any('mock_mcp.py' in item or 'FACTS_TOKEN' in item for item in seen))
            self.assertEqual(meta['mcp_calls'],[{'server':'governed','tool':'change_read'}])

    def test_stdio_protocol_exposes_no_write_and_rejects_before_dispatch(self):
        with self.proxy.session(self.state,self.lease) as config:
            server = config['mcp_servers'][0]
            requests = [{'jsonrpc':'2.0','id':1,'method':'initialize'}, {'jsonrpc':'2.0','id':2,'method':'tools/list'},
                        {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'change_read','arguments':{'project_id':'project-demo','change_id':'change-demo-001'}}},
                        {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'report_draft_create','arguments':{}}}]
            process = subprocess.run([server['command'],*server['args']],input=''.join(json.dumps(r)+'\n' for r in requests),
                                     text=True,capture_output=True,timeout=3,check=True)
            responses = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertIn('result',responses[2]);self.assertIn('error',responses[3])
            self.assertEqual(self.runtime.external.stats('tenant-demo',self.state['run_id'])['calls'],{TOOLS[0]:1})

    def test_native_session_is_budgeted_current_policy_checked_and_fenced(self):
        with self.proxy.session(self.state,self.lease) as config:
            token=config['mcp_servers'][0]['args'][-1]
            self.runtime.store.set_capability_disabled('tenant-demo',TOOLS[0],'blocked')
            with self.assertRaises(PolicyDenied):self.proxy.call(token,'change_read',{'project_id':'project-demo','change_id':'change-demo-001'})
            self.runtime.store.set_capability_disabled('tenant-demo',TOOLS[0])
            self.state['steps']=self.state['task']['budget']['max_steps']
            self.runtime.checkpoint(self.state,self.lease,'test.budget')
            with self.assertRaisesRegex(PolicyDenied,'budget'):self.proxy.call(token,'change_read',{})
            self.runtime.store.release(self.state,self.lease)
            replacement=self.runtime.store.acquire('tenant-demo',self.state['run_id'],2)
            self.addCleanup(self.runtime.store.release,self.state,replacement)
            with self.assertRaisesRegex(PolicyDenied,'lease'):self.proxy.tools(token)


if __name__ == '__main__':unittest.main()
