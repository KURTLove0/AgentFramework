"""HTTP task projections use one durable snapshot while workers keep writing."""
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application


class DetailSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='detail-snapshot-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.store=self.app.control_store
        self.root=self.app.create({'runtime':'mock','start':False})['run'];self.identity=self.root['run_id']
        self.service=TaskConversations(self.app,self.store);self.service.register(self.root)

    def advance(self,identity=None):
        identity=identity or self.identity
        with self.store.transaction() as db:
            row=db.execute('SELECT state FROM runs WHERE tenant_id=? AND id=?',(self.app.tenant,identity)).fetchone();state=json.loads(row[0])
            state.update(status='CANCELLED',version=state['version']+1,updated_at=state['updated_at']+1,report={'content':'后来保存的结果'})
            db.execute('UPDATE runs SET state=?,owner=NULL,lease_until=0 WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,identity))
            self.store.event(db,self.app.tenant,identity,'snapshot.later',{'version':state['version']})
            db.execute('INSERT OR REPLACE INTO evidence VALUES(?,?,?,?)',(self.app.tenant,identity,'later-evidence',canonical({'id':'later-evidence'})))
            db.execute('INSERT OR REPLACE INTO context_manifests VALUES(?,?,?,?)',(self.app.tenant,identity,'later-context',canonical({'id':'later-context'})))

    def test_raw_detail_does_not_mix_later_events_evidence_or_context_with_old_state(self):
        original=Store.get_grant;called=[]
        def advance_between_reads(store,state,**kwargs):
            grant=original(store,state,**kwargs)
            if not called:called.append(True);self.advance()
            return grant
        with patch.object(Store,'get_grant',advance_between_reads):detail=self.app.raw_detail(self.identity)
        self.assertEqual(detail['run']['version'],self.root['version'])
        self.assertNotIn('snapshot.later',[e['kind'] for e in detail['events']])
        self.assertNotIn('later-evidence',detail['evidence']);self.assertEqual(detail['context_manifests'],[])
        next_detail=self.app.raw_detail(self.identity);self.assertEqual(next_detail['run']['status'],'CANCELLED')
        self.assertIn('snapshot.later',[e['kind'] for e in next_detail['events']]);self.assertIn('later-evidence',next_detail['evidence'])

    def test_conversation_and_current_run_share_a_snapshot_under_continuous_writes(self):
        original=TaskConversations.view;calls=[]
        def advance_after_view(service,*args,**kwargs):
            result=original(service,*args,**kwargs);calls.append(True);self.advance();return result
        with patch.object(TaskConversations,'view',advance_after_view):detail=self.app.detail(self.identity)
        turn=detail['conversation']['turns'][0];current=detail['conversation']['current']['run']
        self.assertEqual(turn['status'],current['status']);self.assertEqual(turn['reply'],current.get('report'))
        self.assertEqual(turn['updated_at'],current['updated_at']);self.assertEqual(len(calls),1)
        self.assertEqual(detail['run']['version'],current['version'])

    def test_finished_job_cannot_pair_old_running_state_with_an_inactive_lease(self):
        with self.store.transaction() as db:
            state={**self.root,'status':'RUNNING'}
            db.execute('UPDATE runs SET state=?,owner=?,lease_until=? WHERE tenant_id=? AND id=?',(canonical(state),'worker-owner',4000000000,self.app.tenant,self.identity))
        self.app.jobs[self.identity]={'active':True,'state':'RUNNING'};original=TaskConversations._turn_states;called=[]
        def complete_after_read(service,*args):
            result=original(service,*args)
            if not called:called.append(True);self.advance();self.app.jobs[self.identity].update(active=False,state='COMPLETED')
            return result
        with patch.object(TaskConversations,'_turn_states',complete_after_read):view=self.service.view(self.identity)
        self.assertEqual(view['turns'][0]['status'],'RUNNING');self.assertFalse(view['resumable'])
        self.assertEqual(self.service.view(self.identity)['status'],'CANCELLED')

    def test_stop_request_cannot_appear_only_in_the_conversation_or_event_list(self):
        original=Store.get_grant;called=[]
        def request_after_read(store,state,**kwargs):
            grant=original(store,state,**kwargs)
            if not called:
                called.append(True);self.store.request_cancellation(self.app.tenant,self.identity)
            return grant
        with patch.object(Store,'get_grant',request_after_read):detail=self.app.detail(self.identity)
        self.assertIsNone(detail['cancellation']);self.assertIsNone(detail['conversation']['cancellation'])
        self.assertNotIn('run.cancel_requested',[e['kind'] for e in detail['events']])
        current=self.app.detail(self.identity)
        self.assertTrue(current['cancellation']['pending']);self.assertEqual(current['conversation']['status'],'CANCELLING')
        self.assertIn('run.cancel_requested',[e['kind'] for e in current['events']])

    def test_child_run_and_root_remain_in_the_same_snapshot(self):
        self.advance();child=self.app.create({'runtime':'mock','start':False})['run']
        with self.store.transaction() as db:
            db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,self.identity,2,child['run_id'],'second','继续','RUNNING',None,child['created_at']))
        original=TaskConversations.view
        def advance_child(service,*args,**kwargs):
            view=original(service,*args,**kwargs);self.advance(child['run_id']);return view
        with patch.object(TaskConversations,'view',advance_child):detail=self.app.detail(self.identity)
        conversation=detail['conversation'];current=conversation['current']
        self.assertEqual(detail['run']['status'],'CANCELLED');self.assertEqual(current['run']['run_id'],child['run_id'])
        self.assertEqual(current['run']['status'],child['status']);self.assertEqual(conversation['turns'][1]['status'],child['status'])
        self.assertNotIn('snapshot.later',[e['kind'] for e in current['events']])
        self.assertEqual(self.app.detail(self.identity)['conversation']['current']['run']['status'],'CANCELLED')

    def test_live_lease_survives_a_later_release_in_the_same_projection(self):
        with self.store.transaction() as db:
            state={**self.root,'status':'RUNNING'}
            db.execute('UPDATE runs SET state=?,owner=?,lease_until=? WHERE tenant_id=? AND id=?',(canonical(state),'another-process',4000000000,self.app.tenant,self.identity))
        original=Store.get_grant;called=[]
        def release_after_read(store,state,**kwargs):
            grant=original(store,state,**kwargs)
            if not called:called.append(True);self.advance()
            return grant
        with patch.object(Store,'get_grant',release_after_read):detail=self.app.detail(self.identity)
        self.assertIsNone(detail['job']);self.assertTrue(detail['lease']['active'])
        self.assertFalse(detail['conversation']['resumable']);self.assertEqual(detail['run']['status'],'RUNNING')
        self.assertFalse(self.app.detail(self.identity)['lease']['active'])


if __name__=='__main__':unittest.main()
