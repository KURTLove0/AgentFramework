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


def domain(name='客户服务',method='knowledge-answer@1.0.0'):
    return dict(name=name,description='回答客户服务流程、产品使用和售后问题',domain_pack_ref=method)


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

    def test_method_mismatch_and_forged_domain_snapshot_are_rejected(self):
        saved=self.domains.create(domain())
        with self.assertRaisesRegex(ValueError,'工作方式'):
            self.app.agents.save(agent(saved,'change-assessment@2.0.0'))
        with self.assertRaises(ValueError):self.app.agents.save(agent()|{'processing_domain':saved})
        self.assertEqual(self.app.agents.list(),[])


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
