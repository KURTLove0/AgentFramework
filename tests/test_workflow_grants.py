"""A workflow approval binds the reviewed proposal and commits atomically."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical,digest
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application
from tests.test_workflows import definition,role,grant_token
from tests import test_workflows as fixtures


class WorkflowGrantTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.flows=self.app.workflows();self.store=self.flows.store
        self.workflow=self.flows.save(definition([role(self.app)]))
        self.state=self.flows.execute(self.flows.start(self.workflow['id'],{'revision':1})['id'])
        self.identity=self.state['id'];self.child=self.store.result(self.app.tenant,self.state['nodes']['n0']['run_id'])
        self.token=grant_token(self.app,self.identity,'n0')

    def approve(self,token=None):
        return self.flows.grant(self.identity,'n0',self.token if token is None else token)

    def proposal(self):
        return next(a for a in self.store.actions(self.child) if a['tool_ref']=='report.draft.create@1.0.0' and a['status']=='PREPARED')

    def alter_proposal(self,change):
        value=self.proposal();logical=value['logical_id'];change(value)
        with self.store.transaction() as db:
            db.execute('UPDATE actions SET logical_id=?,status=?,data=? WHERE tenant_id=? AND run_id=? AND logical_id=?',
                       (value['logical_id'],value['status'],canonical(value),self.app.tenant,self.child['run_id'],logical))

    def untouched(self):
        self.assertIsNone(self.store.get_grant(self.child))
        self.assertIsNone(self.flows.dispatch_request(self.identity))
        self.assertFalse(any(e['kind']=='workflow.granted' for e in self.flows.events(self.identity)))

    def test_detail_proof_is_read_only_and_bound_to_scope_run_node_and_content(self):
        events=self.flows.events(self.identity)
        self.assertEqual(grant_token(self.app,self.identity,'n0'),self.token)
        proposal=self.proposal()
        for identity,node in [(self.identity,'n1'),('flowrun-other','n0')]:
            self.assertNotEqual(self.flows.grant_token(identity,node,self.child,proposal),self.token)
        other=deepcopy(self.child);other['run_id']='other-run'
        self.assertNotEqual(self.flows.grant_token(self.identity,'n0',other,proposal),self.token)
        self.assertEqual(self.flows.events(self.identity),events);self.untouched()

    def test_changed_arguments_with_new_valid_hash_reject_old_review(self):
        def change(p):p['args']['report']['summary']='新的模拟提案';p['args_hash']=digest(p['args'])
        # A valid changed body is enough; the server must not substitute it.
        self.alter_proposal(change)
        with self.assertRaisesRegex(ConfigConflict,'已变化'):self.approve()
        self.untouched()
        self.approve(grant_token(self.app,self.identity,'n0'))
        self.assertEqual(self.store.get_grant(self.child)['args_hash'],self.proposal()['args_hash'])

    def test_logical_action_identity_is_bound_even_with_identical_arguments(self):
        self.alter_proposal(lambda p:p.update(logical_id=p['logical_id']+'-replacement'))
        with self.assertRaisesRegex(ConfigConflict,'已变化'):self.approve()
        self.untouched()

    def test_corrupt_argument_hash_cannot_be_approved_even_after_reread(self):
        self.alter_proposal(lambda p:p['args'].update(project_id='changed-project'))
        with self.assertRaisesRegex(ConfigConflict,'摘要不一致'):self.approve(grant_token(self.app,self.identity,'n0'))
        self.untouched()

    def test_completed_or_missing_proposal_rejects_old_review(self):
        self.alter_proposal(lambda p:p.update(status='SUCCEEDED'))
        with self.assertRaisesRegex(ConfigConflict,'没有具体'):self.approve()
        self.untouched()

    def test_child_state_is_checked_inside_acceptance_transaction(self):
        changed=deepcopy(self.child);changed.pop('actions');changed['status']='CANCELLED'
        with self.store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(changed),self.app.tenant,self.child['run_id']))
        with self.assertRaisesRegex(ConfigConflict,'状态已变化'):self.approve()
        self.untouched()

    def test_child_stop_request_blocks_approval(self):
        self.store.request_cancellation(self.app.tenant,self.child['run_id'])
        with self.assertRaisesRegex(ConfigConflict,'正在停止'):self.approve()
        self.untouched()

    def test_latest_conversation_turn_is_the_reviewed_and_authorized_child(self):
        root=self.store.load(self.app.tenant,self.child['run_id']);root['task']['execution_mode']='conversation';root['status']='WAITING_INPUT'
        current=deepcopy(root);current['run_id']=root['run_id']+'-followup';current['status']='WAITING_AUTH'
        current['task']['source_run_id']=root['run_id'];current['task']['conversation_context']={'task_id':root['run_id']}
        proposal=self.proposal()
        with self.store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(root),self.app.tenant,root['run_id']))
            db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,?,?)',(self.app.tenant,current['run_id'],current['version'],canonical(current)))
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?)',(self.app.tenant,current['run_id'],proposal['logical_id'],proposal['status'],canonical(proposal)))
            for number,run in [(1,root),(2,current)]:
                db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,root['run_id'],number,run['run_id'],'turn-'+str(number),'模拟补充材料','RUNNING',None,time.time()))
        detail=self.app.flow_detail(self.identity);self.assertEqual(detail['children']['n0']['run_id'],current['run_id'])
        with self.assertRaisesRegex(ConfigConflict,'已变化'):self.approve()
        self.approve(detail['children']['n0']['proposal_token'])
        self.assertIsNone(self.store.get_grant(root));self.assertEqual(self.store.get_grant(current)['args_hash'],proposal['args_hash'])

    def test_another_review_of_active_permission_does_not_extend_it(self):
        self.approve();permission=self.store.get_grant(self.child);dispatch=self.flows.dispatch_request(self.identity)
        self.approve(grant_token(self.app,self.identity,'n0'))
        self.assertEqual(self.store.get_grant(self.child),permission);self.assertEqual(self.flows.dispatch_request(self.identity),dispatch)
        self.assertEqual(sum(e['kind']=='grant.issued' for e in self.store.events(self.app.tenant,self.child['run_id'])),1)

    def test_change_after_preflight_is_revalidated_before_grant(self):
        original=self.flows.run
        def changed_after_read(identity,**kwargs):
            state=original(identity,**kwargs)
            if not kwargs:self.alter_proposal(lambda p:p.update(logical_id=p['logical_id']+'-later'))
            return state
        with patch.object(self.flows,'run',side_effect=changed_after_read):
            with self.assertRaisesRegex(ConfigConflict,'已变化'):self.approve()
        self.untouched()

    def test_duplicates_do_not_extend_permission_or_register_dispatch_again(self):
        first=self.approve();permission=self.store.get_grant(self.child);events=self.flows.events(self.identity);dispatch=self.flows.dispatch_request(self.identity)
        self.assertEqual(self.approve(),first)
        self.assertEqual(self.store.get_grant(self.child),permission)
        self.assertEqual(self.flows.events(self.identity),events);self.assertEqual(self.flows.dispatch_request(self.identity),dispatch)

    def test_concurrent_approval_has_one_grant_and_one_dispatch(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            values=list(pool.map(lambda _:self.app.workflows().grant(self.identity,'n0',self.token),range(4)))
        self.assertTrue(all(v==values[0] for v in values))
        self.assertEqual(sum(e['kind']=='grant.issued' for e in self.store.events(self.app.tenant,self.child['run_id'])),1)
        self.assertEqual(sum(e['kind']=='workflow.dispatch_requested' for e in self.flows.events(self.identity)),2) # start and grant

    def test_restart_and_revocation_do_not_make_old_receipt_issue_permission_again(self):
        original=self.approve();self.store.grant(self.child,original['args_hash'],revoke=True)
        permission=self.store.get_grant(self.child);events=self.flows.events(self.identity)
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(restarted.workflows().grant(self.identity,'n0',self.token),original)
        self.assertEqual(self.store.get_grant(self.child),permission);self.assertTrue(permission['revoked'])
        self.assertEqual(self.flows.events(self.identity),events)

    def test_expired_old_receipt_does_not_renew_but_fresh_review_can(self):
        self.approve()
        with self.store.transaction() as db:db.execute('UPDATE grants SET expires_at=? WHERE tenant_id=? AND run_id=?',(time.time()-1,self.app.tenant,self.child['run_id']))
        expired=self.store.get_grant(self.child);self.approve();self.assertEqual(self.store.get_grant(self.child),expired)
        fresh=grant_token(self.app,self.identity,'n0');self.assertNotEqual(fresh,self.token);self.approve(fresh)
        renewed=self.store.get_grant(self.child);self.assertGreater(renewed['expires_at'],time.time())
        self.approve(fresh);self.assertEqual(self.store.get_grant(self.child),renewed)

    def test_unaccepted_review_is_invalidated_by_revocation(self):
        self.store.grant(self.child,self.proposal()['args_hash'],revoke=True)
        with self.assertRaisesRegex(ConfigConflict,'已变化'):self.approve()
        self.assertTrue(self.store.get_grant(self.child)['revoked']);self.assertIsNone(self.flows.dispatch_request(self.identity))

    def test_committed_old_approval_cannot_replace_a_later_cancel_dispatch(self):
        self.approve();self.flows.cancel(self.identity);events=self.flows.events(self.identity);dispatch=self.flows.dispatch_request(self.identity)
        self.approve();self.assertEqual(self.flows.events(self.identity),events);self.assertEqual(self.flows.dispatch_request(self.identity),dispatch)
        self.assertEqual(dispatch['reason'],'cancel')

    def test_grant_and_receipt_roll_back_when_dispatch_fails(self):
        with patch.object(self.flows,'_request_dispatch',side_effect=RuntimeError('dispatch unavailable')):
            with self.assertRaisesRegex(RuntimeError,'dispatch unavailable'):self.approve()
        self.untouched()
        self.assertFalse(any(e['kind']=='grant.issued' for e in self.store.events(self.app.tenant,self.child['run_id'])))

    def test_malformed_proofs_and_wrong_node_cannot_authorize(self):
        for token in (None,True,{},'a'*63,'g'*64):
            with self.assertRaises(ValueError):self.flows.grant(self.identity,'n0',token)
        with self.assertRaises(ConfigConflict):self.flows.grant(self.identity,'other',self.token)
        self.untouched()


class WorkflowGrantHTTPTests(unittest.TestCase):
    setUp=fixtures.WorkflowHTTPTests.setUp
    request=fixtures.WorkflowHTTPTests.request

    def test_http_requires_reviewed_proposal_and_preserves_exact_retry(self):
        flows=self.app.workflows();w=flows.save(definition([self.p]));state=flows.execute(flows.start(w['id'],{'revision':1})['id']);path='/api/workflow-runs/'+state['id']+'/grant'
        token=self.request('/api/workflow-runs/'+state['id'])[1]['children']['n0']['proposal_token']
        for body in ({'node_id':'n0'},{'node_id':'n0','proposal_token':None},{'node_id':'n0','proposal_token':token,'grant':True}):self.assertEqual(self.request(path,body)[0],400)
        with patch.object(self.app,'enqueue_flow',return_value=False):
            self.assertEqual(self.request(path,{'node_id':'n0','proposal_token':'a'*64})[0],409)
            self.assertEqual(self.request(path,{'node_id':'n0','proposal_token':token})[0],202)
            events=flows.events(state['id']);self.assertEqual(self.request(path,{'node_id':'n0','proposal_token':token})[0],202)
        self.assertEqual(flows.events(state['id']),events)


if __name__=='__main__':unittest.main()
