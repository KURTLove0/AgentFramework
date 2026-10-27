"""Business domain persistence, scoped selection, frozen execution and HTTP contracts."""
from copy import deepcopy
import http.client
import json
import tempfile
import threading
import unittest

from agent_framework.agent_domains import AgentDomains
from agent_framework.agents import public_agent_context
from agent_framework.definitions import default_definition
from agent_framework.agent_evaluation import AgentEvaluations
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application, WebServer
from test_workspaces import space


def agent(domain=None, method='knowledge-answer@1.0.0'):
    data=dict(name='客户服务助手',description='回答业务资料问题',runtime='mock',model='builtin',options={},
              prompt='按领域职责和来源证据回答',skills=[],mcp_servers=[],revision=0,
              definition=default_definition('客户服务助手',method))
    if domain:data['processing_domain_id']=domain['id']
    return data


def domain(name='客户服务',method='先确认业务背景，再收集证据、形成结论与后续建议。'):
    return dict(name=name,description='回答客户服务流程、产品使用和售后问题',work_method=method)


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.domains=AgentDomains(self.app.agents.store,self.app.tenant,self.app.workspace['id'])

    def test_persistence_idempotent_retry_and_duplicate_name_conflict(self):
        saved=self.domains.create(domain())
        self.assertEqual(self.domains.create(domain()),saved)
        fresh=AgentDomains(self.app.agents.store,self.app.tenant,self.app.workspace['id'])
        self.assertEqual(fresh.list(),[saved]);self.assertEqual(fresh.get(saved['id']),saved)
        with self.assertRaisesRegex(ConfigConflict,'同名'):
            fresh.create(domain()|{'description':'其他用途'})
        self.assertEqual(fresh.list(),[saved])
        for value in (domain()|{'name':' '},domain()|{'name':'a'*81},domain()|{'description':'a'*1001},domain()|{'domain_pack_ref':'fake@1'},domain()|{'tools':['shell']}):
            with self.assertRaises(ValueError):fresh.create(value)
        for method in ('a'*4001,None,{},['步骤一']):
            with self.assertRaises(ValueError):fresh.create(domain(method=method))

    def test_domain_can_omit_guidance_and_be_reused_by_both_execution_templates(self):
        saved=self.domains.create({'name':'独立业务领域'})
        self.assertEqual(saved['work_method'],'');self.assertNotIn('domain_pack_ref',saved)
        for method in ('knowledge-answer@1.0.0','change-assessment@2.0.0'):
            profile=self.app.agents.save(agent(saved,method))
            compiled=self.app.agents.compile(profile['id'])
            self.assertEqual(compiled['domain_pack']['ref'],method)
            self.assertEqual(compiled['processing_domain'],saved)

    def test_freeform_guidance_is_versioned_and_delivered_without_changing_capabilities(self):
        first=self.domains.create(domain(method='访谈用户 → 分析问题\n输出可执行建议。'))
        data=agent(first);profile=self.app.agents.save(data)
        context=public_agent_context(profile)
        self.assertIn(first['work_method'],context['prompt'])
        updated=self.domains.update(first['id'],domain(method='先收集反馈，再形成归因与建议。')|{'revision':1})
        self.assertIn(first['work_method'],public_agent_context(self.app.agents.get(profile['id']))['prompt'])
        data.update(revision=1,processing_domain_revision=2)
        edited=self.app.agents.save(data,profile['id'])
        self.assertIn(updated['work_method'],public_agent_context(edited)['prompt'])
        self.assertEqual(edited['definition'],profile['definition'])

    def test_legacy_domains_migrate_to_guidance_while_historical_snapshots_remain_exact(self):
        saved=self.domains.create(domain());profile=self.app.agents.save(agent(saved))
        legacy={key:saved[key] for key in ('id','revision','name','description')}
        legacy['domain_pack_ref']='knowledge-answer@1.0.0'
        with self.app.agents.store.connect() as db:
            row=json.loads(db.execute('SELECT data FROM agent_profiles WHERE id=?',(profile['id'],)).fetchone()[0])
            row['processing_domain']=legacy
            db.execute('UPDATE agent_profiles SET data=? WHERE id=?',(json.dumps(row),profile['id']))
            db.execute('UPDATE agent_domains SET data=? WHERE id=?',(json.dumps(legacy),saved['id']))
        before=self.app.agents.compile(profile['id'])
        run=self.app.create({'start':False,'agent_id':profile['id'],'agent_revision':1})['run']
        fresh=AgentDomains(self.app.agents.store,self.app.tenant,self.app.workspace['id'])
        migrated=fresh.get(saved['id']);self.assertEqual(migrated['revision'],2)
        self.assertEqual(migrated['work_method'],'资料问答与来源核对');self.assertNotIn('domain_pack_ref',migrated)
        self.assertEqual(self.app.agents.compile(profile['id']),before)
        result=self.app.runtime().run(run['run_id']);self.assertEqual(result['status'],'SUCCEEDED')
        self.assertEqual(result['snapshot']['compiled_agent']['processing_domain'],legacy)
        self.assertEqual(AgentDomains(self.app.agents.store,self.app.tenant,self.app.workspace['id']).get(saved['id']),migrated)

    def test_domains_and_agent_selection_are_tenant_and_workspace_scoped(self):
        saved=self.domains.create(domain());other=self.app.scoped(self.app.workspaces.save(space())['id'])
        registry=AgentDomains(other.agents.store,other.tenant,other.workspace['id'])
        self.assertEqual(registry.list(),[])
        with self.assertRaises(ValueError):registry.get(saved['id'])
        with self.assertRaises(ValueError):other.agents.save(agent(saved))
        tenant=AgentDomains(self.app.agents.store,'another-tenant',self.app.workspace['id'])
        self.assertEqual(tenant.list(),[])
        self.assertNotEqual(registry.create(domain())['id'],saved['id'])

    def test_custom_domains_compile_execute_and_evaluate_for_both_methods(self):
        for method in ('knowledge-answer@1.0.0','change-assessment@2.0.0'):
            with self.subTest(method=method):
                saved=self.domains.create(domain('业务领域-'+method,method))
                profile=self.app.agents.save(agent(saved,method))
                compiled=self.app.agents.compile(profile['id'])
                self.assertEqual(compiled['processing_domain'],saved)
                self.assertEqual(compiled['evaluation_contract']['processing_domain'],saved)
                self.assertEqual(public_agent_context(profile)['processing_domain'],saved)
                run=self.app.create(dict(start=False,agent_id=profile['id'],agent_revision=1))['run']
                result=self.app.runtime().run(run['run_id'])
                self.assertEqual(result['status'],'SUCCEEDED')
                report=next(r for r in AgentEvaluations(self.app).overview()['reports'] if r['run_id']==run['run_id'])
                self.assertEqual(report['verdict'],'PASS');self.assertEqual(report['score'],100)
                self.assertEqual(report['evaluation_contract']['processing_domain'],saved)

    def test_agent_edits_and_clones_keep_selection_and_old_runs_freeze_domain(self):
        first=self.domains.create(domain());second=self.domains.create(domain('产品研究'))
        data=agent(first);profile=self.app.agents.save(data)
        run=self.app.create(dict(start=False,agent_id=profile['id'],agent_revision=1))['run']
        data.pop('processing_domain_id');data['revision']=1;data['description']='编辑用途'
        edited=self.app.agents.save(data,profile['id']);self.assertEqual(edited['processing_domain'],first)
        self.assertEqual(self.app.agents.evaluation_settings(profile['id'])['contract']['processing_domain'],first)
        clone=deepcopy(data);clone.update(revision=0,processing_domain_id=first['id'])
        self.assertEqual(self.app.agents.save(clone)['processing_domain'],first)
        data.update(revision=2,processing_domain_id=second['id'])
        self.app.agents.save(data,profile['id'])
        result=self.app.runtime().run(run['run_id']);self.assertEqual(result['status'],'SUCCEEDED')
        self.assertEqual(result['snapshot']['compiled_agent']['processing_domain'],first)
        data.update(revision=3,processing_domain_id='')
        self.assertNotIn('processing_domain',self.app.agents.save(data,profile['id']))

    def test_execution_template_is_independent_and_forged_snapshot_is_rejected(self):
        saved=self.domains.create(domain())
        profile=self.app.agents.save(agent(saved,'change-assessment@2.0.0'))
        self.assertEqual(profile['processing_domain'],saved)
        self.assertEqual(profile['definition']['domain_pack_ref'],'change-assessment@2.0.0')
        with self.assertRaises(ValueError):self.app.agents.save(agent()|{'processing_domain':saved})
        self.assertEqual(len(self.app.agents.list()),1)

    def test_edit_keeps_identity_and_frozen_profiles_until_explicit_selection(self):
        first=self.domains.create(domain());data=agent(first)
        profile=self.app.agents.save(data)
        run=self.app.create(dict(start=False,agent_id=profile['id'],agent_revision=1))['run']
        updated=self.domains.update(first['id'],domain('售后支持')|{'revision':1})
        self.assertEqual(updated['id'],first['id']);self.assertEqual(updated['revision'],2)
        self.assertEqual(self.app.agents.get(profile['id'])['processing_domain'],first)
        data.update(revision=1,processing_domain_revision=1)
        self.assertEqual(self.app.agents.save(data,profile['id'])['processing_domain'],first)
        data.update(revision=2,processing_domain_revision=2)
        self.assertEqual(self.app.agents.save(data,profile['id'])['processing_domain'],updated)
        result=self.app.runtime().run(run['run_id'])
        self.assertEqual(result['status'],'SUCCEEDED')
        self.assertEqual(result['snapshot']['compiled_agent']['processing_domain'],first)
        self.assertEqual(self.app.agents.compile(profile['id'])['processing_domain'],updated)
        self.assertEqual(self.domains.catalog()[0]['agent_count'],1)

    def test_archived_domains_stop_new_selection_but_keep_existing_configuration(self):
        saved=self.domains.create(domain());data=agent(saved)
        profile=self.app.agents.save(data)
        archived=self.domains.archive(saved['id'],{'revision':1,'archived':True})
        self.assertTrue(archived['archived']);self.assertEqual(self.domains.list(),[])
        self.assertTrue(self.domains.catalog()[0]['archived'])
        with self.assertRaisesRegex(ValueError,'已归档'):self.app.agents.save(agent(saved))
        with self.assertRaisesRegex(ConfigConflict,'已归档'):self.domains.create(domain())
        data.update(revision=1,processing_domain_revision=1)
        edited=self.app.agents.save(data,profile['id'])
        self.assertEqual(edited['processing_domain'],saved)
        self.assertEqual(self.app.agents.compile(profile['id'])['processing_domain'],saved)
        restored=self.domains.archive(saved['id'],{'revision':2,'archived':False})
        self.assertEqual(restored['revision'],3)
        self.assertEqual(self.app.agents.save(agent(saved))['processing_domain']['revision'],3)

    def test_conflicts_invalid_revisions_and_freeform_method_edits(self):
        first=self.domains.create(domain());other=self.domains.create(domain('产品研究'))
        self.domains.update(first['id'],domain('售后支持')|{'revision':1})
        with self.assertRaises(ConfigConflict):self.domains.update(first['id'],domain()|{'revision':1})
        with self.assertRaises(ConfigConflict):self.domains.archive(first['id'],{'revision':1,'archived':True})
        with self.assertRaisesRegex(ConfigConflict,'同名'):self.domains.update(first['id'],domain(other['name'])|{'revision':2})
        updated=self.domains.update(first['id'],domain('售后支持',method='先访谈，再分析数据，最后给出建议。')|{'revision':2})
        self.assertEqual(updated['work_method'],'先访谈，再分析数据，最后给出建议。')
        self.assertEqual(updated['revision'],3)
        with self.assertRaises(ConfigConflict):self.app.agents.save(agent(first)|{'processing_domain_revision':1})
        for revision in (True,0,-1,'2'):
            with self.assertRaises(ValueError):self.domains.update(first['id'],domain()|{'revision':revision})
            with self.assertRaises(ValueError):self.domains.archive(first['id'],{'revision':revision,'archived':True})
        with self.assertRaises(ValueError):self.app.agents.save(agent()|{'processing_domain_revision':2})
        self.assertEqual(self.domains.get(first['id'])['name'],'售后支持')

    def test_original_name_can_be_reused_after_rename_without_reusing_identity(self):
        first=self.domains.create(domain())
        renamed=self.domains.update(first['id'],domain('售后支持')|{'revision':1})
        second=self.domains.create(domain())
        self.assertNotEqual(second['id'],first['id'])
        self.assertEqual(self.domains.create(domain()),second)
        self.assertEqual(self.domains.create(domain('售后支持')),renamed)

    def test_legacy_domain_schema_is_upgraded_without_changing_its_snapshot(self):
        saved=self.domains.create(domain())
        with self.app.agents.store.connect() as db:
            db.execute('ALTER TABLE agent_domains DROP COLUMN archived')
        upgraded=AgentDomains(self.app.agents.store,self.app.tenant,self.app.workspace['id'])
        self.assertEqual(upgraded.list(),[saved])
        self.assertFalse(upgraded.catalog()[0]['archived'])


class DomainHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.server=WebServer(('127.0.0.1',0),self.app)
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.02},daemon=True);self.thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def request(self,path,body=None,token=True,workspace=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        headers={'Content-Type':'application/json'}
        if token:headers['X-Agent-Token']=self.app.token
        if workspace:headers['X-Agent-Workspace']=workspace
        c.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
        r=c.getresponse();raw=r.read();c.close()
        return r.status,json.loads(raw)

    def test_create_list_select_invalid_and_cross_workspace_routes(self):
        self.assertEqual(self.request('/api/agent-domains')[1],{'domains':[]})
        self.assertEqual(self.request('/api/agent-domains',domain(),token=False)[0],403)
        status,saved=self.request('/api/agent-domains',domain());self.assertEqual(status,201)
        self.assertEqual(self.request('/api/agent-domains',domain())[1],saved)
        self.assertEqual(self.request('/api/agent-domains')[1]['domains'],[saved])
        status,profile=self.request('/api/agents',agent(saved));self.assertEqual(status,201)
        self.assertEqual(profile['processing_domain'],saved)
        self.assertEqual(self.request('/api/agent-domains',domain()|{'name':''})[0],400)
        status,w=self.request('/api/workspaces',space());self.assertEqual(status,201)
        self.assertEqual(self.request('/api/agent-domains',workspace=w['id'])[1]['domains'],[])
        self.assertEqual(self.request('/api/agents',agent(saved),workspace=w['id'])[0],400)

    def test_manage_domains_with_revision_scope_and_token_checks(self):
        _,saved=self.request('/api/agent-domains',domain())
        url='/api/agent-domains/'+saved['id']
        self.assertEqual(self.request(url)[1],saved)
        payload=domain('售后支持')|{'revision':1}
        self.assertEqual(self.request(url,payload,token=False)[0],403)
        status,updated=self.request(url,payload);self.assertEqual(status,200)
        self.assertEqual(updated['revision'],2);self.assertEqual(self.request(url,payload)[0],409)
        _,w=self.request('/api/workspaces',space())
        self.assertEqual(self.request(url,workspace=w['id'])[0],400)
        self.assertEqual(self.request(url,domain()|{'revision':2},workspace=w['id'])[0],400)
        self.assertEqual(self.request(url+'/archive',{'revision':2,'archived':True},workspace=w['id'])[0],400)
        self.assertEqual(self.request(url+'/archive',{'revision':2,'archived':True},token=False)[0],403)
        self.assertEqual(self.request(url+'/archive',{'revision':2,'archived':True})[0],200)
        self.assertEqual(self.request('/api/agent-domains')[1],{'domains':[]})
        catalog=self.request('/api/agent-domains?include_archived=1')[1]['domains']
        self.assertTrue(catalog[0]['archived']);self.assertEqual(catalog[0]['agent_count'],0)
        self.assertEqual(self.request(url+'/archive',{'revision':3,'archived':False})[0],200)
        self.assertEqual(self.request('/api/agent-domains')[1]['domains'][0]['revision'],4)
