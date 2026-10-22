from copy import deepcopy
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest

from agent_framework.web import Application, WebServer
from agent_framework.contracts import PolicyDenied, digest
from agent_framework.runtime_config import ConfigConflict
from agent_framework.agents import AgentRegistry
from agent_framework.definitions import default_definition


def space(name='交易空间'):
    return dict(name=name,business='交易业务',scenario='发布评估',description='按交易业务组织模拟任务',revision=0)


def role(name='交易审核岗位',domain='change-assessment@2.0.0'):
    d=default_definition(name,domain)
    d['identity'].update(role='发布质量负责人',owner_team='交易技术')
    d['responsibilities'][0]['description']='核对交易变更的风险、测试与回滚证据'
    return dict(name=name,description='交易业务发布审核',runtime='mock',model='builtin',options={},prompt='以模拟证据完成岗位职责。',skills=[],mcp_servers=[],revision=0,definition=d)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(self.app.close)

    def test_crud_versions_reversible_delete_and_tenant_isolation(self):
        w=self.app.workspaces.save(space());self.assertEqual(w['revision'],1)
        updated=self.app.workspaces.save(space('交易风险空间')|{'revision':1},w['id'])
        self.assertEqual(updated['project_id'],w['project_id']);self.assertEqual(updated['revision'],2)
        with self.assertRaises(ConfigConflict):self.app.workspaces.save(space()|{'revision':1},w['id'])
        with self.assertRaises(ValueError):self.app.workspaces.save(space('交易风险空间'))
        deleted=self.app.workspaces.lifecycle(w['id'],2,True)
        self.assertTrue(deleted['deleted'])
        with self.assertRaises(KeyError):self.app.scoped(w['id'])
        restored=self.app.workspaces.lifecycle(w['id'],3,False);self.assertFalse(restored['deleted'])
        self.assertEqual(restored['project_id'],w['project_id'])
        other=Application(self.tmp.name,tenant='other');self.addCleanup(other.close)
        with self.assertRaises(KeyError):other.workspaces.get(w['id'])
        self.assertEqual(len(other.workspaces.list()),1)
        other.workspaces.save(space())

    def test_last_space_and_unfinished_tasks_cannot_be_deleted(self):
        with self.assertRaises(ConfigConflict):self.app.workspaces.lifecycle('workspace-default',1,True)
        w=self.app.workspaces.save(space());scoped=self.app.scoped(w['id'])
        d=scoped.create({'start':False,'runtime':'mock'})
        with self.assertRaisesRegex(ConfigConflict,'未完成'):self.app.workspaces.lifecycle(w['id'],1,True)
        scoped.mutate(d['run']['run_id'],'cancel')
        self.assertTrue(self.app.workspaces.lifecycle(w['id'],1,True)['deleted'])
        with self.assertRaises(KeyError):scoped.create({'start':False})

    def test_restart_with_deleted_default_uses_surviving_workspace(self):
        w=self.app.workspaces.save(space())
        self.app.workspaces.lifecycle('workspace-default',1,True)
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(restarted.workspace['id'],w['id'])
        self.assertTrue(next(s for s in restarted.workspaces.list() if s['id']=='workspace-default')['deleted'])
        p=restarted.agents.save(role())
        self.assertEqual(restarted.scoped(w['id']).agents.get(p['id'])['name'],p['name'])

    def test_agents_runs_sources_memories_are_scoped_and_survive_restore(self):
        w=self.app.workspaces.save(space());a=self.app.scoped(w['id']);profile=a.agents.save(role())
        self.assertEqual(self.app.agents.list(),[])
        for op in (lambda:self.app.agents.get(profile['id']),lambda:self.app.agents.archive(profile['id'],1),lambda:self.app.agents.compile(profile['id'])):
            with self.assertRaises(KeyError):op()
        d=a.create({'runtime':'mock','agent_id':profile['id'],'agent_revision':1,'start':False})
        run=d['run']['run_id'];snapshot=deepcopy(d['run']['snapshot'])
        for op in (lambda:self.app.detail(run),lambda:self.app.mutate(run,'cancel'),lambda:self.app.schedule(run)):
            with self.assertRaises(PolicyDenied):op()
        with self.assertRaises(PolicyDenied):a.create({'project_id':'project-demo','start':False})
        with self.assertRaises(PolicyDenied):a.library_access('project-demo')
        self.assertEqual(self.app.runs()['counts']['total'],0)
        self.assertEqual(a.runs()['counts']['total'],1)
        asset=a.library().create(a.library_access(),{'kind':'KNOWLEDGE','title':'交易知识','content':{'text':'交易资料仅属于本业务空间。'}})
        self.assertFalse(self.app.library().list(self.app.library_access(),include_unpublished=True))
        a.runtime().run(run)
        finished=a.detail(run);self.assertEqual(finished['run']['status'],'SUCCEEDED')
        self.assertEqual(finished['run']['snapshot'],snapshot)
        self.assertEqual(finished['external']['calls']['report.draft.create@1.0.0'],1)
        self.app.workspaces.lifecycle(w['id'],1,True);self.app.workspaces.lifecycle(w['id'],2,False)
        restored=self.app.scoped(w['id'])
        self.assertEqual(restored.agents.get(profile['id'])['definition'],profile['definition'])
        self.assertEqual(restored.detail(run)['run']['snapshot'],snapshot)
        self.assertEqual(restored.library().get(restored.library_access(),asset['ref'],review=True)['title'],'交易知识')
        from agent_framework.memory import episodes
        self.assertEqual(len(episodes(restored.runtime().store,restored.library_access())),1)
        self.assertEqual(episodes(self.app.runtime().store,self.app.library_access()),[])

    def test_visual_role_fields_compile_and_freeze_across_agent_edits(self):
        profile=self.app.agents.save(role());compiled=self.app.agents.compile(profile['id'])
        self.assertEqual(compiled['definition']['identity']['role'],'发布质量负责人')
        self.assertEqual(compiled['definition']['responsibilities'][0]['description'],'核对交易变更的风险、测试与回滚证据')
        d=self.app.create({'agent_id':profile['id'],'agent_revision':1,'start':False,'scenario':'response-lost'})
        data=role('交易复核岗位');data['revision']=1;data['definition']['identity']['owner_team']='交易保障';self.app.agents.save(data,profile['id'])
        r=self.app.runtime().run(d['run']['run_id']);self.assertEqual(r['status'],'SUCCEEDED')
        self.assertEqual(r['snapshot']['compiled_agent']['hash'],compiled['hash'])
        self.assertEqual(r['snapshot']['agent']['identity']['owner_team'],'交易技术')
        self.assertTrue(all(c['passed'] for c in r['checks'].values()))
        stats=self.app.runtime().external.stats('tenant-demo',r['run_id']);self.assertEqual(len(stats['drafts']),1)
        qa=self.app.agents.save(role('知识岗位','knowledge-answer@1.0.0'));c=self.app.agents.compile(qa['id'])
        self.assertTrue(all(cap['effect']=='READ' for cap in c['capabilities'].values()))
        bad=role();bad['definition']['standard_refs']=['report-evidence@1.0.0'];bad=self.app.agents.save(bad)
        with self.assertRaisesRegex(ValueError,'standards'):self.app.agents.compile(bad['id'])

    def test_legacy_profiles_migrate_without_mutating_data_or_run_hashes(self):
        profile=self.app.agents.save(role());d=self.app.create({'start':False})
        before=d['run']['snapshot']['hash']
        with self.app.runtime().store.connect() as db:
            data=db.execute('SELECT data FROM agent_profiles WHERE id=?',(profile['id'],)).fetchone()[0]
            db.execute('ALTER TABLE agent_profiles DROP COLUMN workspace_id')
        registry=AgentRegistry(self.tmp.name,'tenant-demo',self.app.configuration,self.app.models)
        self.assertEqual(registry.get(profile['id'])['name'],profile['name'])
        with registry.store.connect() as db:self.assertEqual(db.execute('SELECT data FROM agent_profiles WHERE id=?',(profile['id'],)).fetchone()[0],data)
        self.assertEqual(self.app.detail(d['run']['run_id'])['run']['snapshot']['hash'],before)


class WorkspaceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.server=WebServer(('127.0.0.1',0),self.app)
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.02},daemon=True);self.thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def request(self,path,body=None,workspace=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        headers={'Content-Type':'application/json','X-Agent-Token':self.app.token}
        if workspace:headers['X-Agent-Workspace']=workspace
        c.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
        r=c.getresponse();status=r.status;raw=r.read();c.close()
        return status,json.loads(raw)

    def test_routes_isolate_scopes_downloads_and_deleted_spaces(self):
        status,w=self.request('/api/workspaces',space());self.assertEqual(status,201);wid=w['id']
        self.assertEqual(self.request('/api/session',workspace=wid)[1]['workspace']['id'],wid)
        _,p=self.request('/api/agents',role(),wid)
        self.assertEqual(self.request('/api/agents')[1]['agents'],[])
        self.assertEqual(self.request('/api/agents/'+p['id'])[0],404)
        _,d=self.request('/api/runs',{'start':False,'runtime':'mock','agent_id':p['id'],'agent_revision':1},wid);run=d['run']['run_id']
        self.assertEqual(self.request('/api/runs/'+run)[0],403)
        for tail in ('/context-manifests','/download?kind=result','/download?kind=events'):
            self.assertEqual(self.request('/api/runs/'+run+tail)[0],403)
        self.assertEqual(self.request('/api/runs/'+run+'/download?kind=result&workspace_id='+wid)[0],200)
        self.assertEqual(self.request('/api/library?project_id='+w['project_id'])[0],403)
        self.assertEqual(self.request('/api/runs',{'project_id':'project-demo','start':False},wid)[0],403)
        self.assertEqual(self.request('/api/workspaces/'+wid+'/delete',{'revision':1})[0],409)
        self.assertEqual(self.request('/api/runs/'+run+'/cancel',{},wid)[0],202)
        self.assertEqual(self.request('/api/workspaces/'+wid+'/delete',{'revision':1})[0],200)
        self.assertEqual(self.request('/api/session',workspace=wid)[0],404)
        self.assertEqual(self.request('/api/workspaces/'+wid+'/restore',{'revision':2})[0],200)
        self.assertEqual(self.request('/api/agents/'+p['id'],workspace=wid)[0],200)
        self.assertEqual(self.request('/api/agent-definition-default?domain=knowledge-answer@1.0.0',workspace=wid)[1]['definition']['domain_pack_ref'],'knowledge-answer@1.0.0')

    def test_default_requests_fall_back_after_default_space_deleted(self):
        _,w=self.request('/api/workspaces',space())
        self.assertEqual(self.request('/api/workspaces/workspace-default/delete',{'revision':1})[0],200)
        status,session=self.request('/api/session')
        self.assertEqual(status,200);self.assertEqual(session['workspace']['id'],w['id'])
        self.assertEqual(self.request('/api/session',workspace='workspace-default')[0],404)
