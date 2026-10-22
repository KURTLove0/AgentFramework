"""Configuration, provider dispatch, snapshot recovery and CLI envelope contracts."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.llm import CodexConfig, CursorConfig, CursorTransport, LLMPlanner, ModelError
from agent_framework.runtime import CrashInjected, Runtime
from agent_framework.runtime_config import ConfigConflict, RuntimeConfiguration
from agent_framework.web import Application
from test_llm import FixtureTransport

DEFAULTS = {'default_runtime':'mock', 'profiles':{
    'codex': {'model':'codex-fixture','reasoning_effort':'low','timeout':10,'max_attempts':2},
    'cursor': {'model':'cursor-fixture','timeout':10,'max_attempts':2}}}


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.defaults=patch.object(RuntimeConfiguration,'defaults',lambda self:deepcopy(DEFAULTS))
        self.defaults.start();self.addCleanup(self.defaults.stop)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2)
        self.addCleanup(self.app.close)

    def settings(self, provider='mock'):
        return {**deepcopy(DEFAULTS),'default_runtime':provider,'revision':self.app.configuration.get()['revision']}

    def test_persistence_and_tenant_scope(self):
        saved=self.app.configuration.save(self.settings('cursor'))
        self.assertEqual(saved['revision'],1)
        self.assertEqual(RuntimeConfiguration(self.tmp.name,'tenant-demo').get(),saved)
        self.assertEqual(RuntimeConfiguration(self.tmp.name,'other').get()['default_runtime'],'mock')
        self.assertEqual(self.app.runs()['counts']['total'],0)  # Save never invokes cognition.

    def test_revision_conflict_and_invalid_data_preserve_saved_settings(self):
        good=self.settings('codex');saved=self.app.configuration.save(good)
        with self.assertRaises(ConfigConflict):self.app.configuration.save(good)
        for change in ('api_key','command','invalid-default','invalid-model','invalid-timeout','auto-model'):
            data=self.settings()
            if change in ('api_key','command'):data['profiles']['cursor'][change]='not-allowed'
            elif change=='invalid-default':data['default_runtime']='arbitrary-shell'
            elif change=='invalid-model':data['profiles']['cursor']['model']='--force'
            elif change=='invalid-timeout':data['profiles']['cursor']['timeout']=999
            else:data['profiles']['cursor']['model']='auto'
            with self.assertRaises(ValueError):self.app.configuration.save(data)
            self.assertEqual(self.app.configuration.get(),saved)

    def test_cli_detection_uses_fixed_command_and_never_model_prompt(self):
        with patch('agent_framework.runtime_config.shutil.which',return_value='/local/cursor-agent'),patch('agent_framework.runtime_config.subprocess.run') as run:
            run.return_value=subprocess.CompletedProcess([],0,'Cursor 1.0\n','')
            result=self.app.configuration.detect('cursor')
            self.assertTrue(result['ok'])
            self.assertEqual(run.call_args.args[0],['cursor-agent','--version'])
        with self.assertRaises(ValueError):self.app.configuration.detect('sh -c unsafe')

    def test_default_provider_consent_and_snapshot_freeze(self):
        self.app.configuration.save(self.settings('cursor'))
        with self.assertRaisesRegex(Exception,'使用真实模型前'):self.app.create({'start':False})
        with patch('agent_framework.runtime_config.shutil.which',return_value='/local/cli'):
            created=self.app.create({'start':False,'consent':True,'runtime_revision':1})['run']
            desc=created['snapshot']['planner']
            self.assertEqual(desc['ref'],'cursor-planner@1.0.0')
            data=self.settings('codex');data['profiles']['cursor']['model']='new-cursor-model'
            self.app.configuration.save(data)
            self.assertEqual(self.app.detail(created['run_id'])['run']['snapshot']['planner'],desc)
            with self.assertRaises(ConfigConflict):self.app.create({'start':False,'runtime':'cursor','consent':True,'runtime_revision':1})
            codex=self.app.create({'start':False,'runtime':'codex','consent':True})['run']
            self.assertEqual(codex['snapshot']['planner']['config']['model'],'codex-fixture')

    def test_cursor_full_loop_authorization_readback_and_restart(self):
        self.app.configuration.save(self.settings('cursor'))
        fixture=FixtureTransport()
        with patch('agent_framework.runtime_config.shutil.which',return_value='/local/cli'),patch.object(CursorTransport,'generate',lambda self,*args:fixture.generate(*args)):
            for scenario in ('normal','response-lost','denied','tampered-draft','crash-after-write'):
                created=self.app.create({'start':False,'consent':True,'scenario':scenario})['run']
                runtime=self.app.runtime()
                try:result=runtime.run(created['run_id'])
                except CrashInjected:
                    time.sleep(.55)
                    # Different provider/model defaults must not alter the persisted intent.
                    data=self.settings('mock');data['profiles']['cursor']['model']='changed-model'
                    self.app.configuration.save(data)
                    result=Runtime(self.tmp.name).run(created['run_id'])
                if scenario=='denied':
                    self.assertEqual(result['status'],'WAITING_AUTH')
                    self.assertEqual(runtime.external.stats('tenant-demo',created['run_id'])['drafts'],[])
                    pending=next(a for a in result['actions'] if a['status']=='PREPARED')
                    runtime.store.grant(result,pending['args_hash'])
                    result=runtime.run(created['run_id'])
                self.assertEqual(result['status'],'NEEDS_REVIEW' if scenario=='tampered-draft' else 'SUCCEEDED')
                external=runtime.external.stats('tenant-demo',created['run_id'])
                self.assertEqual(external['calls']['report.draft.create@1.0.0'],1)
                self.assertEqual(len(external['drafts']),1)
                self.assertEqual(result['snapshot']['planner']['config']['model'],'cursor-fixture')
                if scenario!='tampered-draft':self.assertTrue(all(c['passed'] for c in result['checks'].values()))
        self.assertTrue(fixture.requests)

    def test_legacy_codex_descriptor_restores_exactly(self):
        planner=LLMPlanner(CodexConfig('legacy-model','high'))
        self.assertEqual(LLMPlanner.restore(planner.descriptor()).descriptor(),planner.descriptor())
        self.assertNotIn('transport_policy_hash',planner.descriptor())


class CursorEnvelopeTests(unittest.TestCase):
    def generate(self,events,inspect=None):
        class Process:
            returncode=0
            def communicate(self,prompt,timeout):return '\n'.join(json.dumps(e) for e in events),''
        def popen(command,**kwargs):
            self.assertEqual(command[0],'cursor-agent')
            self.assertIn('ask',command)
            self.assertNotIn('--force',command)
            settings=Path(kwargs['env']['CURSOR_CONFIG_DIR'])
            policy=json.loads((settings/'cli-config.json').read_text())
            self.assertEqual(policy['permissions']['allow'],[])
            self.assertIn('Shell(*)',policy['permissions']['deny'])
            self.assertIn('Mcp(*:*)',policy['permissions']['deny'])
            self.assertEqual(kwargs['cwd'],settings.parent)
            self.assertEqual(kwargs['env']['HOME'],__import__('os').environ['HOME'])
            if inspect:inspect(command,kwargs)
            return Process()
        with patch('agent_framework.llm.subprocess.Popen',side_effect=popen):
            return CursorTransport().generate('synthetic prompt',{},CursorConfig('fixture'),10)

    def result(self,**kwargs):return {'type':'result','subtype':'success','is_error':False,'result':'{"ok":true}','usage':{'inputTokens':10,'outputTokens':5},**kwargs}

    def test_native_envelope_and_usage_normalization(self):
        raw,meta=self.generate([{'type':'system','subtype':'init'},self.result()])
        self.assertEqual(json.loads(raw),{'ok':True})
        self.assertEqual(meta['usage'],{'input_tokens':10,'output_tokens':5})

    def test_tool_calls_missing_usage_or_error_fail_closed(self):
        for events in ([{'type':'tool_call'},self.result()],[self.result(usage={})],[self.result(is_error=True)],[self.result(),self.result()],[]):
            with self.assertRaises(ModelError):self.generate(events)

    def test_inherited_mcp_is_disabled_without_copying_commands_or_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            home=Path(directory)
            (home/'.cursor').mkdir()
            (home/'.cursor/mcp.json').write_text(json.dumps({'mcpServers':{
                'private-server':{'command':'untrusted-command','env':{'SECRET':'never-copy-this'}}}}))
            def inspect(command,kwargs):
                text=(Path(kwargs['env']['CURSOR_CONFIG_DIR'])/'mcp.json').read_text()
                self.assertNotIn('untrusted-command',text)
                self.assertNotIn('never-copy-this',text)
                self.assertTrue(json.loads(text)['mcpServers']['private-server']['disabled'])
            with patch('agent_framework.llm.Path.home',return_value=home):
                self.generate([self.result()],inspect)

    def test_invalid_runtime_parameters(self):
        for kwargs in ({'timeout':True},{'timeout':float('nan')},{'model':'--force'},{'model':'auto'},{'max_attempts':True}):
            with self.assertRaises(ValueError):CursorConfig(**({'model':'fixture'}|kwargs))


if __name__=='__main__':unittest.main()
