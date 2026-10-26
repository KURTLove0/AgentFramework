from copy import deepcopy
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.web import Application
from agent_framework.definitions import default_definition
from agent_framework.contracts import PolicyDenied,canonical
from agent_framework.learning import Learning,capability_skill_zip
from agent_framework.ontology import validate_ontology,source_context,expand,revise,export_jsonld
from agent_framework.knowledge import Access
from agent_framework.knowledge_hub import hub
from agent_framework.runtime_config import ConfigConflict


def profile():
    return {'name':'复盘岗位','description':'总结模拟运行','runtime':'mock','model':'builtin','options':{},'prompt':'依据来源复盘，标明事实和限制','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('复盘岗位')}


class LearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=self.app.agents.save(profile());self.service=Learning(self.app);self.lib=self.app.library();self.access=self.app.library_access()

    def run_task(self,scenario='normal',grant=True):
        run=self.app.create({'start':False,'scenario':scenario,'grant':grant})['run']['run_id'];self.app.runtime().run(run);return run

    def request(self,run=None,**kw):
        value={'request_id':'request-test','purpose':'retrospective','run_id':run or self.run_task(),'agent_id':self.agent['id'],'agent_revision':self.agent['revision'],'instruction':'总结四类建议'};value.update(kw);return value

    def generate(self,**kw):return self.service.generate(self.request(**kw))
    def deposit(self,p,ids=None):return self.service.deposit(p['id'],{'revision':p['revision'],'item_ids':ids or [i['id'] for i in p['output']['items']]})
    def publish(self,asset):
        self.lib.transition(self.access,asset['ref'],'REVIEW');return self.lib.transition(self.access,asset['ref'],'PUBLISHED')
    def knowledge(self,title='验收规范',text='失败测试需修复；草稿需独立核对。'):
        return self.publish(self.lib.create(self.access,{'title':title,'content':{'text':text}}))
    def ontology(self,**kw):
        a=self.knowledge();b=self.knowledge('证据规范','证据需保留来源版本。')
        q={'request_id':'ontology-request','purpose':'ontology','source_refs':[a['ref'],b['ref']],'agent_id':self.agent['id'],'agent_revision':1};q.update(kw)
        return self.service.generate(q),a,b

    def test_generation_has_four_kinds_and_does_not_modify_source_or_write_tools(self):
        run=self.run_task('response-lost');before=deepcopy(self.app.detail(run));count=len(self.lib.list(self.access,include_unpublished=True))
        p=self.service.generate(self.request(run))
        self.assertEqual(p['status'],'DRAFT');self.assertEqual({i['kind'] for i in p['output']['items']},{'KNOWLEDGE','MEMORY','EXPERIENCE','CAPABILITY'})
        self.assertEqual(len(self.lib.list(self.access,include_unpublished=True)),count)
        after=self.app.detail(run);self.assertEqual(before['run'],after['run']);self.assertEqual(before['external'],after['external']);self.assertEqual(p['generation']['model_calls'],0)
        self.assertEqual(self.service.generate(self.request(run))['id'],p['id'])

    def test_atomic_deposition_restart_and_idempotent_receipt(self):
        p=self.generate();out=self.deposit(p);refs=[a['ref'] for a in out['receipt']['assets']]
        self.assertEqual(len(refs),4);self.assertEqual(len(set(refs)),4)
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        again=Learning(restarted).deposit(p['id'],{'revision':p['revision'],'item_ids':[i['id'] for i in p['output']['items']]})
        self.assertEqual(again['receipt'],out['receipt'])
        for r in refs:
            a=self.lib.get(self.access,r);self.assertEqual(a['visibility'],'PRIVATE');self.assertEqual(a['provenance']['proposal_id'],p['id'])
        with self.assertRaises(ConfigConflict):self.deposit(p,['memory'])

    def test_concurrent_duplicate_confirmation_creates_one_set(self):
        p=self.generate()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:self.deposit(p),range(2)))
        self.assertEqual(results[0]['receipt'],results[1]['receipt'])
        with self.app.runtime().store.connect() as db:
            self.assertEqual(db.execute("select count(*) from asset_versions where id like 'learned-%'").fetchone()[0],4)

    def test_transaction_failure_leaves_no_partial_assets_and_can_recover(self):
        p=self.generate();from agent_framework.learning import insert_asset
        calls=[]
        def fail(*a,**kw):
            calls.append(1)
            if len(calls)==2:raise RuntimeError('injected deposit failure')
            return insert_asset(*a,**kw)
        with patch('agent_framework.learning.insert_asset',side_effect=fail):
            with self.assertRaises(RuntimeError):self.deposit(p)
        self.assertEqual(self.service.get(p['id'])['status'],'DRAFT')
        self.assertFalse(any(a['id'].startswith('learned-') for a in self.lib.list(self.access,include_unpublished=True)))
        self.assertEqual(len(self.deposit(p)['receipt']['assets']),4)

    def test_edit_requires_revision_and_valid_sources(self):
        p=self.generate();output=deepcopy(p['output']);output['items'][0]['title']='人工核对过的知识'
        saved=self.service.save(p['id'],{'revision':p['revision'],'output':output});self.assertEqual(saved['output'],output)
        with self.assertRaises(ConfigConflict):self.service.save(p['id'],{'revision':p['revision'],'output':output})
        output['items'][0]['source_refs']=['evidence-forged']
        with self.assertRaises(ValueError):self.service.save(p['id'],{'revision':saved['revision'],'output':output})

    def test_paused_run_can_be_reviewed_but_not_archived_as_experience_and_stale_facts_fail(self):
        run=self.run_task(grant=False);p=self.service.generate(self.request(run))
        self.assertNotIn('EXPERIENCE',{i['kind'] for i in p['output']['items']})
        self.app.mutate(run,'grant');self.app.close()
        app=Application(self.tmp.name);self.addCleanup(app.close);app.runtime().run(run)
        with self.assertRaises(ConfigConflict):Learning(app).deposit(p['id'],{'revision':p['revision'],'item_ids':['knowledge']})
        with self.assertRaises(ConfigConflict):self.service.run_context(self.app.create({'start':False})['run']['run_id'])

    def test_scope_principal_and_workspace_isolation(self):
        p=self.generate();other=Application(self.tmp.name,principal='another-user');self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):Learning(other).run_context(p['run_id'])
        with self.assertRaises(KeyError):Learning(other).get(p['id'])
        workspace=self.app.workspaces.save({'name':'其他业务','business':'独立','scenario':'其他','description':'隔离','revision':0})
        scoped=Learning(self.app.scoped(workspace['id']))
        with self.assertRaises(KeyError):scoped.get(p['id'])
        with self.assertRaises(PolicyDenied):scoped.run_context(p['run_id'])

    def test_only_reviewed_memory_and_methods_are_retrieved_and_memory_is_private(self):
        p=self.deposit(self.generate());refs={a['kind']:a['ref'] for a in p['receipt']['assets']}
        self.assertFalse(any(a['ref']==refs['MEMORY'] for a in self.lib.search(self.access,'')['items']))
        for kind in ['MEMORY','CAPABILITY']:self.publish(self.lib.get(self.access,refs[kind]))
        self.assertIn(refs['MEMORY'],[a['ref'] for a in self.lib.search(self.access,'')['items']])
        self.assertNotIn(refs['MEMORY'],[a['ref'] for a in self.lib.search(Access(self.access.tenant,'other',self.access.project),'')['items']])
        with self.assertRaises(ValueError):self.lib.create(self.access,{'kind':'MEMORY','title':'不共享','content':{'text':'私有'},'visibility':'PROJECT'})
        run=self.run_task();contexts=self.app.detail(run)['context_manifests']
        self.assertTrue(any(any(a['ref']==refs['MEMORY'] for a in m['selected']) for m in contexts))
        self.assertEqual(len(hub(self.app)['capabilities']),6)

    def test_real_planner_receives_capability_guidance_as_data_without_new_permissions(self):
        from agent_framework.context_builder import build
        from agent_framework.llm import LLMPlanner,CodexConfig
        from agent_framework.contracts import TaskContract
        asset=self.publish(self.lib.create(self.access,{'kind':'CAPABILITY','title':'变更评估方法','content':{'text':'变更评估先核对证据。'}}))
        runtime=self.app.runtime();state=runtime.submit(TaskContract(goal='变更评估'))
        context,_=build(runtime.store,state,'plan',runtime.context(state))
        payload=LLMPlanner(CodexConfig(model='model-test'))._context(context)
        self.assertIn(asset['ref'],[a['ref'] for a in payload['capability_guidance']])
        self.assertIn('never executable tools',payload['capability_guidance_policy'])
        self.assertEqual(state['snapshot'],runtime.store.load(state['tenant_id'],state['run_id'])['snapshot'])

    def test_capability_method_exports_standard_skill_without_registering_tools(self):
        p=self.deposit(self.generate());ref=next(a['ref'] for a in p['receipt']['assets'] if a['kind']=='CAPABILITY');asset=self.lib.get(self.access,ref)
        with self.assertRaises(ValueError):capability_skill_zip(asset)
        asset=self.publish(asset)
        from agent_framework.skills import import_zip,normalize_package
        folder,files=import_zip(base64.b64encode(capability_skill_zip(asset)).decode());package,warnings=normalize_package(folder,files)
        self.assertIn('不授予工具权限',package['files']['SKILL.md']['content'])
        skill=self.app.skills().save({'folder':folder,'files':files,'revision':0});skill=self.app.skills().lifecycle(skill['id'],skill['revision'],'publish',skill['version'])
        data=profile();data['skill_bindings']=[{'skill_id':skill['id'],'version':skill['version'],'enabled':True}]
        agent=self.app.agents.save(data);compiled=self.app.agents.compile(agent['id'])
        self.assertEqual(len(compiled['capabilities']),4)

    def test_experience_keeps_existing_evaluation_gate(self):
        from agent_framework.experience import ExperienceService
        p=self.deposit(self.generate());ref=next(a['ref'] for a in p['receipt']['assets'] if a['kind']=='EXPERIENCE')
        with self.assertRaises(ValueError):self.lib.transition(self.access,ref,'PUBLISHED')
        service=ExperienceService(self.app.runtime().store);evaluation=service.evaluate(self.access,ref)
        self.assertTrue(evaluation['passed']);self.assertEqual(service.publish(self.access,ref,evaluation['id'])['status'],'PUBLISHED')

    def test_real_adapter_consent_structured_output_frozen_agent_and_no_business_effects(self):
        run=self.run_task();q=self.request(run);p={**self.agent,'runtime':'codex','model':'model-test','options':{'timeout':30,'max_attempts':1,'reasoning_effort':'low'}}
        output=self.service.mock_review(self.service.run_context(run));before=self.app.detail(run)['external'];prompts=[]
        def generate(prompt,shape,config,timeout):prompts.append(prompt);return canonical(output),{'tokens':10}
        with patch.object(self.service,'_agent',return_value=p),patch('agent_framework.llm.CodexTransport.generate',side_effect=generate) as transport:
            with self.assertRaises(PolicyDenied):self.service.generate(q)
            q['consent']=True;result=self.service.generate(q);self.assertEqual(result['generation']['model_calls'],1)
            self.assertEqual(self.service.generate(q)['id'],result['id']);self.assertEqual(transport.call_count,1)
        self.assertNotIn('csrf_token',prompts[0]);self.assertNotIn('expires_at',prompts[0]);self.assertEqual(before,self.app.detail(run)['external'])
        self.assertEqual(result['agent_revision'],1);self.assertEqual(result['model'],'model-test');self.assertEqual(result['model_options'],p['options']);self.assertTrue(result['output_schema_hash'])

    def test_failed_model_request_is_durable_and_never_auto_replayed(self):
        q=self.request();p={**self.agent,'runtime':'codex','model':'model-test','options':{'timeout':30,'max_attempts':1,'reasoning_effort':'low'}};q['consent']=True
        with patch.object(self.service,'_agent',return_value=p),patch('agent_framework.llm.CodexTransport.generate',side_effect=RuntimeError('simulated model disconnect')) as transport:
            with self.assertRaises(RuntimeError):self.service.generate(q)
            again=self.service.generate(q);self.assertEqual(again['status'],'FAILED');self.assertEqual(transport.call_count,1)
        with self.assertRaises(ConfigConflict):self.service.generate({**q,'instruction':'changed'})

    def test_history_filters_run_before_applying_recent_limit(self):
        p=self.generate();other={k:v for k,v in p.items() if k not in ('id','revision','status','purpose')}
        with self.service.store.transaction() as db:
            for i in range(201):
                db.execute('INSERT INTO learning_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',(*self.service._scope(),'other-'+str(i),'other-request-'+str(i),'ontology','',1,'FAILED',canonical(other)))
        history=self.service.list(p['run_id'],'retrospective')
        self.assertEqual([x['id'] for x in history],[p['id']]);self.assertNotIn('source_context',history[0])

    def test_interrupted_generation_is_not_replayed_after_restart(self):
        q=self.request();p=self.service.generate(q)
        with self.app.runtime().store.transaction() as db:db.execute("update learning_proposals set status='GENERATING' where id=?",(p['id'],))
        with patch('agent_framework.learning.agent_generate',side_effect=AssertionError('must not replay')):
            result=Learning(self.app).generate(q);self.assertEqual(result['status'],'GENERATING')

    def test_ontology_generation_editing_validation_and_skos_export(self):
        p,a,b=self.ontology();o=deepcopy(p['output']);o['concepts'][0]['aliases']=['独特本体别名'];o['relations']=[{'source':o['concepts'][0]['id'],'target':o['concepts'][1]['id'],'predicate':'REQUIRES','source_refs':[a['ref'],b['ref']]}]
        p=self.service.save(p['id'],{'revision':p['revision'],'output':o});p=self.deposit(p,['ontology']);asset=self.lib.get(self.access,p['receipt']['assets'][0]['ref'])
        self.assertEqual(asset['kind'],'ONTOLOGY');self.assertFalse(expand(self.lib,self.access,'独特本体别名')['concepts'])
        asset=self.publish(asset);found=expand(self.lib,self.access,'独特本体别名');self.assertEqual(len(found['concepts']),2);self.assertIn(a['ref'],[x['ref'] for x in hub(self.app,'独特本体别名')['knowledge']])
        self.assertEqual(set(found['source_refs']),{a['ref'],b['ref']});self.assertEqual(len(export_jsonld(asset)['@graph']),3)
        hits=self.lib.search(self.access,'独特本体别名')['items'];self.assertIn(a['ref'],[x['ref'] for x in hits]);self.assertNotIn(asset['ref'],[x['ref'] for x in hits])
        new=revise(self.lib,self.access,asset['ref'],{'content':{**o,'name':'新本体'}});self.assertEqual(new['version'],2);self.assertEqual(new['status'],'DRAFT')
        self.assertEqual(self.lib.get(self.access,asset['ref'])['title'],o['name'])
        with self.assertRaises(ConfigConflict):revise(self.lib,self.access,asset['ref'],{'content':o})

    def test_ontology_dangling_cycles_duplicates_and_unsupported_types_rejected(self):
        p,a,b=self.ontology();good=p['output'];refs={a['ref'],b['ref']}
        bad=deepcopy(good);bad['concepts'][0]['source_refs']=['forged@1']
        with self.assertRaises(ValueError):validate_ontology(bad,refs)
        for key,value in [('target','missing'),('target',good['concepts'][0]['id'])]:
            bad=deepcopy(good);bad['relations']=[{'source':good['concepts'][0]['id'],'target':good['concepts'][1]['id'],'predicate':'IS_A','source_refs':[a['ref']]}];bad['relations'][0][key]=value
            with self.assertRaises(ValueError):validate_ontology(bad,refs)
        bad=deepcopy(good);x,y=[c['id'] for c in bad['concepts']];bad['relations']=[{'source':x,'target':y,'predicate':'IS_A','source_refs':[a['ref']]},{'source':y,'target':x,'predicate':'IS_A','source_refs':[b['ref']]}]
        with self.assertRaises(ValueError):validate_ontology(bad,refs)
        bad=deepcopy(good);bad['concepts'][1]['id']=bad['concepts'][0]['id']
        with self.assertRaises(ValueError):validate_ontology(bad,refs)
        bad=deepcopy(good);bad['concepts'][0]['properties'][0]['type']='execute'
        with self.assertRaises(ValueError):validate_ontology(bad,refs)

    def test_ontology_withdrawn_source_blocks_deposition_publication_and_retrieval(self):
        p,a,b=self.ontology();self.lib.transition(self.access,a['ref'],'WITHDRAWN')
        with self.assertRaises(ValueError):self.deposit(p,['ontology'])
        p,a,b=self.ontology(request_id='ontology-second');p=self.deposit(p,['ontology']);asset=self.lib.get(self.access,p['receipt']['assets'][0]['ref']);self.lib.transition(self.access,asset['ref'],'REVIEW');self.lib.transition(self.access,a['ref'],'WITHDRAWN')
        with self.assertRaises(PolicyDenied):self.lib.transition(self.access,asset['ref'],'PUBLISHED')
        self.assertFalse(hub(self.app)['ontologies'][0]['sources_current'])

    def test_ontology_private_source_cannot_be_read_by_other_principal(self):
        a=self.lib.create(self.access,{'title':'私有规范','visibility':'PRIVATE','content':{'text':'私有业务事实'}});a=self.publish(a)
        other=Access(self.access.tenant,'other',self.access.project)
        with self.assertRaises(KeyError):source_context(self.lib,other,[a['ref']])
        with self.assertRaises(ValueError):source_context(self.lib,self.access,[a['ref'],a['ref']])





    def test_dynamic_schema_pins_only_facts_and_source_references(self):
        from agent_framework.learning import retrospective_schema,RETROSPECTIVE
        from agent_framework.structured import validate
        context=self.service.run_context(self.run_task());shape=retrospective_schema(context)
        validate(self.service.mock_review(context),shape)
        item=shape['properties']['items']['items']['properties']
        self.assertNotIn('enum',item['id']);self.assertNotIn('enum',item['limitations']['items'])
        self.assertNotIn('enum',RETROSPECTIVE['properties']['outcome'])
        self.assertEqual(set(item['source_refs']['items']['enum']),{x['ref'] for x in context['sources']})

    def test_model_cannot_change_outcome_or_acceptance_and_bad_output_is_not_saved(self):
        run=self.run_task('tampered-draft');context=self.service.run_context(run);o=self.service.mock_review(context)
        o['outcome']='SUCCEEDED'
        with self.assertRaises(ValueError):self.service.validate_output('retrospective',o,context)
        o=self.service.mock_review(context);o['acceptance']['passed']=3
        with self.assertRaises(ValueError):self.service.validate_output('retrospective',o,context)
        q=self.request(run);p={**self.agent,'runtime':'codex','model':'model-test','options':{'timeout':30,'max_attempts':1,'reasoning_effort':'low'}};q['consent']=True
        with patch.object(self.service,'_agent',return_value=p),patch('agent_framework.llm.CodexTransport.generate',return_value=(canonical(o),{})):
            with self.assertRaises(ValueError):self.service.generate(q)
        self.assertEqual(self.service.list(run)[0]['status'],'FAILED')
        self.assertFalse(any(a['id'].startswith('learned-') for a in self.lib.list(self.access,include_unpublished=True)))

    def test_ontology_shared_graph_does_not_leak_private_sources_after_revocation(self):
        p,a,b=self.ontology();o=p['output'];o['concepts'][0]['aliases']=['已撤回专属别名']
        p=self.service.save(p['id'],{'revision':p['revision'],'output':o});p=self.deposit(p,['ontology']);asset=self.publish(self.lib.get(self.access,p['receipt']['assets'][0]['ref']))
        self.assertTrue(expand(self.lib,self.access,'已撤回专属别名')['concepts'])
        self.lib.transition(self.access,a['ref'],'WITHDRAWN')
        self.assertFalse(expand(self.lib,self.access,'已撤回专属别名')['concepts'])
        self.assertNotIn(a['ref'],[x['ref'] for x in self.lib.search(self.access,'已撤回专属别名')['items']])
        self.assertEqual(self.lib.get(self.access,asset['ref'])['status'],'PUBLISHED')

    def test_ontology_dense_hierarchy_validation_has_bounded_traversal(self):
        p,a,b=self.ontology();sample=p['output']['concepts'][0];concepts=[{**deepcopy(sample),'id':'node-'+str(i),'label':'概念'+str(i)} for i in range(40)]
        edges=[{'source':'node-'+str(i),'target':'node-'+str(j),'predicate':'IS_A','source_refs':[a['ref']]} for i in range(40) for j in (i+1,i+2) if j<40]
        value={**p['output'],'concepts':concepts,'relations':edges}
        validate_ontology(value,{a['ref'],b['ref']})


