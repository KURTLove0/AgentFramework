"""Agent directory reads omit frozen resource bodies without changing execution."""
from copy import deepcopy
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework import agents as agent_module
from agent_framework.agents import AgentRegistry
from agent_framework.definitions import default_definition
from agent_framework.store import Store
from agent_framework.web import Application,WebServer


def payload():
    return {'name':'目录验收助手','description':'保留岗位与工作方法','runtime':'mock','model':'builtin','options':{},'prompt':'按用户目标完成任务。',
        'skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('目录验收助手','general-assistant@1.0.0')}


def project(profile):
    result=deepcopy(profile);packages=result.pop('skill_packages',[])
    for item in packages:item['package'].pop('files')
    return {**result,'catalog_only':True,'skill_summaries':packages}


class AgentCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)

    def configured(self,count=1):
        registry=self.app.skills();bindings=[]
        for index in range(count):
            name='catalog-method-'+str(index)
            skill=registry.save({'folder':name,'revision':0,'files':{
                'SKILL.md':{'encoding':'utf-8','content':'---\nname: '+name+'\ndescription: 核对来源\n---\n\n仅使用绑定版本的方法。\n'},
                'references/source.md':{'encoding':'utf-8','content':'CATALOG_RESOURCE_ONLY_'+'x'*49152},
                'assets/sample.bin':{'encoding':'base64','content':'/wCB'}}})
            registry.lifecycle(skill['id'],skill['revision'],'publish',1)
            bindings.append({'skill_id':skill['id'],'version':1,'enabled':index%2==0})
        profile=self.app.agents.save({**payload(),'skill_bindings':bindings});return profile

    def test_catalog_preserves_all_profile_fields_except_complete_skill_packages(self):
        saved=self.configured(4);actual=self.app.agents.catalog()
        self.assertEqual(actual,[project(saved)]);self.assertNotIn('skill_packages',actual[0])
        self.assertEqual(len(actual[0]['skill_summaries']),4)
        self.assertEqual([s['enabled'] for s in actual[0]['skill_summaries']],[True,False,True,False])

    def test_full_list_and_detail_still_return_complete_frozen_packages(self):
        saved=self.configured();self.assertEqual(self.app.agents.list(),[saved]);self.assertEqual(self.app.agents.get(saved['id']),saved)
        self.assertIn('assets/sample.bin',saved['skill_packages'][0]['package']['files'])
        self.assertEqual(saved['skill_packages'][0]['package']['files']['assets/sample.bin']['encoding'],'base64')

    def test_catalog_does_not_send_resource_bodies_to_python_json_decoder(self):
        saved=self.configured(4);loads=agent_module.json.loads;decoded=[];sql=[];connect=Store.connect
        def decode(value,*args,**kwargs):
            if isinstance(value,str):decoded.append(value)
            return loads(value,*args,**kwargs)
        def traced(store):
            db=connect(store);db.set_trace_callback(sql.append);return db
        with patch.object(agent_module.json,'loads',decode),patch.object(Store,'connect',traced):catalog=self.app.agents.catalog()
        self.assertEqual(catalog,[project(saved)]);self.assertTrue(decoded)
        self.assertTrue(all('CATALOG_RESOURCE_ONLY_' not in value for value in decoded))
        self.assertEqual(sum(s.lstrip().upper().startswith('SELECT') for s in sql),1)

    def test_profiles_without_extra_skills_keep_their_definition_and_empty_summary(self):
        saved=self.app.agents.save(payload());row=self.app.agents.catalog()[0]
        self.assertEqual(row,project(saved));self.assertEqual(row['skill_summaries'],[])

    def test_archived_profiles_remain_readable_in_the_directory(self):
        saved=self.configured();archived=self.app.agents.archive(saved['id'],saved['revision'])
        self.assertEqual(self.app.agents.catalog(),[project(archived)])

    def test_bound_old_method_is_not_replaced_when_the_live_skill_changes_or_is_withdrawn(self):
        saved=self.configured();binding=saved['skill_bindings'][0];registry=self.app.skills();first=registry.get(binding['skill_id'])
        files={p:{k:v[k] for k in ('encoding','content')} for p,v in first['package']['files'].items()}
        files['SKILL.md']['content']+='\n第二版方法，不应替换原绑定。'
        latest=registry.save({'folder':first['name'],'revision':first['revision'],'files':files},first['id'])
        registry.lifecycle(first['id'],latest['revision'],'withdraw',1)
        row=self.app.agents.catalog()[0];self.assertEqual(row,project(saved))
        self.assertNotIn('第二版',row['skill_summaries'][0]['package']['body'])

    def test_catalog_scope_excludes_other_workspaces_and_tenants(self):
        saved=self.configured()
        with self.app.agents.store.transaction() as db:
            row=db.execute('SELECT * FROM agent_profiles WHERE tenant=? AND id=?',(self.app.tenant,saved['id'])).fetchone()
            for tenant,identity,workspace in ((self.app.tenant,'agent-other-space','workspace-other'),('tenant-other',saved['id'],self.app.workspace['id'])):
                db.execute('INSERT INTO agent_profiles VALUES(?,?,?,?,?,?,?,?)',(tenant,identity,row['revision'],row['data'],row['created'],row['updated'],row['archived'],workspace))
        self.assertEqual(self.app.agents.catalog(),[project(saved)])
        other=AgentRegistry(self.tmp.name,'tenant-other',self.app.configuration,self.app.models,self.app.workspace['id'])
        self.assertEqual(len(other.catalog()),1);self.assertEqual(other.catalog()[0]['id'],saved['id'])

    def test_catalog_order_is_stable_when_update_times_tie(self):
        one=self.app.agents.save(payload());two=self.app.agents.save({**payload(),'name':'另一个助手'})
        with self.app.agents.store.transaction() as db:db.execute('UPDATE agent_profiles SET updated=1 WHERE tenant=?',(self.app.tenant,))
        self.assertEqual([p['id'] for p in self.app.agents.catalog()],sorted([one['id'],two['id']]))

    def test_http_catalog_is_explicit_and_default_full_reads_remain_compatible(self):
        saved=self.configured();server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(3)))
        def request(path):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=5)
            try:
                connection.request('GET',path,headers={'X-Agent-Workspace':self.app.workspace['id']});response=connection.getresponse()
                return response.status,json.loads(response.read())
            finally:connection.close()
        status,catalog=request('/api/agents?view=catalog');self.assertEqual(status,200);self.assertEqual(catalog,{'agents':[project(saved)]})
        self.assertEqual(request('/api/agents'),(200,{'agents':[saved]}));self.assertEqual(request('/api/agents?view=full'),(200,{'agents':[saved]}))
        self.assertEqual(request('/api/agents/'+saved['id']),(200,saved))
        self.assertEqual(request('/api/agents?view=other')[0],400);self.assertEqual(request('/api/agents?view=catalog&view=full')[0],400)


if __name__=='__main__':unittest.main()
