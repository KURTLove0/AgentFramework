from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.web import Application,WebServer
from agent_framework.definitions import default_definition
from agent_framework.contracts import PolicyDenied,digest,canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.workflows import Workflows
from agent_framework.workflow_chat import WorkflowChat
from agent_framework.knowledge_hub import hub


def role(app,name='评估岗位',domain='change-assessment@2.0.0'):
    return app.agents.save(dict(name=name,description='仅处理模拟数据',runtime='mock',model='builtin',options={},prompt='按证据完成任务',skills=[],mcp_servers=[],revision=0,definition=default_definition(name,domain)))


def definition(profiles):
    return dict(name='协作流程',description='Agent 依赖闭环',revision=0,nodes=[dict(id='n'+str(i),name=p['name'],agent_id=p['id'],agent_revision=p['revision'],goal='评估模拟变更，参考上游证据并遵守本岗位验收标准',depends_on=[] if i==0 else ['n'+str(i-1)]) for i,p in enumerate(profiles)])


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.8,tool_timeout=.3);self.addCleanup(self.app.close)
        self.p=role(self.app);self.f=self.app.workflows()

    def start(self,profiles=None,**kwargs):
        w=self.f.save(definition(profiles or [self.p]))
        return self.f.start(w['id'],dict(revision=w['revision'],grant=True,**kwargs))

    def test_dag_validation_versions_and_scope(self):
        for mutate in (lambda d:d['nodes'][0].update(depends_on=['missing']),lambda d:d['nodes'][0].update(depends_on=['n0']),lambda d:d['nodes'].append(deepcopy(d['nodes'][0])),lambda d:d['nodes'][0].update(agent_revision=2)):
            d=definition([self.p]);mutate(d)
            with self.assertRaises((ValueError,ConfigConflict)):self.f.save(d)
        d=definition([self.p,self.p]);d['nodes'][0]['depends_on']=['n1']
        with self.assertRaisesRegex(ValueError,'循环'):self.f.save(d)
        w=self.f.save(definition([self.p]));self.f.save(definition([self.p])|{'revision':1},w['id'])
        with self.assertRaises(ConfigConflict):self.f.start(w['id'],dict(revision=1))
        space=self.app.workspaces.save(dict(name='其他',business='其他',scenario='测试',description='',revision=0));other=self.app.scoped(space['id'])
        with self.assertRaises(KeyError):other.workflows().get(w['id'])
        with self.assertRaises(KeyError):other.workflows().save(definition([self.p]))

    def test_upstream_artifact_is_verified_frozen_and_consumed_as_task_input(self):
        s=self.start([self.p,self.p],scenarios={'n0':'response-lost'});result=self.f.execute(s['id'])
        self.assertEqual(result['status'],'SUCCEEDED');self.assertEqual(result['snapshot_hash'],s['snapshot_hash'])
        first=self.app.runtime().store.result(self.app.tenant,result['nodes']['n0']['run_id'])
        second=self.app.runtime().store.result(self.app.tenant,result['nodes']['n1']['run_id'])
        entry=second['task']['workflow_inputs'][0]
        self.assertEqual(entry['artifact'],first['report']);self.assertEqual(entry['content_hash'],digest(first['report']))
        for n in result['nodes'].values():
            stats=self.app.runtime().external.stats(self.app.tenant,n['run_id']);self.assertEqual(len(stats['drafts']),1);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1)
        self.assertTrue(any(e['kind']=='workflow.verified' for e in self.f.events(s['id'])))

    def test_authorization_waits_at_concrete_node_and_blocks_dependencies(self):
        w=self.f.save(definition([self.p,self.p]));s=self.f.start(w['id'],{'revision':1,'grant':False});r=self.f.execute(s['id'])
        self.assertEqual(r['status'],'WAITING_AUTH');self.assertIsNone(r['nodes']['n1']['run_id'])
        self.assertEqual(self.app.runtime().external.stats(self.app.tenant,r['nodes']['n0']['run_id'])['drafts'],[])
        pending=self.f.grant(s['id'],'n0');self.assertTrue(pending['args_hash'])
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'WAITING_AUTH');self.assertEqual(r['nodes']['n0']['status'],'SUCCEEDED')
        self.f.grant(s['id'],'n1');self.assertEqual(self.f.execute(s['id'])['status'],'SUCCEEDED')

    def test_failed_acceptance_blocks_downstream(self):
        s=self.start([self.p,self.p],scenarios={'n0':'tampered-draft'});r=self.f.execute(s['id'])
        self.assertEqual(r['status'],'NEEDS_REVIEW');self.assertIsNone(r['nodes']['n1']['run_id'])

    def test_process_restart_reconciles_original_child_without_duplicate_draft(self):
        s=self.start(scenarios={'n0':'crash-after-write'});r=self.f.execute(s['id'])
        self.assertEqual(r['status'],'INTERRUPTED');child=r['nodes']['n0']['run_id'];old=self.app.runtime().store.result(self.app.tenant,child)
        time.sleep(.9)
        restarted=Application(self.tmp.name,lease_seconds=.8,tool_timeout=.3);self.addCleanup(restarted.close)
        r=restarted.workflows().execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED');self.assertEqual(r['nodes']['n0']['run_id'],child)
        new=restarted.runtime().store.result(self.app.tenant,child);self.assertEqual(new['snapshot'],old['snapshot'])
        stats=restarted.runtime().external.stats(self.app.tenant,child);self.assertEqual(len(stats['drafts']),1);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1)

    def test_crash_between_child_submission_and_flow_checkpoint_is_not_resubmitted(self):
        s=self.start();original=self.f._save
        class PowerLoss(BaseException):pass
        def save(state,owner,kind,details=None):
            if kind=='node.submitted':raise PowerLoss()
            return original(state,owner,kind,details)
        with patch.object(self.f,'_save',side_effect=save):
            with self.assertRaises(PowerLoss):self.f.execute(s['id'])
        child=self.f.run(s['id'])['nodes']['n0']['run_id'];self.assertIsNotNone(child)
        original_task=self.app.runtime().store.load(self.app.tenant,child)
        r=self.app.workflows().execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED')
        self.assertEqual(r['nodes']['n0']['run_id'],child);self.assertEqual(self.app.runtime().store.load(self.app.tenant,child)['snapshot'],original_task['snapshot'])

    def test_idempotent_start_and_frozen_agent_after_edits(self):
        s=self.start(request_id='request-repeat');r=self.f.start(s['workflow_id'],{'revision':1,'grant':True,'request_id':'request-repeat'})
        self.assertEqual(s['id'],r['id'])
        with self.assertRaises(ConfigConflict):self.f.start(s['workflow_id'],{'revision':1,'grant':False,'request_id':'request-repeat'})
        data={k:self.p[k] for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','definition','revision')};data['definition']['identity']['role']='新职责身份';self.app.agents.save(data,self.p['id'])
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED')
        child=self.app.runtime().store.load(self.app.tenant,r['nodes']['n0']['run_id']);self.assertEqual(child['snapshot']['agent']['identity']['role'],'release_reviewer')

    def test_cancel_is_durable_and_workspace_delete_is_guarded(self):
        s=self.start();space=self.app.workspaces.save(dict(name='其他',business='其他',scenario='测试',description='',revision=0))
        with self.assertRaisesRegex(ConfigConflict,'工作流'):self.app.workspaces.lifecycle('workspace-default',1,True)
        self.f.cancel(s['id']);r=self.f.execute(s['id']);self.assertEqual(r['status'],'CANCELLED');self.assertIsNone(r['nodes']['n0']['run_id'])

    def test_private_run_and_chat_are_not_shared_with_other_principal(self):
        s=self.start();other=Application(self.tmp.name,principal='another');self.addCleanup(other.close)
        with self.assertRaises(KeyError):other.workflows().run(s['id'])
        self.assertEqual(other.workflows().runs(),[])

    def test_multi_turn_agent_chat_proposes_but_never_saves_or_executes(self):
        qa=role(self.app,'知识岗位','knowledge-answer@1.0.0');chat=WorkflowChat(self.app)
        r=chat.reply({'agent_id':self.p['id'],'message':'先知识岗位，再评估岗位'})
        self.assertEqual([n['agent_id'] for n in r['proposal']['nodes']],[qa['id'],self.p['id']]);self.assertEqual(self.f.list(),[]);self.assertEqual(self.app.runs()['counts']['total'],0)
        r=chat.reply({'id':r['id'],'revision':r['revision'],'agent_id':self.p['id'],'message':'名称改为交易检查流程'})
        self.assertEqual(r['proposal']['name'],'交易检查流程')
        w=self.f.save(r['proposal']|{'revision':0});self.assertEqual(len(w['nodes']),2)

    def test_real_chat_uses_agent_runtime_schema_and_consent_without_native_tools(self):
        from agent_framework.workflow_chat import RESPONSE
        from agent_framework.llm import CodexConfig,CodexTransport
        p=deepcopy(self.p);p.update(runtime='codex',model='fixture-model',options={'timeout':5,'max_attempts':1,'reasoning_effort':'low'})
        proposal={k:v for k,v in definition([self.p]).items() if k!='revision'}
        with patch.object(self.app.agents,'get',return_value=p),patch.object(CodexTransport,'generate',return_value=(canonical({'reply':'已生成提案','workflow':proposal}),{'usage':{'input_tokens':10,'output_tokens':20}})) as call:
            with self.assertRaises(PolicyDenied):WorkflowChat(self.app).reply({'agent_id':p['id'],'message':'设计流程'})
            call.assert_not_called()
            result=WorkflowChat(self.app).reply({'agent_id':p['id'],'message':'设计流程','consent':True});self.assertEqual(result['runtime'],'codex')
            self.assertEqual(call.call_args.args[1],RESPONSE);self.assertIsInstance(call.call_args.args[2],CodexConfig)
            self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_knowledge_hub_revision_private_memory_and_capability_bindings(self):
        lib=self.app.library();access=self.app.library_access();a=lib.create(access,{'title':'风险资料','content':{'text':'先查测试再核对回滚'}});lib.transition(access,a['ref'],'REVIEW');lib.transition(access,a['ref'],'PUBLISHED')
        b=lib.create(access,{'id':a['id'],'supersedes':a['ref'],'title':'风险资料','content':{'text':'新版模拟规则'}})
        self.assertEqual(b['version'],2);self.assertEqual(lib.get(access,a['ref'])['content']['text'],'先查测试再核对回滚')
        d=hub(self.app);self.assertEqual(d['counts']['knowledge'],2);self.assertEqual(len(d['capabilities']),6)
        self.assertTrue(any(self.p['id'] in [p['id'] for p in c['agents']] for c in d['capabilities']))
        self.assertEqual(len(hub(self.app,'不存在的词') ['knowledge']),0)

    def test_fan_in_waits_for_all_successful_agents(self):
        data=definition([self.p,self.p,self.p]);data['nodes'][1]['depends_on']=[];data['nodes'][2]['depends_on']=['n0','n1']
        w=self.f.save(data);s=self.f.start(w['id'],{'revision':1,'grant':True});r=self.f.execute(s['id'])
        self.assertEqual(r['status'],'SUCCEEDED');self.assertEqual(len(r['nodes']['n2']['inputs']),2)

    def test_withdrawn_upstream_source_blocks_resumed_downstream(self):
        qa=role(self.app,'查询岗位','knowledge-answer@1.0.0');data=definition([qa,self.p]);data['nodes'][0]['goal']='变更风险规则是什么'
        w=self.f.save(data);s=self.f.start(w['id'],{'revision':1,'grant':True})
        for _ in range(15):
            r=self.f.execute(s['id'],pause_after=1)
            if r['nodes']['n0']['status']=='SUCCEEDED':break
        self.assertIsNone(r['nodes']['n1']['run_id']);child=self.app.runtime().store.result(self.app.tenant,r['nodes']['n0']['run_id'])
        ref=child['report']['citations'][0]['asset_ref'];self.app.library().transition(self.app.library_access(),ref,'WITHDRAWN')
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'NEEDS_REVIEW');self.assertIsNone(r['nodes']['n1']['run_id'])

    def test_child_link_cannot_be_rebound_and_chat_history_is_private(self):
        s=self.start();state=self.f.run(s['id']);state['nodes']['n0']['run_id']='run-foreign'
        with self.app.runtime().store.transaction() as db:db.execute('UPDATE workflow_runs SET data=? WHERE id=?',(canonical(state),s['id']))
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'NEEDS_REVIEW');self.assertFalse(self.app.runs()['runs'])
        chat=WorkflowChat(self.app).reply({'agent_id':self.p['id'],'message':'先评估岗位'})
        self.assertEqual(WorkflowChat(self.app).list()[0]['id'],chat['id'])
        other=Application(self.tmp.name,principal='another');self.addCleanup(other.close)
        self.assertEqual(WorkflowChat(other).list(),[])
        with self.assertRaises(KeyError):WorkflowChat(other).get(chat['id'])

    def test_invalidated_upstream_still_reconciles_already_dispatched_write(self):
        qa=role(self.app,'查询岗位','knowledge-answer@1.0.0');data=definition([qa,self.p]);data['nodes'][0]['goal']='变更风险规则是什么'
        w=self.f.save(data);s=self.f.start(w['id'],{'revision':1,'grant':True,'scenarios':{'n1':'crash-after-write'}})
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'INTERRUPTED');time.sleep(.9)
        first=self.app.runtime().store.result(self.app.tenant,r['nodes']['n0']['run_id']);ref=first['report']['citations'][0]['asset_ref']
        self.app.library().transition(self.app.library_access(),ref,'WITHDRAWN')
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'NEEDS_REVIEW')
        child=self.app.runtime().store.result(self.app.tenant,r['nodes']['n1']['run_id'])
        self.assertFalse(any(a['status'] in ('DISPATCHED','UNKNOWN','RECONCILING') for a in child['residual_effects']))
        stats=self.app.runtime().external.stats(self.app.tenant,child['run_id']);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1);self.assertEqual(len(stats['drafts']),1)

    def test_legacy_agent_without_structured_definition_can_design_and_run(self):
        with self.app.runtime().store.transaction() as db:
            profile=json.loads(db.execute('SELECT data FROM agent_profiles WHERE id=?',(self.p['id'],)).fetchone()[0]);profile.pop('definition')
            db.execute('UPDATE agent_profiles SET data=? WHERE id=?',(canonical(profile),self.p['id']))
        self.assertTrue(any(self.p['id'] in [p['id'] for p in c['agents']] for c in hub(self.app)['capabilities']))
        reply=WorkflowChat(self.app).reply({'agent_id':self.p['id'],'message':'先评估岗位'})
        w=self.f.save(reply['proposal']|{'revision':0});s=self.f.start(w['id'],{'revision':1,'grant':True})
        self.assertEqual(self.f.execute(s['id'])['status'],'SUCCEEDED')


class WorkflowHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.8,tool_timeout=.3);self.addCleanup(self.app.close)
        self.p=role(self.app);self.server=WebServer(('127.0.0.1',0),self.app)
        threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.02},daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def request(self,path,data=None,workspace=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5);h={'Content-Type':'application/json','X-Agent-Token':self.app.token}
        if workspace:h['X-Agent-Workspace']=workspace
        c.request('POST' if data is not None else 'GET',path,json.dumps(data) if data is not None else None,h)
        r=c.getresponse();status=r.status;body=json.loads(r.read());c.close();return status,body

    def test_chat_save_run_grant_and_scoped_detail_routes(self):
        for bad in ({'agent_id':{},'message':'test'},{'agent_id':self.p['id'],'message':'test','consent':'yes'},{'agent_id':self.p['id'],'message':'test','id':'chat-test','revision':True}):
            self.assertEqual(self.request('/api/workflow-chat',bad)[0],400)
        status,chat=self.request('/api/workflow-chat',{'agent_id':self.p['id'],'message':'先评估岗位'})
        self.assertEqual(status,200);self.assertEqual(self.request('/api/workflows')[1]['workflows'],[])
        status,w=self.request('/api/workflows',chat['proposal']|{'revision':0});self.assertEqual(status,201)
        status,d=self.request('/api/workflows/'+w['id']+'/start',{'revision':1,'request_id':'same-request'});self.assertEqual(status,202);run=d['run']['id']
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            d=self.request('/api/workflow-runs/'+run)[1]
            if d['run']['status']=='WAITING_AUTH' and not d['job']['active']:break
            time.sleep(.02)
        self.assertEqual(d['run']['status'],'WAITING_AUTH')
        node=next(iter(d['run']['nodes']));self.assertTrue(d['children'][node]['pending']['args_hash'])
        self.assertEqual(self.request('/api/workflow-runs/'+run+'/grant',{'node_id':node})[0],202)
        while time.monotonic()<deadline:
            d=self.request('/api/workflow-runs/'+run)[1]
            if d['run']['status']=='SUCCEEDED':break
            time.sleep(.02)
        self.assertEqual(d['run']['status'],'SUCCEEDED');self.assertEqual(d['children'][node]['draft_count'],1)
        space=self.app.workspaces.save(dict(name='其他',business='测试',scenario='测试',description='',revision=0))
        for path in ('/api/workflows/'+w['id'],'/api/workflow-runs/'+run,'/api/workflow-chat/'+chat['id']):self.assertEqual(self.request(path,workspace=space['id'])[0],404)
        self.assertEqual(self.request('/api/workflow-runs/'+run+'/resume',{},space['id'])[0],404)

    def test_four_modules_and_asset_history_respect_workspace_scope(self):
        _,a=self.request('/api/knowledge/assets',{'title':'风险知识','content':{'text':'模拟风险规则'}})
        self.assertEqual(self.request('/api/knowledge-hub')[1]['counts']['knowledge'],1)
        self.assertEqual(len(self.request('/api/knowledge-hub')[1]['capabilities']),6)
        status,d=self.request('/api/knowledge/assets/'+a['ref']+'/history');self.assertEqual(status,200);self.assertEqual(d['events'][0]['event'],'created')
        space=self.app.workspaces.save(dict(name='其他',business='测试',scenario='测试',description='',revision=0))
        self.assertEqual(self.request('/api/knowledge/assets/'+a['ref']+'/history',workspace=space['id'])[0],404)
        self.assertEqual(self.request('/api/knowledge-hub',workspace=space['id'])[1]['counts']['knowledge'],0)
