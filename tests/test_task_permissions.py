"""Task approval/revocation binds reviewed state and survives dispatch gaps."""
from concurrent.futures import Future,ThreadPoolExecutor
from copy import deepcopy
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical,digest,PolicyDenied
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_permissions import TaskPermissions
from agent_framework.web import Application
from tests import test_web as fixtures


class TaskPermissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(lambda:self.app.close())
        self.identity=self.app.create({'start':False,'grant':False})['run']['run_id'];self.app.runtime().run(self.identity)
        self.service=TaskPermissions(self.app);self.store=self.app.control_store;self.state=self.store.result(self.app.tenant,self.identity)
        self.proof=self.app.detail(self.identity)['permissions']['grant_token']

    def capacity(self):
        self.app.jobs.update({'permission-capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})

    def release(self):
        for key in list(self.app.jobs):
            if key.startswith('permission-capacity-'):self.app.jobs.pop(key)

    def wait(self):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            d=self.app.detail(self.identity)
            if d['run']['status']=='SUCCEEDED' and not (d['job'] or {}).get('active'):return d
            time.sleep(.02)
        self.fail(str(self.app.detail(self.identity)))

    def approve(self):return self.service.change(self.identity,'grant',self.proof)

    def untouched(self):
        self.assertIsNone(self.store.get_grant(self.state));self.assertIsNone(self.service.request(self.identity))
        self.assertFalse(any(e['kind']=='task.permission_accepted' for e in self.store.events(self.app.tenant,self.identity)))

    def replace_proposal(self,corrupt=False):
        pending=self.service.pending(self.store.result(self.app.tenant,self.identity));pending['args']['report']['summary']='已变更的模拟提案'
        if not corrupt:pending['args_hash']=digest(pending['args'])
        with self.store.transaction() as db:db.execute('UPDATE actions SET data=? WHERE tenant_id=? AND run_id=? AND logical_id=?',(canonical(pending),self.app.tenant,self.identity,pending['logical_id']))

    def test_detail_tokens_do_not_issue_permission_or_dispatch(self):
        before=self.store.events(self.app.tenant,self.identity)
        d=self.app.detail(self.identity);self.assertEqual(d['permissions']['grant_token'],self.proof);self.assertIsNone(d['permissions']['request'])
        self.assertEqual(self.store.events(self.app.tenant,self.identity),before);self.untouched()

    def test_changed_proposal_rejects_old_review(self):
        self.replace_proposal()
        with self.assertRaisesRegex(ConfigConflict,'已变化'):self.approve()
        self.untouched()
        self.service.change(self.identity,'grant',self.app.detail(self.identity)['permissions']['grant_token']);self.assertIsNotNone(self.service.request(self.identity))

    def test_invalid_hash_rejected_even_with_fresh_detail_token(self):
        self.replace_proposal(corrupt=True)
        with self.assertRaisesRegex(ConfigConflict,'摘要不一致'):self.service.change(self.identity,'grant',self.app.detail(self.identity)['permissions']['grant_token'])
        self.untouched()

    def test_same_arguments_on_replacement_action_require_new_review(self):
        pending=self.service.pending(self.state);logical=pending['logical_id'];pending['logical_id']+='-new'
        with self.store.transaction() as db:db.execute('UPDATE actions SET logical_id=?,data=? WHERE tenant_id=? AND run_id=? AND logical_id=?',(pending['logical_id'],canonical(pending),self.app.tenant,self.identity,logical))
        with self.assertRaises(ConfigConflict):self.approve()
        self.untouched()

    def test_duplicate_and_concurrent_requests_commit_once_without_renewal(self):
        with ThreadPoolExecutor(max_workers=4) as pool:values=list(pool.map(lambda _:self.approve(),range(4)))
        self.assertEqual(sum(not v['replayed'] for v in values),1)
        grant=self.store.get_grant(self.state);request=self.service.request(self.identity);events=self.store.events(self.app.tenant,self.identity)
        self.approve();self.assertEqual(self.store.get_grant(self.state),grant);self.assertEqual(self.service.request(self.identity),request);self.assertEqual(self.store.events(self.app.tenant,self.identity),events)

    def test_revoke_clears_pending_dispatch_and_old_grant_cannot_restore_it(self):
        self.approve();proof=self.app.detail(self.identity)['permissions']['revoke_token'];self.service.change(self.identity,'revoke',proof)
        revoked=self.store.get_grant(self.state);self.approve();self.assertEqual(self.store.get_grant(self.state),revoked);self.assertTrue(revoked['revoked']);self.assertIsNone(self.service.request(self.identity))
        self.assertFalse(self.service.dispatch(self.identity,proof=self.proof))

    def test_old_revoke_receipt_cannot_revoke_new_permission(self):
        self.approve();old=self.app.detail(self.identity)['permissions']['revoke_token'];self.service.change(self.identity,'revoke',old)
        self.service.change(self.identity,'grant',self.app.detail(self.identity)['permissions']['grant_token']);current=self.store.get_grant(self.state)
        self.service.change(self.identity,'revoke',old);self.assertEqual(self.store.get_grant(self.state),current);self.assertFalse(current['revoked'])

    def test_unaccepted_old_revocation_rejects_changed_permission(self):
        self.approve();old=self.app.detail(self.identity)['permissions']['revoke_token'];self.store.grant(self.state,self.service.pending(self.state)['args_hash'])
        with self.assertRaisesRegex(ConfigConflict,'已变化'):self.service.change(self.identity,'revoke',old)
        self.assertFalse(self.store.get_grant(self.state)['revoked'])

    def test_expired_receipt_does_not_renew_permission(self):
        self.approve()
        with self.store.transaction() as db:db.execute('UPDATE grants SET expires_at=? WHERE tenant_id=? AND run_id=?',(time.time()-1,self.app.tenant,self.identity))
        expired=self.store.get_grant(self.state);self.approve();self.assertEqual(self.store.get_grant(self.state),expired)
        self.assertFalse(self.service.dispatch(self.identity));self.assertIsNone(self.service.request(self.identity))
        self.service.change(self.identity,'grant',self.app.detail(self.identity)['permissions']['grant_token']);self.assertGreater(self.store.get_grant(self.state)['expires_at'],time.time())

    def test_cancel_before_acceptance_rejects_without_partial_grant(self):
        self.store.request_cancellation(self.app.tenant,self.identity)
        with self.assertRaisesRegex(ConfigConflict,'正在停止'):self.approve()
        self.untouched()

    def test_cancel_after_acceptance_stops_pending_dispatch(self):
        self.approve();self.store.request_cancellation(self.app.tenant,self.identity)
        self.assertFalse(self.service.dispatch(self.identity));self.assertIsNone(self.service.request(self.identity));self.assertIsNone(self.app.job(self.identity))

    def test_full_queue_survives_application_reopen_with_one_write(self):
        self.capacity();d=self.app.mutate(self.identity,'grant',{'proof':self.proof});self.assertEqual(d['permissions']['request']['state'],'QUEUED')
        grant=self.store.get_grant(self.state);self.app.close();self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2)
        TaskPermissions.tick(self.app);d=self.wait();self.assertEqual(len(d['external']['drafts']),1);self.assertEqual(d['external']['calls']['report.draft.create@1.0.0'],1)
        self.assertEqual(self.app.control_store.get_grant(self.state),grant);self.assertIsNone(d['permissions']['request'])

    def test_executor_failure_requires_explicit_retry_and_keeps_permission(self):
        with patch.object(self.app.pool,'submit',side_effect=RuntimeError('synthetic pool failure')):
            d=self.app.mutate(self.identity,'grant',{'proof':self.proof})
        self.assertEqual(d['permissions']['request']['state'],'ERROR');grant=self.store.get_grant(self.state)
        with patch.object(self.app,'schedule') as schedule:TaskPermissions.tick(self.app);schedule.assert_not_called()
        self.app.mutate(self.identity,'resume');d=self.wait();self.assertIsNone(d['permissions']['request']);self.assertEqual(self.store.get_grant(self.state),grant)

    def test_explicit_retry_stays_queued_until_capacity_recovers(self):
        with patch.object(self.app.pool,'submit',side_effect=RuntimeError('synthetic pool failure')):
            self.app.mutate(self.identity,'grant',{'proof':self.proof})
        grant=self.store.get_grant(self.state);self.capacity()
        self.app.mutate(self.identity,'resume');TaskPermissions.tick(self.app)
        self.assertEqual(self.app.detail(self.identity)['permissions']['request']['state'],'QUEUED')
        self.release();TaskPermissions.tick(self.app);d=self.wait()
        self.assertEqual(len(d['external']['drafts']),1);self.assertEqual(self.store.get_grant(self.state),grant)

    def test_shutdown_after_queue_handoff_before_worker_start_keeps_intent(self):
        with patch.object(self.app.pool,'submit',return_value=Future()):
            self.app.mutate(self.identity,'grant',{'proof':self.proof})
        self.assertIsNotNone(self.service.request(self.identity));self.assertTrue(self.app.job(self.identity)['active'])
        self.app.close();self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2)
        TaskPermissions.tick(self.app);d=self.wait();self.assertEqual(len(d['external']['drafts']),1)
        self.assertEqual(d['external']['calls']['report.draft.create@1.0.0'],1);self.assertIsNone(d['permissions']['request'])

    def test_busy_worker_keeps_the_request_until_worker_releases_it(self):
        self.approve();self.app.jobs[self.identity]={'active':True,'cancel':threading.Event()}
        self.assertFalse(self.service.dispatch(self.identity));self.assertIsNotNone(self.service.request(self.identity))
        self.app.jobs.pop(self.identity);self.assertTrue(self.service.dispatch(self.identity));self.wait()

    def test_receipt_failure_rolls_back_permission_and_dispatch(self):
        original=self.store.event
        def fail(db,tenant,run,kind,data):
            if kind=='task.permission_accepted':raise RuntimeError('receipt failed')
            return original(db,tenant,run,kind,data)
        with patch.object(self.store,'event',side_effect=fail):
            with self.assertRaisesRegex(RuntimeError,'receipt failed'):self.approve()
        self.untouched()

    def test_later_pending_request_is_not_dispatched_by_an_old_receipt(self):
        self.approve();new_proof=self.app.detail(self.identity)['permissions']['grant_token'];self.service.change(self.identity,'grant',new_proof)
        self.assertFalse(self.service.dispatch(self.identity,proof=self.proof));self.assertEqual(self.service.request(self.identity)['proof'],new_proof)

    def test_actor_and_workspace_proofs_are_not_interchangeable(self):
        other=Application(self.tmp.name,principal='another-person');self.addCleanup(other.close)
        with self.assertRaises((PolicyDenied,ConfigConflict)):TaskPermissions(other).change(self.identity,'grant',self.proof)
        space=self.app.workspaces.save({'name':'另一个空间','business':'测试','scenario':'测试','description':'','revision':0})
        with self.assertRaises(PolicyDenied):TaskPermissions(self.app.scoped(space['id'])).change(self.identity,'grant',self.proof)
        self.untouched()

    def test_old_round_cannot_be_authorized_after_new_round_exists(self):
        root=self.store.load(self.app.tenant,self.identity);current=deepcopy(root);current['run_id']=self.identity+'-next'
        current['task']['source_run_id']=self.identity;current['task']['conversation_context']={'task_id':self.identity};current['task']['execution_mode']='conversation'
        with self.store.transaction() as db:
            db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,?,?)',(self.app.tenant,current['run_id'],current['version'],canonical(current)))
            for number,run in [(1,root),(2,current)]:db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,self.identity,number,run['run_id'],'turn-'+str(number),'模拟轮次','RUNNING',None,time.time()))
        with self.assertRaisesRegex(ConfigConflict,'另一轮'):self.approve()
        self.untouched()

    def test_missing_proof_and_extra_fields_fail_before_mutation(self):
        for body in ({},{'proof':None},{'proof':True},{'proof':'g'*64},{'proof':self.proof,'grant':True}):
            with self.assertRaises(ValueError):self.app.mutate(self.identity,'grant',body)
        self.untouched()


class TaskPermissionHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_proof_required_and_full_queue_returns_accepted_persistent_request(self):
        identity=self.app.create({'start':False,'grant':False})['run']['run_id'];self.app.runtime().run(identity)
        proof=json.loads(self.request('/api/runs/'+identity)[2])['permissions']['grant_token']
        self.app.jobs.update({'capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
        endpoint='/api/runs/'+identity+'/grant'
        self.assertEqual(self.request(endpoint,'POST','{}')[0],400)
        self.assertEqual(self.request(endpoint,'POST',json.dumps({'proof':'b'*64}))[0],409)
        status,_,body=self.request(endpoint,'POST',json.dumps({'proof':proof}));self.assertEqual(status,202)
        self.assertEqual(json.loads(body)['permissions']['request']['state'],'QUEUED')
        revoke=json.loads(body)['permissions']['revoke_token'];self.assertEqual(self.request('/api/runs/'+identity+'/revoke','POST',json.dumps({'proof':revoke}))[0],202)
        self.assertFalse(json.loads(self.request('/api/runs/'+identity)[2])['grant']['valid'])

    def test_confirmation_script_is_served(self):
        status,_,body=self.request('/run_action.js');self.assertEqual(status,200);self.assertIn(b'runActionCurrent',body)


if __name__=='__main__':unittest.main()