class LearningHTTPTests(unittest.TestCase):
    def setUp(self):
        import threading
        from agent_framework.web import WebServer
        self.tmp=tempfile.TemporaryDirectory();self.app=Application(self.tmp.name);self.agent=self.app.agents.save(profile())
        self.server=WebServer(('127.0.0.1',0),self.app);self.port=self.server.server_address[1]
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join(2);self.app.close();self.tmp.cleanup()
    def request(self,path,data=None,workspace=None,token=True):
        import http.client
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=10)
        headers={'Origin':f'http://127.0.0.1:{self.port}','Content-Type':'application/json'}
        if token:headers['X-Agent-Token']=self.app.token
        if workspace:headers['X-Agent-Workspace']=workspace
        c.request('GET' if data is None else 'POST',path,None if data is None else canonical(data),headers)
        r=c.getresponse();body=r.read();result=(r.status,dict(r.getheaders()),body);c.close();return result
    def generate(self):
        run=self.app.create({'start':False})['run']['run_id'];self.app.runtime().run(run)
        q={'request_id':'http-request','purpose':'retrospective','run_id':run,'agent_id':self.agent['id'],'agent_revision':1}
        status,_,body=self.request('/api/learning-proposals',q);self.assertEqual(status,201);return json.loads(body),q
    def test_review_api_session_scope_and_idempotent_deposition(self):
        p,q=self.generate();status,_,body=self.request('/api/learning-proposals',q,token=False);self.assertEqual(status,403)
        request={'revision':p['revision'],'item_ids':[i['id'] for i in p['output']['items']]}
        for _ in range(2):
            status,_,body=self.request('/api/learning-proposals/'+p['id']+'/deposit',request);self.assertEqual(status,200);self.assertEqual(len(json.loads(body)['receipt']['assets']),4)
        w=self.app.workspaces.save({'name':'隔离空间','business':'隔离','scenario':'隔离','description':'模拟','revision':0})
        self.assertEqual(self.request('/api/learning-proposals/'+p['id'],workspace=w['id'])[0],404)
        self.assertEqual(self.request('/api/learning/run/'+q['run_id'],workspace=w['id'])[0],403)
        status,_,body=self.request('/api/learning-proposals?run_id='+q['run_id']);self.assertEqual(status,200);self.assertNotIn('source_context',json.loads(body)['proposals'][0])
    def test_ontology_export_is_jsonld_and_skill_export_is_valid_zip(self):
        from urllib.parse import quote
        lib=self.app.library();access=self.app.library_access();a=lib.create(access,{'title':'模拟来源','content':{'text':'业务概念、属性与依赖关系。'}})
        lib.transition(access,a['ref'],'REVIEW');a=lib.transition(access,a['ref'],'PUBLISHED')
        q={'request_id':'http-ontology','purpose':'ontology','source_refs':[a['ref']],'agent_id':self.agent['id'],'agent_revision':1}
        status,_,body=self.request('/api/learning-proposals',q);self.assertEqual(status,201);p=json.loads(body)
        status,_,body=self.request('/api/learning-proposals/'+p['id']+'/deposit',{'revision':p['revision'],'item_ids':['ontology']});self.assertEqual(status,200);ref=json.loads(body)['receipt']['assets'][0]['ref']
        status,headers,body=self.request('/api/ontologies/'+quote(ref)+'/export');self.assertEqual(status,200);self.assertIn('application/ld+json',headers['Content-Type']);self.assertIn('ontology.jsonld',headers['Content-Disposition']);self.assertIn('@graph',json.loads(body))
        p,_=self.generate();out=Learning(self.app).deposit(p['id'],{'revision':p['revision'],'item_ids':['capability']});ref=out['receipt']['assets'][0]['ref'];lib.transition(access,ref,'REVIEW');lib.transition(access,ref,'PUBLISHED')
        status,headers,body=self.request('/api/capability-methods/'+quote(ref)+'/skill');self.assertEqual(status,200);self.assertEqual(body[:2],b'PK');self.assertIn('application/zip',headers['Content-Type'])
