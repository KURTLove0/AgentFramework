"""Routing is decided from verified outputs, never model-generated permission."""
from copy import deepcopy
import time
import unittest
from agent_framework.web import Application
from agent_framework.contracts import TaskContract,digest
from agent_framework.workflow_rules import matches
from agent_framework.structured import validate
from agent_framework.workflow_chat import RESPONSE
from tests import test_workflows as fixtures
from tests.test_workflows import role,definition


class RoutingTests(unittest.TestCase):
    setUp=fixtures.WorkflowTests.setUp
    def branching(self):
        qa=role(self.app,'引用岗位','knowledge-answer@1.0.0')
        data=definition([qa,self.p,self.p,qa]);data['nodes'][0].update(goal='查询模拟风险规则',retrieval={'query':'变更风险', 'top_k':1})
        data['nodes'][1].update(condition={'source':'n0','field':'citations_count','operator':'gte','value':1})
        data['nodes'][2].update(depends_on=['n0'],condition={'source':'n0','field':'citations_count','operator':'eq','value':0})
        data['nodes'][3].update(depends_on=['n1','n2'],join='any',goal='核对模拟风险规则')
        return data

    def test_selected_branch_waits_for_auth_and_skipped_branch_never_writes(self):
        w=self.f.save(self.branching());s=self.f.start(w['id'],{'revision':1,'grant':False,'scenarios':{'n1':'response-lost'}})
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'WAITING_AUTH');self.assertIsNone(r['nodes']['n2']['run_id']);self.assertIsNone(r['nodes']['n3']['run_id'])
        self.f.grant(s['id'],'n1');r=self.f.execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED')
        self.assertEqual(r['nodes']['n2']['status'],'SKIPPED');self.assertIsNone(r['nodes']['n2']['run_id'])
        self.assertEqual([i['node_id'] for i in r['nodes']['n3']['inputs']],['n1'])
        child=r['nodes']['n1']['run_id'];stats=self.app.runtime().external.stats(self.app.tenant,child)
        self.assertEqual(len(stats['drafts']),1);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1)
        again=self.f.execute(s['id']);self.assertEqual(again['snapshot_hash'],r['snapshot_hash'])
        self.assertTrue(any(e['kind']=='node.skipped' for e in self.f.events(s['id'])))

    def test_branch_recovery_uses_same_child_and_skips_unselected_branch(self):
        w=self.f.save(self.branching());s=self.f.start(w['id'],{'revision':1,'grant':True,'scenarios':{'n1':'crash-after-write'}})
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'INTERRUPTED');child=r['nodes']['n1']['run_id']
        time.sleep(.9)
        new=Application(self.tmp.name,lease_seconds=.8,tool_timeout=.3);self.addCleanup(new.close)
        r=new.workflows().execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED');self.assertEqual(r['nodes']['n1']['run_id'],child)
        self.assertIsNone(r['nodes']['n2']['run_id']);stats=new.runtime().external.stats(new.tenant,child)
        self.assertEqual(len(stats['drafts']),1);self.assertEqual(stats['calls']['report.draft.create@1.0.0'],1)

    def test_all_join_propagates_skip_and_arbitrary_node_order_works(self):
        data=self.branching();data['nodes'][3]['join']='all';data['nodes'].reverse()
        w=self.f.save(data);s=self.f.start(w['id'],{'revision':1,'grant':True});r=self.f.execute(s['id'])
        self.assertEqual(r['status'],'SUCCEEDED');self.assertEqual(r['nodes']['n3']['status'],'SKIPPED');self.assertIsNone(r['nodes']['n3']['run_id'])

    def test_rag_query_top_k_are_effective_and_frozen(self):
        lib=self.app.library();access=self.app.library_access()
        for i in range(3):
            a=lib.create(access,{'title':'独特检索令牌 '+str(i),'content':{'text':'独特检索令牌 资料 '+str(i)}})
            lib.transition(access,a['ref'],'REVIEW');lib.transition(access,a['ref'],'PUBLISHED')
        qa=role(self.app,'RAG 岗位','knowledge-answer@1.0.0');data=definition([qa]);data['nodes'][0].update(goal='回答所检索资料',retrieval={'query':'独特检索令牌','top_k':2})
        w=self.f.save(data);s=self.f.start(w['id'],{'revision':1});r=self.f.execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED')
        child=self.app.runtime().store.result(self.app.tenant,r['nodes']['n0']['run_id']);self.assertEqual(len(child['report']['citations']),2)
        self.assertEqual(child['task']['retrieval'],data['nodes'][0]['retrieval'])
        action=next(a for a in child['actions'] if a['tool_ref']=='knowledge.search@1.0.0');self.assertEqual(action['args']['query'],'独特检索令牌')
        self.assertTrue(all(c['passed'] for c in child['checks'].values()))
        # Current source withdrawal still invalidates frozen retrieval results.
        lib.transition(access,child['report']['citations'][0]['asset_ref'],'WITHDRAWN');self.assertFalse(self.f._verified(self.app.runtime().store.result(self.app.tenant,child['run_id'])))

    def test_rag_empty_stops_before_downstream_and_recovers_after_publish(self):
        data=self.branching();data['nodes'][0]['retrieval']['query']='zxmissingquery'
        w=self.f.save(data);s=self.f.start(w['id'],{'revision':1,'grant':True});r=self.f.execute(s['id'])
        self.assertEqual(r['status'],'WAITING_INPUT');self.assertIsNone(r['nodes']['n1']['run_id'])
        lib=self.app.library();a=lib.create(self.app.library_access(),{'title':'zxmissingquery','content':{'text':'zxmissingquery 已发布模拟资料'}})
        lib.transition(self.app.library_access(),a['ref'],'REVIEW');lib.transition(self.app.library_access(),a['ref'],'PUBLISHED')
        r=self.f.execute(s['id']);self.assertEqual(r['status'],'SUCCEEDED')

    def test_config_rejects_expressions_wrong_source_types_and_cycles(self):
        for bad in ({'source':'n0','field':'__import__','operator':'eq','value':'x'}, {'source':'missing','field':'risk_level','operator':'eq','value':'HIGH'}, {'source':'n0','field':'citations_count','operator':'gte','value':True}):
            d=self.branching();d['nodes'][1]['condition']=bad
            with self.assertRaises(ValueError):self.f.save(d)
        for bad in ({'query':'x','top_k':True},{'query':'','top_k':3},{'query':'x','top_k':9},{'query':'x','top_k':3,'project_id':'foreign'}):
            d=self.branching();d['nodes'][0]['retrieval']=bad
            with self.assertRaises(ValueError):self.f.save(d)
        self.assertFalse(matches({'field':'risk_level','operator':'ne','value':'HIGH'},{}))

    def test_legacy_contract_and_definition_keep_original_shape(self):
        self.assertNotIn('retrieval',TaskContract().to_dict())
        data=definition([self.p]);w=self.f.save(data)
        self.assertEqual(w['nodes'],data['nodes']);s=self.f.start(w['id'],{'revision':1,'grant':True});self.assertEqual(self.f.execute(s['id'])['status'],'SUCCEEDED')

    def test_model_schema_accepts_legacy_and_extended_branch_proposals(self):
        data=self.branching();data.pop('revision')
        for n in data['nodes']:
            n.update(join=n.get('join','all'),condition=n.get('condition'),retrieval=n.get('retrieval'))
        validate({'reply':'已生成分支提案','workflow':data},RESPONSE)
        self.f.validate(deepcopy(data))
