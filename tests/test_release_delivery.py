"""Installed launchers and trusted Python children ignore caller import paths."""
import json
from copy import deepcopy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile
from unittest.mock import Mock,patch
from urllib.request import urlopen

from agent_framework.adapters import invoke
from agent_framework.contracts import TaskContract
from agent_framework.read_proxy import ReadCapabilityProxy
from agent_framework.runtime import Runtime

ROOT=Path(__file__).resolve().parents[1]


def load_script(name):
    spec=importlib.util.spec_from_file_location('delivery_'+name,ROOT/'scripts'/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


builder=load_script('build_release')
verifier=load_script('verify_release')


class LaunchIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='release delivery ',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.shadow=self.root/'caller source';self.shadow.mkdir()
        self.marker=self.root/'caller-code-ran'
        self.bad='from pathlib import Path\nPath('+repr(str(self.marker))+').write_text("unexpected")\nraise RuntimeError("caller code executed")\n'

    def environment(self):
        return {**os.environ,'PYTHONPATH':str(self.shadow),'PYTHON':sys.executable,
                'PIP_NO_INDEX':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','PIP_NO_CACHE_DIR':'1','PIP_CONFIG_FILE':os.devnull}

    def startup(self,*,cwd):
        package=self.shadow/'agent_framework';package.mkdir();(package/'__init__.py').write_text('')
        (package/'__main__.py').write_text(self.bad)
        bundle=self.root/'installed bundle';(bundle/'scripts').mkdir(parents=True)
        launcher=bundle/'scripts/start.sh';launcher.write_text((ROOT/'scripts/start.sh').read_text())
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        environment=self.environment()|{'AGENT_VENV_DIR':sys.prefix,'AGENT_DATA_DIR':str(self.root/'external data'),
            'AGENT_TENANT':'delivery-tenant','AGENT_PRINCIPAL':'delivery-user','AGENT_PORT':str(port)}
        with (self.root/'launch.log').open('w') as log:
            process=subprocess.Popen(['sh',str(launcher)],cwd=cwd,env=environment,stdout=log,stderr=subprocess.STDOUT)
            try:
                deadline=time.monotonic()+4
                while time.monotonic()<deadline and process.poll() is None:
                    try:
                        with urlopen(f'http://127.0.0.1:{port}/api/session',timeout=.3) as response:session=json.load(response)
                        self.assertEqual(session['tenant'],'delivery-tenant');self.assertEqual(session['principal'],'delivery-user')
                        self.assertFalse(self.marker.exists());return
                    except OSError:time.sleep(.03)
                self.fail((self.root/'launch.log').read_text())
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGINT)
                    try:process.wait(5)
                    except subprocess.TimeoutExpired:process.kill();process.wait()

    def test_start_script_ignores_a_different_project_in_the_callers_directory(self):
        self.startup(cwd=self.shadow)

    def test_start_script_ignores_pythonpath_from_another_project(self):
        clean=self.root/'empty caller';clean.mkdir();self.startup(cwd=clean)

    def test_installer_ignores_shadow_venv_and_pip_modules_without_network(self):
        bundle=self.root/'installation target';(bundle/'scripts').mkdir(parents=True)
        installer=bundle/'scripts/install.sh';installer.write_text((ROOT/'scripts/install.sh').read_text())
        (bundle/'requirements.txt').write_text('')
        (self.shadow/'venv.py').write_text(self.bad);(self.shadow/'pip.py').write_text(self.bad);(bundle/'pip.py').write_text(self.bad)
        environment=self.environment()|{'AGENT_VENV_DIR':str(bundle/'environment with spaces')}
        result=subprocess.run(['sh',str(installer)],cwd=self.shadow,env=environment,capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr);self.assertFalse(self.marker.exists())
        self.assertTrue((bundle/'environment with spaces/bin/python').exists())

    def test_simulated_adapter_children_ignore_shadow_standard_library_modules(self):
        (self.shadow/'json.py').write_text(self.bad)
        payload={'external_db':str(self.root/'mock.sqlite3'),'tool_ref':'standards.read@1.0.0','args':{'project_id':'project-demo'},
                 'trusted':{'tenant_id':'tenant-demo','project_id':'project-demo','run_id':'run-delivery','scenario':'normal'}}
        with patch.dict(os.environ,{'PYTHONPATH':str(self.shadow)}):
            for adapter in ('mock-worker@1.0.0','mock-cli@1.0.0','mock-mcp@1.0.0'):
                with self.subTest(adapter=adapter):self.assertEqual(invoke(adapter,payload,3,False)['id'],'release-review-rubric')
        self.assertFalse(self.marker.exists())

    def test_native_read_proxy_starts_from_its_trusted_package_under_pythonpath_shadowing(self):
        (self.shadow/'json.py').write_text(self.bad)
        runtime=Runtime(self.root/'runtime');state=runtime.submit(TaskContract());lease=runtime.store.acquire(state['tenant_id'],state['run_id'],10)
        try:
            with ReadCapabilityProxy(self.root/'runtime').session(state,lease) as profile:
                server=profile['mcp_servers'][0]
                result=subprocess.run([server['command'],*server['args']],input=json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{}})+'\n',
                    text=True,capture_output=True,cwd=self.shadow,env=self.environment(),timeout=5)
                self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout.splitlines()[0])['id'],1)
            self.assertFalse(self.marker.exists())
        finally:runtime.store.release(state,lease)

    def test_trusted_worker_also_runs_from_an_explicit_source_tree_without_installation(self):
        environment=self.root/'source only environment'
        subprocess.run([sys.executable,'-I','-m','venv','--without-pip',str(environment)],check=True,capture_output=True,timeout=10)
        (self.shadow/'json.py').write_text(self.bad)
        program='''import json,sys
sys.path.insert(0,sys.argv[1])
from agent_framework.adapters import invoke
payload={'external_db':sys.argv[2],'tool_ref':'standards.read@1.0.0','args':{'project_id':'project-demo'},'trusted':{'tenant_id':'tenant-demo','project_id':'project-demo','run_id':'source-only','scenario':'normal'}}
print(json.dumps(invoke('mock-worker@1.0.0',payload,3,False)))
'''
        result=subprocess.run([str(environment/'bin/python'),'-I','-c',program,str(ROOT),str(self.root/'source-only.sqlite3')],
            cwd=self.shadow,env=self.environment(),capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout)['id'],'release-review-rubric')
        self.assertFalse(self.marker.exists())


class ReleaseBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='release-build-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.package=self.root/'agent_framework';self.package.mkdir()
        (self.package/'__init__.py').write_text('__version__="1.3.0"\n')
        self.metadata={'tool':{'setuptools':{'package-data':{'agent_framework':['webui/*.js']}}}}

    def test_snapshot_includes_untracked_modules_and_declared_ui_but_not_caches(self):
        (self.package/'new_module.py').write_text('NEW_SOURCE=True\n');(self.package/'webui').mkdir()
        (self.package/'webui/new_ui.js').write_text('const fresh=true;')
        (self.package/'__pycache__').mkdir();(self.package/'__pycache__/cached.pyc').write_bytes(b'old')
        (self.root/'.agent-data').mkdir();(self.root/'.agent-data/runtime.sqlite3').write_bytes(b'private data')
        manifest=builder.source_manifest(self.root,self.metadata)
        self.assertEqual(set(manifest),{'agent_framework/__init__.py','agent_framework/new_module.py','agent_framework/webui/new_ui.js'})
        self.assertEqual(manifest['agent_framework/new_module.py'],hashlib.sha256(b'NEW_SOURCE=True\n').hexdigest())

    def test_symlink_source_is_rejected_before_it_can_copy_outside_data(self):
        private=self.root/'outside.py';private.write_text('PRIVATE_SOURCE=True')
        (self.package/'linked.py').symlink_to(private)
        with self.assertRaisesRegex(ValueError,'unsupported'):builder.source_manifest(self.root,self.metadata)

    def test_unregistered_package_data_is_rejected(self):
        (self.package/'local.sqlite3').write_bytes(b'not distributable')
        with self.assertRaisesRegex(ValueError,'unregistered'):builder.source_manifest(self.root,self.metadata)

    def test_publication_cannot_replace_an_existing_artifact(self):
        source=self.root/'source';source.write_bytes(b'new');target=self.root/'published.whl';target.write_bytes(b'original')
        with self.assertRaises(FileExistsError):builder.publish(source,target)
        self.assertEqual(target.read_bytes(),b'original');self.assertEqual(list(self.root.glob('.release-*')),[])

    def test_failed_copy_does_not_publish_a_partial_artifact(self):
        source=self.root/'source';source.write_bytes(b'new');target=self.root/'published.whl'
        with patch.object(builder.shutil,'copyfile',side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):builder.publish(source,target)
        self.assertFalse(target.exists());self.assertEqual(list(self.root.glob('.release-*')),[])

    def test_another_process_cannot_build_into_the_same_output_directory(self):
        program='''import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('build_release',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:
 with module.output_lock(Path(sys.argv[2])):raise AssertionError('concurrent build accepted')
except RuntimeError:print('locked')
'''
        with builder.output_lock(self.root):
            result=subprocess.run([sys.executable,'-I','-c',program,str(ROOT/'scripts/build_release.py'),str(self.root)],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),'locked')
        with builder.output_lock(self.root):pass

    def test_output_option_preserves_existing_candidate_without_touching_default_dist(self):
        (self.root/'pyproject.toml').write_text('[project]\nversion="1.3.0"\n')
        output=self.root/'candidate';output.mkdir();artifact=output/'agent-framework-1.3.0.tar.gz';artifact.write_bytes(b'original')
        with patch.object(builder,'ROOT',self.root),patch.object(sys,'argv',['build_release.py','--output-dir',str(output)]):
            with self.assertRaises(FileExistsError):builder.main()
        self.assertEqual(artifact.read_bytes(),b'original');self.assertFalse((self.root/'dist').exists())


class ReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='release-verify-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.bundle=self.root/'agent-framework-1.3.0';(self.bundle/'scripts').mkdir(parents=True)
        self.wheel=self.bundle/'bounded_agent_mvp-1.3.0-py3-none-any.whl'
        with zipfile.ZipFile(self.wheel,'w') as archive:
            archive.writestr('agent_framework/__init__.py','__version__="1.3.0"\n')
            archive.writestr('bounded_agent_mvp-1.3.0.dist-info/METADATA','Metadata-Version: 2.1\nName: bounded-agent-mvp\nVersion: 1.3.0\n')
        version,source=verifier.wheel_manifest(self.wheel)
        (self.bundle/'release.json').write_text(json.dumps({'version':version,'wheel':self.wheel.name,'contains_runtime_data':False,
            'wheel_sha256':verifier.sha256(self.wheel),'source_sha256':source}))
        (self.bundle/'scripts/start.sh').write_text('#!/bin/sh\nexit 0\n')
        self.checksums()

    def checksums(self):
        files=sorted(path for path in self.bundle.rglob('*') if path.is_file() and path!=self.bundle/'SHA256SUMS')
        (self.bundle/'SHA256SUMS').write_text(''.join(verifier.sha256(path)+'  '+str(path.relative_to(self.bundle))+'\n' for path in files))

    def test_bundle_inventory_and_wheel_source_are_checked_together(self):
        wheel,version,source=verifier.verify_bundle(self.bundle)
        self.assertEqual(wheel,self.wheel);self.assertEqual(version,'1.3.0');self.assertIn('agent_framework/__init__.py',source)

    def test_modified_launcher_is_rejected_even_with_an_unchanged_wheel(self):
        (self.bundle/'scripts/start.sh').write_text('changed')
        with self.assertRaisesRegex(ValueError,'inventory mismatch'):verifier.verify_bundle(self.bundle)

    def test_an_extra_nested_checksum_file_cannot_escape_inventory_validation(self):
        (self.bundle/'scripts/SHA256SUMS').write_text('unlisted file')
        with self.assertRaisesRegex(ValueError,'inventory mismatch'):verifier.verify_bundle(self.bundle)

    def test_a_consistent_outer_checksum_cannot_hide_wrong_source_hashes(self):
        manifest=json.loads((self.bundle/'release.json').read_text());manifest['source_sha256']['agent_framework/__init__.py']='0'*64
        (self.bundle/'release.json').write_text(json.dumps(manifest));self.checksums()
        with self.assertRaisesRegex(ValueError,'source manifest'):verifier.verify_bundle(self.bundle)

    def test_tar_path_escape_links_and_duplicate_members_are_rejected(self):
        for index,kind in enumerate(('escape','symlink','hardlink','duplicate')):
            artifact=self.root/(kind+'.tar.gz')
            with tarfile.open(artifact,'w:gz') as archive:
                member=tarfile.TarInfo('../escaped' if kind=='escape' else 'bundle/entry')
                if kind in ('symlink','hardlink'):member.type=tarfile.SYMTYPE if kind=='symlink' else tarfile.LNKTYPE;member.linkname='../escaped'
                archive.addfile(member,io.BytesIO())
                if kind=='duplicate':archive.addfile(member,io.BytesIO())
            with self.subTest(kind=kind),self.assertRaises(ValueError):verifier.extract_bundle(artifact,self.root/('extracted-'+str(index)))
        self.assertFalse((self.root/'escaped').exists())

    def test_duplicate_wheel_entries_are_not_accepted(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(self.wheel,'a') as archive:archive.writestr('agent_framework/__init__.py','other bytes')
        with self.assertRaisesRegex(ValueError,'duplicate'):verifier.wheel_manifest(self.wheel)


class RestartVerificationTests(unittest.TestCase):
    def setUp(self):
        self.expected={'settings':{'revision':2},'settings_receipt':{'settings':{'revision':1}},
            'settings_payload':{'request_id':'installed-settings','revision':0},
            'draft':{'draft':{'goal':'independent draft'},'revision':3},
            'agent':{'id':'agent-test','revision':1},'agent_receipt':{'id':'agent-test','save_receipt':{'replayed':True}},
            'agent_payload':{'request_id':'installed-agent'},'task_payload':{'request_id':'installed-task'},
            'submission':{'request_id':'installed-task','run_id':'task-test'},
            'task_run':{'run_id':'task-test','status':'SUCCEEDED','result':'saved answer'},
            'business_run':{'run_id':'business-test','status':'SUCCEEDED'},'external':{'drafts':[{'id':'draft-test'}]}}
        e=self.expected
        self.reads={'/api/runtime-config':{'settings':e['settings']},
            '/api/runtime-config/requests/installed-settings':{'receipt':e['settings_receipt']},
            '/api/task-draft':e['draft'],'/api/agents/agent-test':e['agent'],
            '/api/agents/save-requests/installed-agent':e['agent_receipt'],'/api/agents':{'agents':[e['agent']]},
            '/api/runs':{'counts':{'total':2}},
            '/api/task-submissions/installed-task':{'submission':e['submission'],'run':e['task_run']},
            '/api/runs/business-test':{'run':e['business_run'],'external':e['external']}}
        self.writes={'/api/runtime-config':{'settings':e['settings'],'receipt':e['settings_receipt']},
            '/api/agents':e['agent_receipt'],
            '/api/tasks':{'submission':e['submission'],'run':e['task_run'],'task_draft':e['draft']}}
        self.reads=deepcopy(self.reads);self.writes=deepcopy(self.writes);self.posts=[]

    def api(self,path,data=None):
        if data is not None:self.posts.append((path,data))
        return deepcopy((self.reads if data is None else self.writes)[path])

    def test_restart_accepts_saved_draft_and_versioned_deletion(self):
        verifier.verify_restart_state(self.api,self.expected)
        self.assertEqual([payload['request_id'] for _,payload in self.posts],['installed-settings','installed-agent','installed-task'])
        tombstone={'draft':None,'revision':4}
        self.expected['draft']=tombstone;self.reads['/api/task-draft']=deepcopy(tombstone)
        self.writes['/api/tasks']['task_draft']=deepcopy(tombstone)
        verifier.verify_restart_state(self.api,self.expected)

    def test_restart_rejects_lost_or_changed_durable_data_before_replay(self):
        corruptions={
            '/api/runtime-config':{'settings':{'revision':1}},
            '/api/runtime-config/requests/installed-settings':{'receipt':None},
            '/api/task-draft':{'draft':None,'revision':0},
            '/api/agents/agent-test':{'id':'agent-test','revision':0},
            '/api/agents/save-requests/installed-agent':{'id':'different-agent'},
            '/api/agents':{'agents':[]},'/api/runs':{'counts':{'total':3}},
            '/api/task-submissions/installed-task':{'submission':self.expected['submission'],'run':{'run_id':'task-test','result':'lost answer'}},
            '/api/runs/business-test':{'run':self.expected['business_run'],'external':{'drafts':[]}}}
        for path,value in corruptions.items():
            with self.subTest(path=path),patch.dict(self.reads,{path:value}):
                with self.assertRaisesRegex(ValueError,'installed restart differs'):verifier.verify_restart_state(self.api,self.expected)
                self.assertEqual(self.posts,[])

    def test_restart_rejects_false_replay_receipts(self):
        for path,field,value in [('/api/runtime-config','settings',{'revision':1}),
                ('/api/runtime-config','receipt',None),('/api/agents','id','different-agent'),
                ('/api/tasks','submission',{'run_id':'duplicate-task'}),
                ('/api/tasks','run',{'run_id':'task-test','result':'lost answer'}),
                ('/api/tasks','task_draft',{'draft':None,'revision':4})]:
            with self.subTest(path=path,field=field),patch.dict(self.writes[path],{field:value}):
                with self.assertRaisesRegex(ValueError,'installed restart differs'):verifier.verify_restart_state(self.api,self.expected)

    def test_restart_checks_actual_state_after_successful_replay_responses(self):
        corruptions={'/api/runs':{'counts':{'total':3}},'/api/agents':{'agents':[{},{}]},
            '/api/runtime-config':{'settings':{'revision':1}},'/api/task-draft':{'draft':None,'revision':4},
            '/api/runs/business-test':{'run':self.expected['business_run'],'external':{'drafts':[{},{}]}}}
        for path,value in corruptions.items():
            original=deepcopy(self.reads)
            def side_effect_api(route,data=None):
                result=self.api(route,data)
                if route=='/api/tasks' and data is not None:self.reads[path]=value
                return result
            with self.subTest(path=path),self.assertRaisesRegex(ValueError,'installed restart differs'):
                verifier.verify_restart_state(side_effect_api,self.expected)
            self.reads=original

    def test_shutdown_timeout_kills_and_reaps_before_reporting_failure(self):
        process=Mock();process.poll.return_value=None
        process.wait.side_effect=[subprocess.TimeoutExpired('server',.1),-9]
        self.assertFalse(verifier.stop_server(process,timeout=.1))
        process.send_signal.assert_called_once_with(signal.SIGINT);process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count,2)

    def test_exited_server_cannot_count_as_a_successful_graceful_restart(self):
        process=Mock();process.poll.return_value=1
        self.assertFalse(verifier.stop_server(process));process.send_signal.assert_not_called()


class WorkflowRecoveryVerificationTests(unittest.TestCase):
    def test_lost_state_is_rejected_before_any_replay(self):
        api=Mock()
        with patch.object(verifier,'workflow_recovery_snapshot',return_value={'runs':[]}):
            with self.assertRaisesRegex(ValueError,'workflow recovery differs'):
                verifier.verify_workflow_recovery(api,{'roots':['a','b'],'workspace':'w'},{'runs':['saved']},{})
        api.assert_not_called()

    def test_actual_state_is_rechecked_after_successful_replay(self):
        api=Mock();expected={'runs':['saved']};proposal={'node_id':'review','proposal_token':'a'*64}
        with patch.object(verifier,'workflow_recovery_snapshot',side_effect=[expected,{'runs':['duplicate write']}]):
            with self.assertRaisesRegex(ValueError,'workflow recovery differs'):
                verifier.verify_workflow_recovery(api,{'roots':['a','b'],'workspace':'w'},expected,proposal)
        api.assert_called_once_with('/api/workflow-runs/b/grant',proposal,workspace='w')
