"""Workflow command receipts retain durable ordering and cancellation priority."""
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import ConfigConflict
from tests.test_workflows import definition, role,grant_token
from agent_framework.web import Application


class WorkflowReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=role(self.app);self.flows=self.app.workflows()
        self.workflow=self.flows.save(definition([self.agent]))

    def waiting(self):
        run=self.flows.start(self.workflow['id'],{'revision':self.workflow['revision']})
        return self.flows.execute(run['id'])

    def test_details_and_directory_expose_the_committed_event_revision(self):
        state=self.waiting();identity=state['id'];before=self.app.flow_detail(identity)
        self.assertEqual(before['run']['revision'],before['events'][-1]['seq'])
        self.flows.grant(identity,'n0',grant_token(self.app,identity,'n0'));granted=self.app.flow_detail(identity)
        self.flows.cancel(identity);cancelled=self.app.flow_detail(identity)
        self.assertGreater(granted['run']['revision'],before['run']['revision'])
        self.assertGreater(cancelled['run']['revision'],granted['run']['revision'])
        self.assertEqual(cancelled['run']['revision'],cancelled['events'][-1]['seq'])
        self.assertEqual(self.app.flow_runs()[0]['revision'],cancelled['run']['revision'])
        self.assertTrue(cancelled['run']['cancel_requested'])

    def test_cancelled_waiting_run_rejects_grant_without_changing_permission_or_dispatch(self):
        state=self.waiting();identity=state['id'];child=self.app.runtime().store.load(self.app.tenant,state['nodes']['n0']['run_id'])
        self.flows.cancel(identity);request=self.flows.dispatch_request(identity);events=self.flows.events(identity)
        with self.assertRaisesRegex(ConfigConflict,'取消|结束'):self.flows.grant(identity,'n0',grant_token(self.app,identity,'n0'))
        self.assertIsNone(self.app.runtime().store.get_grant(child))
        self.assertEqual(self.flows.dispatch_request(identity),request);self.assertEqual(self.flows.events(identity),events)
        self.assertFalse(any(e['kind']=='grant.issued' for e in self.app.runtime().store.events(self.app.tenant,child['run_id'])))

    def test_cancel_between_grant_preflight_and_commit_rolls_back_the_grant(self):
        state=self.waiting();identity=state['id'];other=self.app.workflows();original=self.flows.run
        child=self.app.runtime().store.load(self.app.tenant,state['nodes']['n0']['run_id'])
        def cancelled_after_read(run_id,**kwargs):
            prior=original(run_id,**kwargs)
            if not kwargs:other.cancel(run_id)
            return prior
        with patch.object(self.flows,'run',side_effect=cancelled_after_read):
            with self.assertRaisesRegex(ConfigConflict,'取消|结束'):self.flows.grant(identity,'n0',grant_token(self.app,identity,'n0'))
        self.assertIsNone(self.app.runtime().store.get_grant(child))
        self.assertTrue(other.run(identity)['cancel_requested']);self.assertEqual(other.dispatch_request(identity)['reason'],'cancel')
        self.assertFalse(any(e['kind']=='grant.issued' for e in self.app.runtime().store.events(self.app.tenant,child['run_id'])))

    def test_resume_after_failed_cancellation_keeps_the_stop_request_and_original_deadline(self):
        state=self.waiting();identity=state['id'];self.flows.cancel(identity)
        request=self.flows.dispatch_request(identity);self.flows.dispatch_error(identity,request['generation'],'temporary failure')
        retried=self.flows.request_dispatch(identity,'resume')
        self.assertEqual(retried['reason'],'cancel');self.assertGreater(retried['generation'],request['generation'])
        result=self.flows.execute(identity);self.assertEqual(result['status'],'CANCELLED');self.assertEqual(result['deadline'],state['deadline'])
        self.assertEqual(self.app.flow_detail(identity)['children']['n0']['draft_count'],0)

    def test_derived_revision_is_not_persisted_in_the_mutable_run_payload(self):
        state=self.waiting()
        with self.app.runtime().store.connect() as db:
            raw=json.loads(db.execute('SELECT data FROM workflow_runs WHERE tenant=? AND id=?',(self.app.tenant,state['id'])).fetchone()[0])
        self.assertNotIn('revision',raw);self.assertEqual(state['snapshot_hash'],raw['snapshot_hash'])
        self.assertGreater(self.flows.run(state['id'])['revision'],0)

    def test_resume_repairs_an_older_dispatch_that_lost_its_cancel_reason(self):
        state=self.waiting();identity=state['id'];self.flows.cancel(identity)
        prior=self.flows.dispatch_request(identity)
        with self.app.runtime().store.transaction() as db:
            db.execute("UPDATE workflow_dispatches SET reason='grant' WHERE tenant=? AND run_id=?",(self.app.tenant,identity))
        retried=self.flows.request_dispatch(identity,'resume')
        self.assertEqual(retried['reason'],'cancel');self.assertGreater(retried['generation'],prior['generation'])
        self.assertEqual(self.flows.execute(identity)['status'],'CANCELLED')

    def test_an_older_run_without_events_has_a_stable_zero_revision(self):
        state=self.waiting();identity=state['id']
        with self.app.runtime().store.transaction() as db:db.execute('DELETE FROM workflow_events WHERE tenant=? AND run_id=?',(self.app.tenant,identity))
        self.assertEqual(self.flows.run(identity)['revision'],0)


if __name__=='__main__':unittest.main()
