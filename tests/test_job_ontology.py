from copy import deepcopy
import http.client
import json
import tempfile
import threading
import unittest
from urllib.parse import quote

from agent_framework.web import Application, WebServer
from agent_framework.contracts import PolicyDenied,canonical,digest
from agent_framework.runtime_config import ConfigConflict
from agent_framework.definitions import default_definition
from agent_framework.evaluation_contract import compile_contract,normalize_config
from agent_framework.agent_evaluation import AgentEvaluations,record
from agent_framework.learning import Learning
from agent_framework.ontology import validate_ontology,expand,export_jsonld,revise
from agent_framework.ontology_model import empty_model,validate_data,validation_report,object_set
from agent_framework.knowledge import Access


def profile(name='岗位审核员',domain='change-assessment@2.0.0'):
    return dict(name=name,description='按岗位执行',runtime='mock',model='builtin',options={},prompt='基于证据交付',skills=[],mcp_servers=[],revision=0,definition=default_definition(name,domain))


def property_shape(identity,kind='string',required=False,**kw):
    return dict(id=identity,label=identity,description='',type=kind,min_count=int(required),max_count=1,enum_values=[],min_value=None,max_value=None)|kw


def content(ref='source@1'):
    model=empty_model()
    model['object_types']=[
        dict(id='change',label='变更',concept_id='change',primary_key='id',source_refs=[ref],properties=[
            property_shape('id',required=True),property_shape('risk',required=True,enum_values=['HIGH','LOW']),
            property_shape('score','number',min_value=0,max_value=100),property_shape('day','date'),property_shape('verified','boolean')]),
        dict(id='report',label='报告',concept_id='report',primary_key='id',source_refs=[ref],properties=[property_shape('id',required=True)])]
    model['link_types']=[dict(id='produces',label='产出',source_type='change',target_type='report',cardinality='ONE_TO_ONE',source_refs=[ref])]
    model['objects']=[dict(id='change-1',type_id='change',values=dict(id='C001',risk='HIGH',score=90,day='2026-10-23',verified=True),source_refs=[ref]),
                      dict(id='report-1',type_id='report',values=dict(id='R001'),source_refs=[ref])]
    model['links']=[dict(type_id='produces',source='change-1',target='report-1',source_refs=[ref])]
    model['action_types']=[dict(id='draft',label='创建模拟草稿',target_type='change',capability_ref='report.draft.create@1.0.0',source_refs=[ref])]
    return dict(name='发布质量本体',description='对象、关系与约束',concepts=[
        dict(id='change',label='变更',definition='需要审核的变更',aliases=['唯一变更别名'],properties=[],source_refs=[ref]),
        dict(id='report',label='报告',definition='审核结果',aliases=[],properties=[],source_refs=[ref]),
        dict(id='evidence',label='证据',definition='支持结果的依据',aliases=[],properties=[],source_refs=[ref])],
        relations=[dict(source='change',target='report',predicate='PRODUCES',source_refs=[ref]),dict(source='report',target='evidence',predicate='REQUIRES',source_refs=[ref])],model=model)


class JobEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=self.app.agents.save(profile());self.service=AgentEvaluations(self.app)

    def execute(self,agent=None,scenario='normal'):
        agent=agent or self.agent
        state=self.app.create(dict(start=False,agent_id=agent['id'],agent_revision=agent['revision'],scenario=scenario))['run']
        return self.app.runtime().run(state['run_id'])

    def test_teamless_agent_executes_and_passes_identity_evaluation(self):
        self.assertNotIn('owner_team',self.agent['definition']['identity'])
        result=self.execute()
        self.assertEqual(result['status'],'SUCCEEDED')
        report=self.service.overview()['reports'][0]
        self.assertEqual(report['score'],100)
        self.assertEqual(report['verdict'],'PASS')
        self.assertTrue(all(check['passed'] for check in report['identity_checks']))
        self.assertNotIn('owner_team',report['identity'])

    def test_job_config_freezes_identity_responsibilities_standards_and_weights(self):
        settings=self.app.agents.evaluation_settings(self.agent['id']);config=deepcopy(settings['config'])
        config['threshold']=95;config['weights']={'identity':15,'responsibilities':45,'standards':30,'delivery':10}
        first=next(iter(config['responsibilities']));config['responsibilities'][first]['weight']=4
        saved=self.app.agents.save_evaluation_settings(self.agent['id'],dict(revision=1,config=config))
        self.assertEqual(saved['revision'],2);agent=self.app.agents.get(self.agent['id'])
        result=self.execute(agent);report=self.service.overview()['reports'][0]
        self.assertEqual(report['score'],100);self.assertEqual(report['effective_threshold'],95)
        self.assertEqual(report['evaluation_contract'],result['snapshot']['compiled_agent']['evaluation_contract'])
        self.assertEqual([d['maximum'] for d in report['dimensions']],[15,45,30,10])
        self.assertTrue(all(c['passed'] for c in report['identity_checks']))
        self.assertTrue(all(d['artifact_present'] and d['artifact_hash'] for d in report['responsibilities']))

    def test_existing_run_uses_old_job_contract_after_config_and_identity_edit(self):
        state=self.app.create(dict(start=False,agent_id=self.agent['id'],agent_revision=1))['run'];frozen=deepcopy(state['snapshot'])
        settings=self.app.agents.evaluation_settings(self.agent['id']);config=settings['config'];config['threshold']=99
        self.app.agents.save_evaluation_settings(self.agent['id'],dict(revision=1,config=config))
        changed=profile();changed['revision']=2;changed['definition']['identity']['role']='另一个岗位'
        self.app.agents.save(changed,self.agent['id'])
        self.app.runtime().run(state['run_id']);report=self.service.overview()['reports'][0]
        self.assertEqual(report['identity']['role'],'release_reviewer')
        self.assertEqual(report['evaluation_contract'],frozen['compiled_agent']['evaluation_contract'])
        self.assertEqual(report['effective_threshold'],80)
        before=report['id'];self.service.evaluate(state['run_id']);self.assertEqual(self.service.overview()['reports'][0]['id'],before)

    def test_missing_artifact_cannot_pass_on_green_checks_alone(self):
        state=self.execute();state['report']=None
        with self.app.runtime().store.transaction() as db:report=record(db,state,force=True)
        self.assertEqual(report['verdict'],'FAIL')
        duty=next(d for d in report['responsibilities'] if d['deliverable_ref']=='release-report@1.0.0')
        self.assertFalse(duty['artifact_present']);self.assertEqual(duty['score'],0)

    def test_corrupt_evidence_and_out_of_role_action_fail_independently(self):
        state=self.execute();store=self.app.runtime().store
        with store.transaction() as db:
            row=db.execute('SELECT id,data FROM evidence WHERE tenant_id=? AND run_id=? LIMIT 1',(self.app.tenant,state['run_id'])).fetchone()
            evidence=json.loads(row['data']);evidence['data']['tampered']=True
            db.execute('UPDATE evidence SET data=? WHERE tenant_id=? AND run_id=? AND id=?',(canonical(evidence),self.app.tenant,state['run_id'],row['id']))
        self.service.evaluate(state['run_id']);report=self.service.overview()['reports'][0]
        self.assertFalse(report['evidence_integrity']);self.assertEqual(report['verdict'],'FAIL')
        with store.transaction() as db:
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?)',(self.app.tenant,state['run_id'],'outside','VERIFIED',canonical(dict(tool_ref='unknown.write@1',logical_id='outside',status='VERIFIED'))))
            report=record(db,state,force=True)
        self.assertFalse(next(c for c in report['identity_checks'] if '能力' in c['name'])['passed'])

    def test_baseline_cannot_be_bypassed_by_weights_or_low_minimum(self):
        config=self.app.agents.evaluation_settings(self.agent['id'])['config']
        config['threshold']=1;config['weights']={'identity':97,'responsibilities':1,'standards':1,'delivery':1}
        for kind in ('responsibilities','standards'):
            for rule in config[kind].values():rule['minimum_score']=1
        self.app.agents.save_evaluation_settings(self.agent['id'],dict(revision=1,config=config))
        self.service.save_policy(dict(revision=0,threshold=1,window_days=30,automatic=True))
        self.execute(self.app.agents.get(self.agent['id']),'tampered-draft');report=self.service.overview()['reports'][0]
        self.assertGreater(report['score'],90);self.assertEqual(report['verdict'],'FAIL')
        self.assertEqual(self.service.overview()['open_alert_count'],1)

    def test_validation_conflicts_and_main_editor_preserves_or_reconciles_config(self):
        setting=self.app.agents.evaluation_settings(self.agent['id']);config=setting['config']
        for bad in (dict(config,threshold=True),dict(config,weights={'identity':100}),dict(config,responsibilities={})):
            with self.assertRaises(ValueError):self.app.agents.save_evaluation_settings(self.agent['id'],dict(revision=1,config=bad))
        self.app.agents.save_evaluation_settings(self.agent['id'],dict(revision=1,config=config))
        with self.assertRaises(ConfigConflict):self.app.agents.save_evaluation_settings(self.agent['id'],dict(revision=1,config=config))
        edited=profile();edited['revision']=2;edited['definition']['responsibilities'][0]['description']='修改后的可衡量职责'
        saved=self.app.agents.save(edited,self.agent['id'])
        self.assertIn('evaluation_config',saved)
        self.assertEqual(len(saved['evaluation_config']['responsibilities']),len(saved['definition']['responsibilities']))
        self.app.agents.compile(saved['id'])

    def test_legacy_frozen_job_derives_contract_without_current_profile(self):
        state=self.execute();state['snapshot']['compiled_agent'].pop('evaluation_contract')
        compiled=state['snapshot']['compiled_agent'];compiled['hash']=digest({k:v for k,v in compiled.items() if k!='hash'})
        state['snapshot']['hash']=digest({k:v for k,v in state['snapshot'].items() if k!='hash'})
        with self.app.runtime().store.transaction() as db:report=record(db,state,force=True)
        self.assertEqual(report['contract_origin'],'DERIVED_FROM_FROZEN_JOB');self.assertEqual(report['score'],100)


class OperationalOntologyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.lib=self.app.library();self.access=self.app.library_access();self.agent=self.app.agents.save(profile())
        source=self.lib.create(self.access,dict(title='发布质量来源',content={'text':'变更 C001 产出报告 R001，HIGH 风险，90 分；业务标识唯一，报告需独立回读。'}))
        self.lib.transition(self.access,source['ref'],'REVIEW');self.source=self.lib.transition(self.access,source['ref'],'PUBLISHED')
        self.value=content(self.source['ref']);self.refs={self.source['ref']}

    def asset(self,publish=True):
        service=Learning(self.app);proposal=service.generate(dict(request_id='ontology-model',purpose='ontology',source_refs=list(self.refs),agent_id=self.agent['id'],agent_revision=1))
        proposal=service.save(proposal['id'],dict(revision=proposal['revision'],output=self.value))
        result=service.deposit(proposal['id'],dict(revision=proposal['revision'],item_ids=['ontology']))
        asset=self.lib.get(self.access,result['receipt']['assets'][0]['ref'])
        if publish:
            self.lib.transition(self.access,asset['ref'],'REVIEW');asset=self.lib.transition(self.access,asset['ref'],'PUBLISHED')
        return asset

    def test_operational_generation_schema_and_typed_normalization(self):
        from agent_framework.ontology import ontology_schema,source_context
        from agent_framework.ontology_model import normalize_generated
        from agent_framework.structured import validate,SchemaError
        shape=ontology_schema(source_context(self.lib,self.access,list(self.refs)),True)
        raw=deepcopy(self.value)
        for item in raw['model']['objects']:
            item['values']=[{'property_id':key,'values':value if isinstance(value,list) else [value]} for key,value in item['values'].items()]
        validate(raw,shape);normalized=normalize_generated(raw);self.assertEqual(normalized,self.value)
        validate_ontology(normalized,self.refs)
        bad=deepcopy(raw);bad['model']['objects'][0]['source_refs']=['unknown@1']
        with self.assertRaises(SchemaError):validate(bad,shape)
        bad=deepcopy(raw);bad['model']['objects'][0]['values'].append(deepcopy(bad['model']['objects'][0]['values'][0]))
        with self.assertRaises(ValueError):normalize_generated(bad)
        service=Learning(self.app);result=service.generate(dict(request_id='ontology-operational',purpose='ontology',source_refs=list(self.refs),agent_id=self.agent['id'],agent_revision=1,operational=True))
        self.assertEqual(result['output']['model']['version'],'operational-ontology@1.0.0')
        self.assertEqual(result['output']['model']['objects'],[])
        from unittest.mock import patch
        with patch('agent_framework.learning.agent_generate',return_value=(raw,{'model_calls':1,'usage':[]})):
            generated=service.generate(dict(request_id='ontology-typed-output',purpose='ontology',source_refs=list(self.refs),agent_id=self.agent['id'],agent_revision=1,operational=True))
        self.assertEqual(generated['output'],self.value)
        service.deposit(generated['id'],dict(revision=generated['revision'],item_ids=['ontology']))
        with self.assertRaises(SchemaError):validate(True,{'type':'number'})
        with self.assertRaises(SchemaError):validate(10**1000,{'type':'number'})

    def test_structural_and_instance_constraints_and_authoring_gate(self):
        self.assertTrue(validation_report(self.value,self.refs)['conforms']);validate_ontology(self.value,self.refs)
        bad=deepcopy(self.value);values=bad['model']['objects'][0]['values'];values.update(risk='MEDIUM',score=101,day='2026-02-30',verified='true',unknown='field');del values['id']
        report=validation_report(bad,self.refs)
        self.assertFalse(report['conforms']);codes={r['constraint'] for r in report['results']}
        self.assertTrue({'MinCountConstraintComponent','ClosedConstraintComponent','DatatypeConstraintComponent','InConstraintComponent','MaxInclusiveConstraintComponent'}<=codes)
        with self.assertRaises(ValueError):validate_ontology(bad,self.refs)
        self.assertTrue(all({'focus_node','path','message','constraint','severity'}<=r.keys() for r in report['results']))

    def test_primary_key_unique_and_link_endpoint_type_and_cardinality(self):
        bad=deepcopy(self.value);model=bad['model'];model['objects'].append(dict(id='change-2',type_id='change',values=dict(id='C001',risk='LOW'),source_refs=list(self.refs)))
        model['links'].append(dict(type_id='produces',source='change-2',target='report-1',source_refs=list(self.refs)))
        model['links'].append(dict(type_id='produces',source='report-1',target='missing',source_refs=list(self.refs)))
        codes={r['constraint'] for r in validation_report(bad,self.refs)['results']}
        self.assertTrue({'UniquePrimaryKeyConstraint','MaxCountConstraintComponent','NodeConstraintComponent'}<=codes)
        model['links'][-1]['target']='change-1'
        self.assertIn('ClassConstraintComponent',{r['constraint'] for r in validation_report(bad,self.refs)['results']})
        numeric=deepcopy(self.value);numeric['model']['object_types'][0]['properties'][0]['type']='number'
        numeric['model']['objects'][0]['values']['id']=1
        duplicate=deepcopy(numeric['model']['objects'][0]);duplicate['id']='change-numeric-duplicate';duplicate['values']['id']=1.0
        numeric['model']['objects'].append(duplicate)
        self.assertIn('UniquePrimaryKeyConstraint',{r['constraint'] for r in validation_report(numeric,self.refs)['results']})


    def test_unknown_refs_types_actions_and_schema_limits_rejected(self):
        cases=[]
        bad=deepcopy(self.value);bad['model']['action_types'][0]['capability_ref']='arbitrary.exec@1';cases.append(bad)
        bad=deepcopy(self.value);bad['model']['objects'][0]['source_refs']=['outside@1'];cases.append(bad)
        bad=deepcopy(self.value);bad['model']['object_types'][0]['concept_id']='missing';cases.append(bad)
        bad=deepcopy(self.value);bad['model']['object_types'][0]['properties'][0]['min_count']=False;cases.append(bad)
        bad=deepcopy(self.value);bad['model']['object_types'][0]['primary_key']='score';cases.append(bad)
        bad=deepcopy(self.value);bad['model']['objects'].append(deepcopy(bad['model']['objects'][0]));cases.append(bad)
        bad=deepcopy(self.value);bad['model']['version']='future';cases.append(bad)
        bad=deepcopy(self.value);bad['model']['object_types'][0]['concept_id']=[];cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad['model'].get('version')):self.assertFalse(validation_report(bad,self.refs)['conforms'])

    def test_object_sets_publication_source_revocation_and_principal_scope(self):
        asset=self.asset(False)
        with self.assertRaises(PolicyDenied):object_set(self.lib,self.access,asset)
        self.lib.transition(self.access,asset['ref'],'REVIEW');asset=self.lib.transition(self.access,asset['ref'],'PUBLISHED')
        found=object_set(self.lib,self.access,asset,'C001','change');self.assertEqual(len(found['items']),1);self.assertEqual(len(found['links']),1)
        self.assertEqual(object_set(self.lib,self.access,asset,'missing')['items'],[])
        with self.assertRaises(KeyError):self.lib.get(Access(self.access.tenant,'another',self.access.project),asset['ref'])
        self.lib.transition(self.access,self.source['ref'],'WITHDRAWN')
        with self.assertRaises(PolicyDenied):object_set(self.lib,self.access,asset)
        self.assertFalse(expand(self.lib,self.access,'唯一变更别名')['concepts'])

    def test_ranked_multihop_paths_predicates_provenance_and_direct_first(self):
        asset=self.asset();found=expand(self.lib,self.access,'唯一变更别名')
        self.assertEqual(found['concepts'][0]['id'],'change');self.assertEqual(len(found['concepts']),3)
        evidence=next(c for c in found['concepts'] if c['id']=='evidence');self.assertEqual(len(evidence['path']),2)
        self.assertEqual(evidence['path_source_refs'],list(self.refs))
        self.assertEqual(len(expand(self.lib,self.access,'唯一变更别名',max_hops=0)['concepts']),1)
        self.assertEqual(len(expand(self.lib,self.access,'唯一变更别名',predicates=['PRODUCES'])['concepts']),2)
        self.assertEqual(expand(self.lib,self.access,'唯一变更别名',limit=1)['concepts'][0]['match_kind'],'DIRECT')
        with self.assertRaises(ValueError):expand(self.lib,self.access,'q',max_hops=4)

    def test_skos_invariants_composition_cycles_and_version_stable_rdf_ids(self):
        bad=deepcopy(self.value);bad['concepts'][0]['aliases']=['变更']
        with self.assertRaises(ValueError):validate_ontology(bad,self.refs)
        bad=deepcopy(self.value);bad['relations']=[dict(source='change',target='report',predicate='PART_OF',source_refs=list(self.refs)),dict(source='report',target='change',predicate='PART_OF',source_refs=list(self.refs))]
        with self.assertRaises(ValueError):validate_ontology(bad,self.refs)
        asset=self.asset();new=revise(self.lib,self.access,asset['ref'],dict(content={**self.value,'description':'下一版本'}))
        old_graph=export_jsonld(asset);new_graph=export_jsonld(new)
        self.assertEqual(old_graph['@graph'][1]['@id'],new_graph['@graph'][1]['@id'])
        self.assertNotEqual(old_graph['@graph'][0]['owl:versionInfo'],new_graph['@graph'][0]['owl:versionInfo'])
        kinds={node.get('@type') for node in old_graph['@graph']}
        self.assertTrue({'owl:Class','sh:NodeShape','owl:ObjectProperty','af:ActionMapping','rdf:Statement'}<=kinds)
        shapes=[n for n in old_graph['@graph'] if n.get('@type')=='sh:NodeShape']
        self.assertTrue(shapes[0]['sh:closed']);self.assertTrue(any('sh:datatype' in p for p in shapes[0]['sh:property']))


