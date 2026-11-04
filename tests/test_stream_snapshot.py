"""Stream positions order persisted updates independently of wall-clock time."""
import http.client
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,WebServer


class StreamSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.root=self.app.create({'runtime':'mock','grant':False,'start':False})['run'];self.identity=self.root['run_id']
        self.store=self.app.control_store;self.service=TaskConversations(self.app,self.store);self.service.register(self.root)

    def test_event_only_progress_advances_position_without_a_checkpoint_or_new_timestamp(self):
        before=self.service.view(self.identity)
        with self.store.transaction() as db:self.store.event(db,self.app.tenant,self.identity,'model.progress',{'kind':'answer_text','text':'新增片段','attempt':1})
        after=self.service.view(self.identity)
        self.assertEqual(after.get('snapshot_format'),1)
        self.assertEqual(after['turns'][0]['checkpoint_version'],self.root['version'])
        self.assertEqual(before['updated_at'],after['updated_at'])
        self.assertGreater(after['turns'][0]['event_seq'],before['turns'][0]['event_seq'])
        self.assertEqual(after['turns'][0]['preview']['seq'],after['turns'][0]['event_seq'])

    def test_stream_job_hint_uses_the_same_initial_observation_as_resumability(self):
        self.app.jobs[self.identity]={'active':True,'state':'RUNNING'};original=TaskConversations._turn_progress
        def complete_during_read(service,*args,**kwargs):
            result=original(service,*args,**kwargs);self.app.jobs[self.identity].update(active=False,state='COMPLETED');return result
        with patch.object(TaskConversations,'_turn_progress',complete_during_read):view=self.service.view(self.identity)
        self.assertFalse(view['resumable']);self.assertTrue(view.get('current',{}).get('job',{}).get('active'))
        self.assertFalse(self.service.view(self.identity)['current']['job']['active'])

    def test_snapshot_positions_match_http_detail_and_export_has_no_live_job(self):
        detail=self.app.detail(self.identity);turn=detail['conversation']['turns'][0]
        self.assertEqual(turn.get('checkpoint_version'),detail['run']['version'])
        self.assertEqual(turn['event_seq'],detail['events'][-1]['seq']);self.assertEqual(turn['dispatch_state'],'RUNNING')
        exported=self.service.export(self.identity)
        self.assertEqual(exported['snapshot_format'],1);self.assertNotIn('current',exported)

    def test_permission_wait_emits_final_stream_snapshot_and_settled_without_spinning(self):
        self.app.runtime().run(self.identity)
        server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        conn=http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=3);self.addCleanup(conn.close)
        conn.request('GET','/api/tasks/'+self.identity+'/stream');response=conn.getresponse()
        self.assertEqual(response.status,200);body=response.read().decode()
        frames=[line[6:] for line in body.splitlines() if line.startswith('data: ')]
        snapshot=json.loads(frames[0]);self.assertEqual(snapshot['status'],'WAITING_AUTH')
        self.assertEqual(snapshot['snapshot_format'],1);self.assertFalse(snapshot['can_reply'])
        self.assertIn('event: settled',body);self.assertEqual(len(frames),2)


if __name__=='__main__':unittest.main()
