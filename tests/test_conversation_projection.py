"""Conversation views read only required public fields while retaining full audit."""
import json
from copy import deepcopy
import random
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.contracts import PolicyDenied, canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application


class ConversationProjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.root = self.app.create({'runtime': 'mock', 'start': False})['run']
        self.identity = self.root['run_id']
        self.store = self.app.control_store
        self.service = TaskConversations(self.app, self.store)
        self.service.register(self.root)

    def event(self, kind, data):
        with self.store.transaction() as db:
            Store.event(db, self.app.tenant, self.identity, kind, data)

    def test_view_does_not_load_full_actions_reads_or_experience_for_each_turn(self):
        with patch.object(Store, 'result', side_effect=AssertionError('full execution read')):
            view = self.service.view(self.identity)
        self.assertEqual(view['turns'][0]['status'], self.root['status'])

    def test_private_audit_payload_is_not_decoded_for_a_public_view(self):
        self.event('private.audit', {'private_payload': 'PRIVATE_PROJECTION_SENTINEL' * 100})
        self.event('model.progress', {'kind': 'answer_text', 'text': '公开的当前片段'})
        original = json.loads
        def loads(value, *args, **kwargs):
            self.assertNotIn('PRIVATE_PROJECTION_SENTINEL', value)
            return original(value, *args, **kwargs)
        with patch('json.loads', loads):
            view = self.service.view(self.identity)
        self.assertEqual(view['turns'][0]['preview']['content'], '公开的当前片段')
        self.assertIn('PRIVATE_PROJECTION_SENTINEL', str(self.store.events(self.app.tenant, self.identity)))

    def test_native_read_payloads_stay_in_full_audit_without_being_decoded_for_labels(self):
        self.event('native.read_prepared',{'private':'PRIVATE_NATIVE_SENTINEL'*100})
        self.event('native.read_verified',{'private':'PRIVATE_NATIVE_SENTINEL'*100})
        self.event('execution.summary',{'text':'可展示的总结','private':'PRIVATE_NATIVE_SENTINEL'*100})
        before=self.store.events(self.app.tenant,self.identity);original=json.loads
        def loads(value,*args,**kwargs):
            self.assertNotIn('PRIVATE_NATIVE_SENTINEL',value)
            return original(value,*args,**kwargs)
        with patch('json.loads',loads):
            view=self.service.view(self.identity);exported=self.service.export(self.identity)
        self.assertEqual([p['text'] for p in view['turns'][0]['progress']],['正在读取资料。','资料读取完成。','可展示的总结'])
        self.assertEqual(exported['turns'],[{**turn,'resumable':False} for turn in view['turns']])
        self.assertEqual(self.store.events(self.app.tenant,self.identity),before)

    def test_streaming_summaries_keep_first_position_and_latest_content(self):
        for kind, data in [
            ('model.progress', {'kind':'summary_text','text':'摘要一','stream_id':'s'}),
            ('model.progress', {'kind':'tool','text':'工具步骤'}),
            ('model.progress', {'kind':'summary_text','text':'摘要二','stream_id':'s'}),
            ('model.progress', {'kind':'summary_text','text':'第二次尝试','stream_id':'s','attempt':2}),
            ('model.progress', {'kind':'summary_text','text':'另一条摘要','stream_id':'other'}),
        ]:self.event(kind,data)
        progress=self.service.view(self.identity)['turns'][0]['progress']
        self.assertEqual([p['text'] for p in progress],['摘要二','工具步骤','第二次尝试','另一条摘要'])
        self.assertGreater(progress[0]['id'],progress[1]['id'])
        self.assertTrue(progress[0]['streaming'])

    def test_rejected_answer_is_cleared_until_a_new_fragment_and_other_phases_do_not_clear_it(self):
        self.event('model.progress',{'kind':'answer_text','text':'旧片段'})
        self.event('model.output_rejected',{'phase':'execute'})
        self.assertIsNone(self.service.view(self.identity)['turns'][0]['preview'])
        self.event('model.progress',{'kind':'answer_text','text':'新片段','attempt':2})
        self.event('model.requested',{'phase':'plan'})
        self.assertEqual(self.service.view(self.identity)['turns'][0]['preview']['content'],'新片段')
        self.event('model.requested',{'phase':'execute'})
        self.assertIsNone(self.service.view(self.identity)['turns'][0]['preview'])

    def test_report_hides_old_fragments_but_private_events_still_advance_position(self):
        self.event('model.progress',{'kind':'answer_text','text':'过时片段'})
        self.event('private.audit',{'extra':'PRIVATE_ONLY'})
        with self.store.transaction() as db:
            state={**self.root,'status':'SUCCEEDED','report':{'content':'最终正文'}}
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,self.identity))
        view=self.service.view(self.identity)['turns'][0]
        self.assertIsNone(view['preview']);self.assertEqual(view['reply'],{'content':'最终正文'})
        self.assertEqual(view['event_seq'],self.store.events(self.app.tenant,self.identity)[-1]['seq'])
        exported=self.service.export(self.identity)
        self.assertEqual(exported['turns'][0]['reply'],view['reply']);self.assertNotIn('current',exported)

    def test_snapshot_does_not_mix_a_later_public_event_with_an_older_position(self):
        self.event('model.progress',{'kind':'answer_text','text':'读取之前'})
        original=self.service._turn_states
        def advance(*args):
            result=original(*args)
            self.event('model.progress',{'kind':'answer_text','text':'读取之后'})
            return result
        with patch.object(self.service,'_turn_states',side_effect=advance):
            turn=self.service.view(self.identity)['turns'][0]
        self.assertEqual(turn['preview']['content'],'读取之前')
        self.assertEqual(turn['preview']['seq'],turn['event_seq'])
        later=self.service.view(self.identity)['turns'][0]
        self.assertEqual(later['preview']['content'],'读取之后');self.assertGreater(later['event_seq'],turn['event_seq'])

    def test_missing_cancelled_and_queued_turns_keep_their_existing_semantics(self):
        with self.store.transaction() as db:
            for number,status in [(2,'CANCELLED'),(3,'QUEUED'),(4,'ERROR')]:
                db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',
                    (self.app.tenant,self.identity,number,'pending-'+str(number),'request-'+str(number),'后续要求',status,'无法开始' if status=='ERROR' else None,100+number))
        view=self.service.view(self.identity)
        self.assertEqual(view['queued_count'],1)
        self.assertEqual(view['active_run_id'],self.identity)
        self.assertTrue(view['turns'][1]['cancelled_queue'])
        self.assertEqual([t['checkpoint_version'] for t in view['turns'][1:]],[None,None,None])
        self.assertEqual([t['event_seq'] for t in view['turns'][1:]],[0,0,0])
        self.assertEqual(view['turns'][-1]['error'],'无法开始')

    def test_uncertain_action_blocks_reply_without_materializing_its_arguments(self):
        data={'status':'UNKNOWN','args':{'private':'PRIVATE_ACTION_SENTINEL'*100}}
        with self.store.transaction() as db:
            db.execute('INSERT INTO actions VALUES(?,?,?,?,?)',(self.app.tenant,self.identity,'action','UNKNOWN',canonical(data)))
        with patch.object(Store,'actions',side_effect=AssertionError('full action read')):
            view=self.service.view(self.identity)
        self.assertFalse(view['can_reply']);self.assertIn('确认',view['reply_blocked'])

    def test_turn_binding_rejects_foreign_principal_and_project_before_public_delivery(self):
        for key,value in [('principal','another-person'),('project_id','another-project')]:
            with self.subTest(key=key):
                state=deepcopy(self.root);state['run_id']='foreign-turn';state['task'][key]=value;state['report']={'content':'FOREIGN_REPLY'}
                with self.store.transaction() as db:
                    db.execute('INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?,?,?)',(self.app.tenant,'foreign-turn',1,canonical(state),None,0,0))
                    db.execute('INSERT OR REPLACE INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,self.identity,2,'foreign-turn','foreign-request','后续要求','RUNNING',None,100))
                with self.assertRaises(PolicyDenied):self.service.view(self.identity)
                with self.assertRaises(PolicyDenied):self.service.export(self.identity)

    def test_more_than_one_sql_batch_preserves_every_reply_and_position(self):
        with self.store.transaction() as db:
            for number in range(2,406):
                identity='batch-turn-'+str(number);state={**self.root,'run_id':identity,'status':'SUCCEEDED','report':{'content':str(number)}}
                db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?)',(self.app.tenant,identity,1,canonical(state),None,0,0))
                db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,self.identity,number,identity,'request-'+str(number),'合成要求','RUNNING',None,100+number))
                Store.event(db,self.app.tenant,identity,'execution.summary',{'text':'过程 '+str(number)})
        view=self.service.view(self.identity)
        self.assertEqual(len(view['turns']),405)
        for turn in view['turns'][1:]:
            self.assertEqual(turn['reply']['content'],str(turn['number']))
            self.assertEqual(turn['progress'][0]['text'],'过程 '+str(turn['number']))
            self.assertEqual(turn['event_seq'],1)

    def test_projection_works_without_new_indexes_on_read_only_history(self):
        self.event('model.progress',{'kind':'answer_text','text':'旧历史仍可读取'})
        expected=self.service.view(self.identity)
        with self.store.connect() as db:
            db.execute('DROP INDEX events_kind');db.execute('DROP INDEX events_progress_kind')
        readonly=Store(self.store.path,read_only=True)
        self.assertEqual(TaskConversations(self.app,readonly).view(self.identity),expected)

    def test_projected_progress_matches_full_audit_fold_over_interleaved_attempts(self):
        rng=random.Random(6207)
        with self.store.transaction() as db:
            for number in range(250):
                choice=rng.randrange(8)
                if choice<5:
                    data={'kind':['answer_text','summary_text','status','tool','summary_text'][choice],'text':'公开 '+str(number)}
                    if number%3:data['attempt']=rng.choice([None,1,2])
                    if number%4:data['stream_id']=rng.choice([None,'summary','other'])
                    kind='model.progress'
                else:
                    kind=['model.requested','model.output_rejected','private.audit'][choice-5]
                    data={'phase':rng.choice(['plan','execute']),'private':'PRIVATE_AUDIT'}
                Store.event(db,self.app.tenant,self.identity,kind,data)
        # Independent reference: sequentially replay the retained full audit.
        progress=[];summaries={};preview=None
        for event in self.store.events(self.app.tenant,self.identity):
            data=event['data']
            if event['kind'] in ('model.requested','model.output_rejected') and data.get('phase')=='execute':preview=None
            if event['kind']!='model.progress':continue
            kind=data['kind']
            if kind=='answer_text':preview={'content':data['text'],'attempt':data.get('attempt',1),'seq':event['seq']}
            elif kind=='summary_text':
                key=(data.get('attempt',1),data.get('stream_id','summary'));item={'id':event['seq'],'time':event['time'],'kind':'summary','text':data['text'],'streaming':True}
                if key in summaries:progress[summaries[key]]=item
                else:summaries[key]=len(progress);progress.append(item)
            elif kind in {'status','summary','message','tool'}:progress.append({'id':event['seq'],'time':event['time'],'kind':kind,'text':data['text']})
        actual=self.service.view(self.identity)['turns'][0]
        self.assertEqual(actual['progress'],progress);self.assertEqual(actual['preview'],preview)


if __name__ == '__main__':
    unittest.main()
