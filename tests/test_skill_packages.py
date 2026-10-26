"""Agent Skills interoperability, progressive disclosure and governed execution."""
import base64
from copy import deepcopy
import http.client
import io
import json
from pathlib import Path
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

from agent_framework.skills import normalize_package,import_zip,export_zip,validate_frozen,SkillRegistry
from agent_framework.web import Application,WebServer
from agent_framework.contracts import TaskContract,PolicyDenied,digest
from agent_framework.agents import agent_ref,public_agent_context
from agent_framework.definitions import default_definition,AgentCompiler
from agent_framework.llm import LLMPlanner,CodexConfig,SYSTEM
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime import Runtime,CrashInjected
from agent_framework.runtime_config import ConfigConflict
from tests.test_llm import FixtureTransport


def package(name='release-check',body=None):
    body=body or '# 发布证据复核\n\n用于模拟变更风险评审。验收前读取 [清单](references/check.md)。'
    return {'folder':name,'revision':0,'files':{'SKILL.md':{'encoding':'utf-8','content':f'---\nname: {name}\ndescription: |\n  核对模拟变更风险证据。\n  用于发布评估与草稿复核。\nlicense: MIT\ncompatibility: 模拟业务工具\nmetadata:\n  author: "test"\n  version: "1.0"\nallowed-tools: "Read Bash(*)"\n---\n\n'+body+'\n'},'references/check.md':{'encoding':'utf-8','content':'REF_ONLY_AFTER_READ：确认测试与回滚证据完整。'},'references/unneeded.md':{'encoding':'utf-8','content':'UNNEEDED_RESOURCE_MARKER'},'assets/sample.bin':{'encoding':'base64','content':base64.b64encode(b'\xff\x00\x81').decode()}}}


def agent_data(bindings=(),provider='mock'):
    return {'name':'模拟技能岗位','description':'固定模拟 Skill 验证','runtime':provider,'model':'builtin' if provider=='mock' else 'fixture-model',
            'options':{} if provider=='mock' else {'timeout':5,'max_attempts':1,'reasoning_effort':'low'},'prompt':'按证据完成模拟评估，独立验收结果。',
            'skills':[],'mcp_servers':[],'definition':default_definition('模拟技能岗位'),'revision':0,'skill_bindings':list(bindings)}


class SkillFixture(FixtureTransport):
    def __init__(self,mutate=None):super().__init__(mutate);self.selection_requests=[]
    def generate(self,prompt,schema,config,timeout):
        request=json.loads(prompt[prompt.index('\n{')+1:]);phase=request['phase'];wire=request['context']
        if phase in ('skill_activate','skill_resources'):
            self.selection_requests.append(request)
            refs=wire['configured_agent']['available_skills']
            result={'activate':[refs[0]['ref']]} if phase=='skill_activate' else {'reads':[{'ref':refs[0]['ref'],'path':'references/check.md'}]}
            if self.mutate:result=self.mutate(phase,result)
            return json.dumps(result),{'usage':{'input_tokens':7,'output_tokens':3}}
        return super().generate(SYSTEM+'\n'+json.dumps(request),schema,config,timeout)


class SkillPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.app=Application(self.temp.name,lease_seconds=.8,tool_timeout=.3);self.addCleanup(self.app.close);self.registry=self.app.skills()

    def published(self,name='release-check'):
        s=self.registry.save(package(name));return self.registry.lifecycle(s['id'],s['revision'],'publish',s['version'])

    def binding(self,s):return {'skill_id':s['id'],'version':s['version'],'enabled':True}

    def test_standard_yaml_optional_metadata_and_binary_zip_round_trip(self):
        p,w=normalize_package('release-check',package()['files']);self.assertIn('核对模拟',p['metadata']['description']);self.assertEqual(p['metadata']['metadata']['version'],'1.0')
        self.assertTrue(any('allowed-tools' in v for v in w));raw=export_zip(p);folder,entries=import_zip(base64.b64encode(raw).decode())
        rebuilt,_=normalize_package(folder,entries);self.assertEqual(rebuilt,p);validate_frozen(p)
        self.assertEqual(p['files']['assets/sample.bin']['encoding'],'base64')

    def test_rejects_invalid_standard_frontmatter_and_names(self):
        originals=package()['files'];source=originals['SKILL.md']['content']
        for text in (source.replace('name: release-check','name: Release-Check'),source.replace('name: release-check','name: release--check'),source.replace('name: release-check','name: another'),'name: release-check\n',source.replace('license: MIT','license: MIT\nlicense: MIT'),source.replace('license: MIT','license: !!python/object:os.system {}'),source.replace('version: "1.0"','version: 1.0')):
            files=deepcopy(originals);files['SKILL.md']['content']=text
            with self.assertRaises(ValueError):normalize_package('release-check',files)
        for name in ('-abc','abc-','abc--def','UPPER','bad_name','a'*65):
            with self.assertRaises(ValueError):normalize_package(name,originals)

    def test_paths_symlinks_zip_bombs_duplicate_files_and_aliases_are_rejected(self):
        for path in ('../secret','/root/file','scripts/../../secret','C:/secret','a\\b','a//b'):
            files=deepcopy(package()['files']);files[path]={'encoding':'utf-8','content':'x'}
            with self.assertRaises(ValueError):normalize_package('release-check',files)
        files=deepcopy(package()['files']);files['skill.md']=files['SKILL.md']
        with self.assertRaises(ValueError):normalize_package('release-check',files)
        for filename,content,symlink in [('release-check/../secret',b'x',False),('release-check/scripts/run',b'/etc/passwd',True),('release-check/large',b'x'*96001,False)]:
            buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:
                info=zipfile.ZipInfo(filename)
                if symlink:info.external_attr=(stat.S_IFLNK|0o777)<<16
                z.writestr(info,content)
            with self.assertRaises(ValueError):import_zip(base64.b64encode(buffer.getvalue()).decode())
        files=deepcopy(package()['files']);files['SKILL.md']['content']=files['SKILL.md']['content'].replace('license: MIT','license: &tag MIT\ncompatibility: *tag')
        with self.assertRaises(ValueError):normalize_package('release-check',files)

    def test_registry_versions_publish_withdraw_archive_and_workspace_scope(self):
        s=self.published();old=deepcopy(s['package']);data=package();data['revision']=s['revision'];data['files']['references/check.md']['content']='新版本'
        newer=self.registry.save(data,s['id']);self.assertEqual(newer['version'],2);self.assertEqual(newer['status'],'DRAFT')
        self.assertEqual(self.registry.get(s['id'],1)['package'],old)
        with self.assertRaises(ConfigConflict):self.registry.save(data,s['id'])
        with self.assertRaises(ValueError):self.registry.resolve(self.binding(newer))
        other=SkillRegistry(self.app.runtime().store,self.app.tenant,'workspace-other')
        with self.assertRaises(KeyError):other.get(s['id'])
        self.registry.lifecycle(s['id'],newer['revision'],'withdraw',1)
        with self.assertRaises(ValueError):self.registry.resolve(self.binding(s))
        head=self.registry.get(s['id']);archived=self.registry.lifecycle(s['id'],head['revision'],'archive',2)
        self.assertTrue(archived['archived']);restored=self.registry.lifecycle(s['id'],archived['revision'],'restore',2);self.assertFalse(restored['archived'])
        self.assertTrue(self.registry.events(s['id']))

    def test_agent_binding_pins_package_and_old_clients_preserve_binding(self):
        s=self.published();data=agent_data([self.binding(s)]);p=self.app.agents.save(data)
        self.assertEqual(p['skill_packages'][0]['package'],s['package']);self.assertEqual(AgentCompiler().compile(p)['skills'][-1]['kind'],'agent-skill-package')
        data.pop('skill_bindings');data['revision']=1;p2=self.app.agents.save(data,p['id']);self.assertEqual(p2['skill_packages'],p['skill_packages'])
        update=package();update['revision']=s['revision'];update['files']['references/check.md']['content']='新版方法'
        newer=self.registry.save(update,s['id']);self.registry.lifecycle(s['id'],newer['revision'],'publish',2)
        self.assertEqual(p2['skill_bindings'][0]['version'],1);self.assertEqual(p2['skill_packages'][0]['package'],s['package'])
        bad=agent_data([self.binding(s)]);bad['skill_packages']=p['skill_packages']
        with self.assertRaises(ValueError):self.app.agents.save(bad)

    def test_withdrawn_binding_blocks_new_task_but_existing_snapshot_recovers(self):
        s=self.published();p=self.app.agents.save(agent_data([self.binding(s)]));r=self.app.runtime();run=r.submit(TaskContract(agent_ref=agent_ref(p)),agent_profile=p,scenario='crash-after-write')
        with self.assertRaises(CrashInjected):r.run(run['run_id'])
        snapshot=r.store.load(self.app.tenant,run['run_id'])['snapshot'];self.registry.lifecycle(s['id'],s['revision'],'withdraw',1)
        with self.assertRaises(ValueError):self.app.agents.compile(p['id'])
        with self.assertRaises(ValueError):self.app.create({'agent_id':p['id'],'agent_revision':1,'start':False})
        time.sleep(.9);result=r.run(run['run_id']);self.assertEqual(result['status'],'SUCCEEDED');self.assertEqual(result['snapshot'],snapshot)
        stats=r.external.stats(self.app.tenant,run['run_id']);self.assertEqual(len(stats['drafts']),stats['calls']['report.draft.create@1.0.0']);self.assertEqual(len(stats['drafts']),1)
        data=agent_data([self.binding(s)|{'enabled':False}]);data['revision']=1;disabled=self.app.agents.save(data,p['id']);self.app.agents.assert_skills_available(disabled)

    def test_progressive_disclosure_only_selected_body_and_requested_resource_reach_model(self):
        s=self.published();irrelevant=self.published('unrelated-method');data=agent_data([self.binding(s),self.binding(irrelevant)],'codex')
        with patch.object(ModelCatalog,'require',return_value={'efforts':['low']}):p=self.app.agents.save(data)
        fixture=SkillFixture();planner=LLMPlanner(CodexConfig('fixture-model','low',5,1),fixture,agent_profile=p);runtime=Runtime(self.temp.name,planner=planner,lease_seconds=.8,tool_timeout=.3)
        run=runtime.submit(TaskContract(agent_ref=agent_ref(p)),agent_profile=p);result=runtime.run(run['run_id']);self.assertEqual(result['status'],'SUCCEEDED')
        first=fixture.selection_requests[0]['context'];second=fixture.selection_requests[1]['context'];planned=fixture.requests[0]['context']
        self.assertEqual(first['activated_skills'],[]);self.assertNotIn('REF_ONLY_AFTER_READ',json.dumps(first));self.assertNotIn('发布证据复核',json.dumps(first,ensure_ascii=False))
        self.assertIn('发布证据复核',json.dumps(second,ensure_ascii=False));self.assertNotIn('REF_ONLY_AFTER_READ',json.dumps(second))
        self.assertIn('REF_ONLY_AFTER_READ',json.dumps(planned));self.assertNotIn('UNNEEDED_RESOURCE_MARKER',json.dumps(planned))
        self.assertEqual(len(planned['activated_skills']),1);self.assertEqual(len(result['skill_context']['resource_reads']),1)
        self.assertEqual(len(fixture.selection_requests),2);self.assertEqual(result['model_calls'],len(fixture.requests)+2)
        restored=LLMPlanner.restore(result['snapshot']['planner']);self.assertEqual(restored.descriptor(),result['snapshot']['planner'])

    def test_skill_cannot_grant_tools_cross_package_reads_or_execute_scripts(self):
        data=package();marker=Path(self.temp.name)/'must-not-exist';data['files']['scripts/run.py']={'encoding':'utf-8','content':f'from pathlib import Path\nPath({str(marker)!r}).write_text("bad")'}
        data['files']['SKILL.md']['content']+='\n参考 [脚本](scripts/run.py)。\n';s=self.registry.save(data);s=self.registry.lifecycle(s['id'],s['revision'],'publish',1)
        p=self.app.agents.save(agent_data([self.binding(s)]));run=self.app.runtime().submit(TaskContract(agent_ref=agent_ref(p),goal='使用 $release-check 评估模拟变更'),agent_profile=p,grant=False)
        result=self.app.runtime().run(run['run_id']);self.assertEqual(result['status'],'WAITING_AUTH');self.assertFalse(marker.exists());self.assertEqual(self.app.runtime().external.stats(self.app.tenant,run['run_id'])['drafts'],[])
        self.assertNotIn('Bash(*)',result['snapshot']['compiled_agent']['capabilities'])
        from agent_framework.skill_context import bundle
        with self.assertRaises(ValueError):bundle(p,{'activated_refs':[p['skill_packages'][0]['ref']],'resource_reads':[{'ref':'foreign@1','path':'scripts/run.py'}],'ready':True})
        forged=deepcopy(p['skill_packages'][0]['package']);forged['files']['SKILL.md']['content']+='tampered'
        with self.assertRaises(ValueError):validate_frozen(forged)

    def test_new_skill_schema_uses_registered_verifiers_and_earlier_descriptors_restore(self):
        s=self.published();data=agent_data([self.binding(s)],'codex')
        with patch.object(ModelCatalog,'require',return_value={'efforts':['low']}):p=self.app.agents.save(data)
        current=LLMPlanner(CodexConfig('fixture-model','low',5,1),agent_profile=p)
        self.assertEqual(current.agent_prompt_version,6)
        action_schema=current.schemas()['decide']['properties']['action']['anyOf'][0]['anyOf'][0]
        checks=action_schema['properties']['expected_checks']['items']['enum']
        self.assertIn('schema-and-scope',checks);self.assertNotIn('核对项目与变更标识',checks)
        from agent_framework.structured import SCHEMAS
        self.assertNotIn('enum',SCHEMAS['decide']['properties']['action']['anyOf'][0]['anyOf'][0]['properties']['expected_checks']['items'])
        for version in (1,2,3,4,5,6):
            prior=LLMPlanner(CodexConfig('fixture-model','low',5,1),agent_profile=p,agent_prompt_version=version)
            self.assertEqual(LLMPlanner.restore(prior.descriptor()).descriptor(),prior.descriptor())

    def test_workflow_designer_uses_bound_skill_without_business_execution(self):
        from agent_framework.workflow_chat import WorkflowChat,RESPONSE
        from agent_framework.llm import CodexTransport
        s=self.published();data=agent_data([self.binding(s)],'codex')
        with patch.object(ModelCatalog,'require',return_value={'efforts':['low']}):p=self.app.agents.save(data)
        selected=p['skill_packages'][0]['ref'];requests=[]
        def generate(prompt,schema,config,timeout):
            requests.append(prompt)
            if set(schema['properties'])=={'activate'}:result={'activate':[selected]}
            elif set(schema['properties'])=={'reads'}:result={'reads':[{'ref':selected,'path':'references/check.md'}]}
            else:result={'reply':'请补充执行岗位名称','workflow':None}
            return json.dumps(result),{'usage':{'input_tokens':1,'output_tokens':1}}
        with patch.object(CodexTransport,'generate',side_effect=generate):
            response=WorkflowChat(self.app).reply({'agent_id':p['id'],'message':'使用 $release-check 设计模拟评审流程','consent':True})
        self.assertEqual(len(requests),3);self.assertNotIn('REF_ONLY_AFTER_READ',requests[0]);self.assertNotIn('REF_ONLY_AFTER_READ',requests[1]);self.assertIn('REF_ONLY_AFTER_READ',requests[2])
        self.assertEqual(len(response['skill_selection_usage']),2);self.assertFalse(self.app.runs()['runs']);self.assertFalse(self.app.workflows().list())

    def test_disabled_bindings_do_not_load_model_content_or_change_old_contract_shape(self):
        s=self.published();p=self.app.agents.save(agent_data([self.binding(s)|{'enabled':False}]))
        self.assertEqual(public_agent_context(p)['available_skills'],[])
        run=self.app.runtime().submit(TaskContract(agent_ref=agent_ref(p)),agent_profile=p);result=self.app.runtime().run(run['run_id']);self.assertNotIn('skill_context',result)
        self.assertEqual(LLMPlanner(CodexConfig('fixture-model'),agent_profile=p).agent_prompt_version,4)
        legacy=self.app.agents.save(agent_data());self.assertNotIn('skill_packages',legacy);self.assertNotIn('skill_bindings',legacy)


class SkillHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.app=Application(self.temp.name);self.addCleanup(self.app.close)
        self.server=WebServer(('127.0.0.1',0),self.app);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.addCleanup(self.stop)
    def stop(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def request(self,path,data=None,space=None,token=True):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5);headers={}
        if data is not None:headers={'Content-Type':'application/json',**({'X-Agent-Token':self.app.token} if token else {})}
        if space:headers['X-Agent-Workspace']=space
        c.request('POST' if data is not None else 'GET',path,None if data is None else json.dumps(data),headers);response=c.getresponse();raw=response.read();mime=response.getheader('Content-Type');status=response.status;c.close()
        return status,json.loads(raw) if mime.startswith('application/json') else raw
    def test_api_module_standard_zip_lifecycle_and_workspace_isolation(self):
        status,catalog=self.request('/api/skills');self.assertEqual(status,200);self.assertEqual(len(catalog['skills']),2)
        self.assertEqual(self.request('/api/skills',package(),token=False)[0],403)
        status,s=self.request('/api/skills',package());self.assertEqual(status,201)
        status,s=self.request('/api/skills/'+s['id']+'/publish',{'revision':s['revision'],'version':1});self.assertEqual(s['status'],'PUBLISHED')
        status,zipped=self.request('/api/skills/'+s['id']+'/export?version=1');self.assertEqual(status,200);self.assertTrue(zipfile.is_zipfile(io.BytesIO(zipped)))
        space=self.app.workspaces.save({'name':'其他场景','business':'模拟','scenario':'隔离','description':'','revision':0})
        self.assertEqual(self.request('/api/skills/'+s['id'],space=space['id'])[0],404)
        status,copy=self.request('/api/skills/import',{'zip_base64':base64.b64encode(zipped).decode(),'revision':0,'skill_id':None},space=space['id']);self.assertEqual(status,201);self.assertEqual(copy['hash'],s['hash'])
        status,agent=self.request('/api/agents',agent_data([{'skill_id':s['id'],'version':1,'enabled':True}]));self.assertEqual(status,201);self.assertEqual(agent['skill_bindings'][0]['version'],1)
        self.assertEqual(self.request('/skills.js')[0],200)
    def test_legacy_inline_migration_creates_standard_draft_and_preserves_agent(self):
        d=agent_data();d['skills']=[{'name':'旧方法','instructions':'核对模拟测试证据。','enabled':True}];p=self.app.agents.save(d)
        status,s=self.request('/api/skills/migrate',{'agent_id':p['id'],'agent_revision':1,'index':0});self.assertEqual(status,201);self.assertEqual(s['status'],'DRAFT')
        self.assertIn('SKILL.md',s['package']['files']);self.assertEqual(self.app.agents.get(p['id'])['skills'],d['skills'])
        self.assertEqual(self.request('/api/skills/migrate',{'agent_id':p['id'],'agent_revision':1,'index':0})[1]['id'],s['id'])
