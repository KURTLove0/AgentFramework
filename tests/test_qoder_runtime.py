"""Qoder CLI discovery, bounded transport, configuration migration and recovery."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.agents import AgentRegistry
from agent_framework.contracts import canonical, TOOLS
from agent_framework.definitions import default_definition
from agent_framework.llm import QoderConfig, QoderTransport, LLMPlanner, ModelError, QODER_POLICY, qoder_command
from agent_framework.model_catalog import ModelCatalog, ModelDiscoveryError
from agent_framework.runtime import CrashInjected, Runtime
from agent_framework.runtime_config import RuntimeConfiguration, ConfigConflict
from agent_framework.web import Application
from test_agents import definition
from test_llm import FixtureTransport


class QoderConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(self.app.close)

    def settings(self):
        current=self.app.configuration.get()
        return {key:deepcopy(current[key]) for key in ('profiles','default_runtime','revision')}

    def test_old_saved_profiles_gain_qoder_without_rewriting_revision_or_defaults(self):
        data=self.settings();data['profiles'].pop('qoder');data['default_runtime']='mock'
        with self.app.agents.store.connect() as db:
            db.execute('INSERT INTO runtime_configuration VALUES(?,?,?,?)',
                       (self.app.tenant,7,canonical({key:data[key] for key in ('profiles','default_runtime')}),100))
        loaded=self.app.configuration.get()
        self.assertEqual(loaded['revision'],7);self.assertEqual(loaded['default_runtime'],'mock')
        self.assertIn('qoder',loaded['profiles'])
        self.assertEqual(self.app.configuration.get()['profiles']['cursor'],data['profiles']['cursor'])
        data['revision']=7;self.assertEqual(self.app.configuration.save(data)['revision'],8)

    def test_save_detect_and_preserve_qoder_when_an_older_client_saves(self):
        data=self.settings();data['default_runtime']='qoder';data['profiles']['qoder']={'model':'qoder-fixture','timeout':5,'max_attempts':2}
        saved=self.app.configuration.save(data)
        self.assertEqual(saved['default_runtime'],'qoder')
        with patch('agent_framework.runtime_config.shutil.which',return_value='/local/qodercli'),patch('agent_framework.runtime_config.subprocess.run',return_value=subprocess.CompletedProcess([],0,'1.0.31\n','')) as run:
            self.assertTrue(self.app.configuration.detect('qoder')['ok'])
            self.assertEqual(run.call_args.args[0],['qodercli','--version'])
            self.assertIsInstance(self.app.configuration.planner().transport,QoderTransport)
        older=self.settings();older['profiles'].pop('qoder');older['default_runtime']='mock'
        self.assertEqual(self.app.configuration.save(older)['profiles']['qoder']['model'],'qoder-fixture')
        with self.assertRaises(ConfigConflict):self.app.configuration.save(data)
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_model_configuration_rejects_unbounded_or_injected_parameters(self):
        for values in ({'model':'--force'},{'timeout':True},{'timeout':float('nan')},{'max_attempts':0},{'max_attempts':True}):
            with self.assertRaises(ValueError):QoderConfig(**({'model':'qoder-fixture'}|values))
        data=self.settings();data['profiles']['qoder']['command']='arbitrary-shell'
        with self.assertRaises(ValueError):self.app.configuration.save(data)

    def test_local_model_preference_and_command_alias(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root,'settings.json').write_text(json.dumps({'model':{'name':'local-model'},'mcpServers':{'private':{}}}))
            with patch.dict(os.environ,{'QODER_CONFIG_DIR':root,'QODER_MODEL':''}):self.assertEqual(QoderConfig.local().model,'local-model')
        with patch('agent_framework.llm.shutil.which',side_effect=lambda name:'/local/qoder' if name=='qoder' else None):
            self.assertEqual(qoder_command(),'qoder')

    def test_configured_agent_compiles_and_run_restores_its_frozen_qoder_model(self):
        with patch.object(ModelCatalog,'list',return_value={'models':[{'id':'fixture-model','name':'Fixture','efforts':[]}]}):
            profile=self.app.agents.save(definition('qoder'))
        compiled=self.app.agents.compile(profile['id'])
        self.assertEqual(compiled['runtime']['ref'],'qoder-planner@1.0.0')
        planner=self.app.agents.planner(profile)
        self.assertEqual(LLMPlanner.restore(planner.descriptor()).descriptor(),planner.descriptor())
        self.assertIn('transport_policy_hash',planner.descriptor())
        fixture=FixtureTransport()
        # Configured prompts contain a final JSON document consumed by this deterministic fixture.
        def generate(transport,prompt,schema,config,timeout):
            from agent_framework.llm import SYSTEM
            return fixture.generate(SYSTEM+'\n'+prompt[prompt.index('\n{')+1:],schema,config,timeout)
        with patch.object(QoderTransport,'generate',generate):
            run=self.app.create({'start':False,'consent':True,'agent_id':profile['id'],'agent_revision':1,'scenario':'crash-after-write'})['run']
            with self.assertRaises(CrashInjected):self.app.runtime().run(run['run_id'])
            time.sleep(.55)
            restored=Runtime(self.tmp.name).run(run['run_id'])
        self.assertEqual(restored['status'],'SUCCEEDED')
        self.assertEqual(restored['snapshot']['planner']['config']['model'],'fixture-model')
        self.assertEqual(self.app.runtime().external.stats(self.app.tenant,run['run_id'])['calls'][TOOLS[2]],1)


class QoderCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.catalog=ModelCatalog(self.tmp.name,'tenant-qoder')

    def test_json_models_from_cli_are_authoritative_cached_and_refreshed(self):
        output=json.dumps({'models':[{'id':'model-a','displayName':'Model A'},{'modelId':'model-b','name':'Model B'},{'id':'model-a','name':'duplicate'}]})
        with patch('agent_framework.model_catalog.subprocess.run',return_value=subprocess.CompletedProcess([],0,output,'')) as run:
            result=self.catalog.list('qoder');self.assertEqual([m['id'] for m in result['models']],['model-a','model-b'])
            self.assertIn('--list-models',run.call_args.args[0]);self.assertNotIn('--print',run.call_args.args[0])
            self.assertTrue(self.catalog.list('qoder')['cached']);self.assertEqual(run.call_count,1)
            self.catalog.require('qoder','model-a')
            with self.assertRaises(ValueError):self.catalog.require('qoder','invented')
            self.catalog.list('qoder',True);self.assertEqual(run.call_count,2)
        self.assertIsNone(ModelCatalog(self.tmp.name,'other-tenant').cached('qoder'))

    def test_text_models_and_auth_failures_never_fabricate_choices(self):
        with patch('agent_framework.model_catalog.subprocess.run',return_value=subprocess.CompletedProcess([],0,'Available models\nmodel-a - Model A\nmodel-b - Model B\n','')):
            self.assertEqual(len(self.catalog.list('qoder')['models']),2)
        with patch('agent_framework.model_catalog.subprocess.run',return_value=subprocess.CompletedProcess([],1,'','Not logged in.')):
            with self.assertRaisesRegex(ModelDiscoveryError,'login'):self.catalog.list('qoder',True)
        self.assertEqual(len(self.catalog.cached('qoder')['models']),2)
        for output in ('No models available','{"models":[]}','{"error":"login"}'):
            with patch('agent_framework.model_catalog.subprocess.run',return_value=subprocess.CompletedProcess([],0,output,'')):
                with self.assertRaises(ModelDiscoveryError):self.catalog.list('qoder',True)

    def test_installed_qoder_single_column_format_uses_names_and_complete_custom_keys(self):
        output='MODEL\nAuto\nPerformance\nResearch Model (custom-model-123)\nLong key (custom-truncated…)\n'
        with patch('agent_framework.model_catalog.subprocess.run',return_value=subprocess.CompletedProcess([],0,output,'')):
            models=self.catalog.list('qoder')['models']
        self.assertEqual([m['id'] for m in models],['Auto','Performance','custom-model-123'])
        self.assertEqual(models[-1]['name'],'Research Model')


class QoderEnvelopeTests(unittest.TestCase):
    def result(self,**overrides):
        return {'type':'result','subtype':'success','is_error':False,'result':'{"ok":true}',
                'usage':{'input_tokens':10,'output_tokens':5},**overrides}

    def generate(self,events,inspect=None,transport=None,returncode=0,stderr=''):
        class Process:
            def communicate(self,prompt,timeout):return '\n'.join(json.dumps(event) for event in events),stderr
        process=Process();process.returncode=returncode
        def popen(command,**kwargs):
            self.assertIn('--print',command);self.assertIn('stream-json',command)
            self.assertEqual(command[command.index('--tools')+1],'')
            self.assertIn('--strict-mcp-config',command);self.assertNotIn('--dangerously-skip-permissions',command)
            settings=json.loads(Path(command[command.index('--settings')+1]).read_text())
            self.assertEqual(settings['hooks'],{});self.assertEqual(settings['enabledPlugins'],{})
            self.assertFalse(settings['skills']['enabled']);self.assertIn('--disable-builtin-skills',command)
            self.assertNotIn('QODER_SESSION_ID',kwargs['env']);self.assertNotIn('QODER_APPEND_SYSTEM_PROMPT',kwargs['env'])
            if inspect:inspect(command,kwargs)
            return process
        with patch('agent_framework.llm.subprocess.Popen',side_effect=popen),patch.dict(os.environ,{'QODER_SESSION_ID':'must-not-resume','QODER_APPEND_SYSTEM_PROMPT':'must-not-inherit'}):
            return (transport or QoderTransport()).generate('synthetic JSON prompt',{},QoderConfig('fixture-model'),10)

    def test_result_usage_and_isolated_configuration(self):
        def inspect(command,kwargs):
            mcp=json.loads(Path(command[command.index('--mcp-config')+1]).read_text())
            self.assertEqual(mcp,{'mcpServers':{}})
            self.assertEqual(str(kwargs['cwd']),command[command.index('--cwd')+1])
        raw,meta=self.generate([{'type':'system','subtype':'init','tools':[]},self.result(usage={'input_tokens':10,'output_tokens':5,'cache_read_input_tokens':3,'cache_creation_input_tokens':2})],inspect)
        self.assertEqual(json.loads(raw),{'ok':True});self.assertEqual(meta['usage'],{'input_tokens':15,'output_tokens':5})

    def test_unexpected_tools_errors_missing_usage_and_duplicate_results_fail_closed(self):
        fixtures=[[],[self.result(usage={})],[self.result(is_error=True)],[self.result(),self.result()],
                  [{'type':'system','subtype':'init','tools':['Bash']},self.result()],
                  [{'type':'assistant','message':{'content':[{'type':'tool_use','name':'Bash','input':{}}]}},self.result()],
                  [self.result(permission_denials=[{'tool_name':'Bash'}])],
                  [self.result(usage={'input_tokens':True,'output_tokens':2})],
                  [{'type':'control_request'},self.result()], [{'type':'assistant','message':None},self.result()]]
        for events in fixtures:
            with self.subTest(events=events),self.assertRaises(ModelError):self.generate(events)
        with self.assertRaisesRegex(ModelError,'qoder_auth_required'):self.generate([],returncode=1,stderr='Not logged in.')
        with self.assertRaisesRegex(ModelError,'qoder_auth_required'):
            self.generate([{'type':'assistant','error':'authentication_failed'}],returncode=1)
        with self.assertRaisesRegex(ModelError,'qoder_exit_2'):self.generate([],returncode=2)

    def test_only_governed_mcp_calls_are_accepted(self):
        transport=QoderTransport();transport.governed_profile={'mcp_servers':[{'name':'governed','transport':'stdio','command':'python3',
            'args':['proxy.py'],'env_vars':[],'tools':['change_read'],'enabled':True}]}
        tool='mcp__governed__change_read'
        events=[{'type':'system','subtype':'init','tools':[tool]},
                {'type':'assistant','message':{'content':[{'type':'tool_use','name':tool,'input':{}}]}},self.result()]
        def inspect(command,kwargs):self.assertEqual(command[command.index('--allowed-tools')+1],tool)
        _,meta=self.generate(events,inspect,transport)
        self.assertEqual(meta['mcp_calls'],[{'server':'governed','tool':'change_read'}])
        events[1]['message']['content'][0]['name']='mcp__governed__write'
        with self.assertRaisesRegex(ModelError,'unexpected_qoder_tool'):self.generate(events,transport=transport)

    def test_timeout_terminates_the_process_group(self):
        class Process:
            pid=123456
            calls=0
            def communicate(self,*args,**kwargs):
                self.calls+=1
                if self.calls==1:raise subprocess.TimeoutExpired('qodercli',1)
                return '',''
        with patch('agent_framework.llm.subprocess.Popen',return_value=Process()),patch('agent_framework.llm.os.killpg') as kill:
            with self.assertRaisesRegex(ModelError,'model_timeout'):QoderTransport().generate('synthetic',{},QoderConfig('fixture'),1)
            kill.assert_called_once()


if __name__=='__main__':unittest.main()