class OntologyJobHTTPTests(unittest.TestCase):
    setUp = OperationalOntologyTests.setUp
    asset = OperationalOntologyTests.asset
    def test_contract_validate_objects_preview_and_scope_http(self):
        asset=self.asset();server=WebServer(('127.0.0.1',0),self.app)
        threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        def request(path,data=None,workspace=None):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5);headers={'Content-Type':'application/json','X-Agent-Token':self.app.token}
            if workspace:headers['X-Agent-Workspace']=workspace
            c.request('POST' if data is not None else 'GET',path,json.dumps(data) if data is not None else None,headers);r=c.getresponse();status=r.status;result=json.loads(r.read());c.close();return status,result
        prefix='/api/ontologies/'+quote(asset['ref'])
        self.assertTrue(request(prefix+'/validate')[1]['conforms'])
        self.assertEqual(request(prefix+'/objects?type_id=change')[1]['total'],1)
        before=self.app.runs()['counts']['total']
        status,preview=request(prefix+'/action-preview',dict(action_id='draft',object_id='change-1',agent_id=self.agent['id'],agent_revision=1))
        self.assertEqual(status,200);self.assertTrue(preview['available_to_agent']);self.assertFalse(preview['executed']);self.assertTrue(preview['requires_task_authorization'])
        qa=self.app.agents.save(profile('知识岗位','knowledge-answer@1.0.0'))
        self.assertFalse(request(prefix+'/action-preview',dict(action_id='draft',object_id='change-1',agent_id=qa['id'],agent_revision=1))[1]['available_to_agent'])
        self.assertEqual(self.app.runs()['counts']['total'],before)
        contract=request('/api/agents/'+self.agent['id']+'/evaluation-contract')[1]
        self.assertEqual(request('/api/agents/'+self.agent['id']+'/evaluation-contract',dict(revision=1,config=contract['config']))[0],200)
        self.assertTrue(request('/api/ontology-validate',dict(content=self.value,source_refs=list(self.refs)))[1]['conforms'])
        bad=deepcopy(self.value);bad['model']['objects'][0]['values']['score']=200
        self.assertFalse(request('/api/ontology-validate',dict(content=bad,source_refs=list(self.refs)))[1]['conforms'])
        w=self.app.workspaces.save(dict(name='其他空间',business='测试',scenario='隔离',description='',revision=0))
        self.assertEqual(request(prefix+'/objects',workspace=w['id'])[0],404)
        self.assertEqual(request('/api/agents/'+self.agent['id']+'/evaluation-contract',workspace=w['id'])[0],404)
        self.lib.transition(self.access,self.source['ref'],'WITHDRAWN')
        self.assertFalse(request(prefix+'/validate')[1]['conforms'])
        self.assertEqual(request(prefix+'/objects')[0],403)
