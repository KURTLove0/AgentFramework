"""Queued edits race safely with execution and preserve accepted submissions."""
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from agent_framework.contracts import PolicyDenied,canonical
from agent_framework.definitions import default_definition
from agent_framework.runtime import Runtime
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.task_message_edits import update,inspect
from agent_framework.web import Application
from tests import test_web as fixtures


class MessageEditTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        agent=self.app.agents.save({'name':'修改验收','description':'排队修正','runtime':'mock','model':'builtin','options':{},'prompt':'按目标交付。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('修改验收','general-assistant@1.0.0')})
        self.root=self.app.start_task({'goal':'原始目标','agent_id':agent['id'],'agent_revision':1,'request_id':'first'},start=False)['run']['run_id']
        self.app.runtime().run(self.root);self.service=TaskConversations(self.app)
        self.dispatch=patch.object(TaskConversations,'dispatch',return_value=False);self.dispatch.start();self.addCleanup(self.dispatch.stop)
        self.original={'content':'周五 15 点','request_id':'original','revision':1}
        self.service.append(self.root,self.original)
        self.payload={'content':'周六 16 点','request_id':'edit-first','revision':0}

    def test_edit_keeps_position_identity_and_original_receipt(self):
        before=self.app.detail(self.root);old=before['conversation']['turns'][1]
        result=update(self.app,self.root,2,self.payload);turn=result['detail']['conversation']['turns'][1]
        self.assertEqual(turn['content'],'周六 16 点');self.assertEqual(turn['edit_revision'],1)
        self.assertEqual(turn['run_id'],old['run_id']);self.assertEqual(turn['created_at'],old['created_at'])
        self.assertEqual(result['detail']['run'],before['run']);self.assertEqual(result['detail']['conversation']['revision'],3)
        self.assertEqual(self.service.message_submission(self.root,'original')['submission']['content'],'周五 15 点')
        replay=self.service.append(self.root,self.original)
        self.assertEqual(len(replay['conversation']['turns']),2);self.assertEqual(replay['conversation']['turns'][1]['content'],'周六 16 点')
        with self.assertRaises(ConfigConflict):self.service.append(self.root,{**self.original,'content':'周六 16 点'})

    def test_receipt_is_durable_and_idempotent_after_materialization(self):
        update(self.app,self.root,2,self.payload);self.dispatch.stop()
        with patch.object(self.app,'schedule'):self.service.dispatch(self.root)
        turn=self.service.rows(self.service.root(self.root))[1]
        self.assertEqual(self.app.control_store.load(self.app.tenant,turn['run_id'])['task']['goal'],'周六 16 点')
        other=Application(self.tmp.name);self.addCleanup(other.close)
        with patch.object(TaskConversations,'dispatch',return_value=False):
            replay=update(other,self.root,2,self.payload)
        self.assertEqual(replay['receipt']['revision'],1)
        self.assertEqual(inspect(other,self.root,2,'edit-first')['receipt'],replay['receipt'])
        self.assertEqual(sum(e['kind']=='conversation.message_edited' for e in self.app.detail(self.root)['events']),1)

    def test_stale_and_reused_identifiers_cannot_replace_a_newer_edit(self):
        update(self.app,self.root,2,self.payload)
        update(self.app,self.root,2,{'content':'周日 17 点','revision':1,'request_id':'edit-second'})
        old=update(self.app,self.root,2,self.payload)
        self.assertEqual(old['receipt']['content'],'周六 16 点');self.assertEqual(old['detail']['conversation']['turns'][1]['content'],'周日 17 点')
        for data in ({**self.payload,'request_id':'stale'},{**self.payload,'content':'替换已接受内容'}):
            with self.assertRaises(ConfigConflict):update(self.app,self.root,2,data)

    def test_simultaneous_different_edits_accept_only_one(self):
        other=Application(self.tmp.name);self.addCleanup(other.close)
        def save(pair):
            app,text=pair
            try:return update(app,self.root,2,{'content':text,'revision':0,'request_id':text})
            except ConfigConflict:return None
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(save,[(self.app,'first-edit'),(other,'second-edit')]))
        self.assertEqual(sum(r is not None for r in results),1)
        self.assertEqual(self.app.detail(self.root)['conversation']['turns'][1]['edit_revision'],1)

    def test_edit_wins_before_stale_dispatch_acceptance(self):
        self.dispatch.stop();submit=Runtime.submit
        other=Application(self.tmp.name);self.addCleanup(other.close)
        def edit_before_submit(runtime,*args,**kwargs):
            with patch.object(TaskConversations,'dispatch',return_value=False):update(other,self.root,2,self.payload)
            return submit(runtime,*args,**kwargs)
        with patch.object(Runtime,'submit',edit_before_submit),patch.object(self.app,'schedule') as schedule:self.service.dispatch(self.root)
        schedule.assert_not_called();turn=self.service.rows(self.service.root(self.root))[1]
        with self.assertRaises(KeyError):self.app.control_store.load(self.app.tenant,turn['run_id'])
        with patch.object(self.app,'schedule'):self.service.dispatch(self.root)
        self.assertEqual(self.app.control_store.load(self.app.tenant,turn['run_id'])['task']['goal'],'周六 16 点')

    def test_materialized_or_cancelled_message_rejects_edit(self):
        self.dispatch.stop()
        with patch.object(self.app,'schedule'):self.service.dispatch(self.root)
        with self.assertRaises(ConfigConflict):update(self.app,self.root,2,self.payload)
        with patch.object(TaskConversations,'dispatch',return_value=False):
            self.service.append(self.root,{'content':'排队消息','request_id':'third','revision':2})
            self.service.cancel_queued(self.root,3,{'revision':3})
            with self.assertRaises(ConfigConflict):update(self.app,self.root,3,self.payload)

    def test_late_preparation_error_cannot_discard_new_edit(self):
        self.dispatch.stop();other=Application(self.tmp.name);self.addCleanup(other.close)
        def edit_then_fail(*args,**kwargs):
            with patch.object(TaskConversations,'dispatch',return_value=False):update(other,self.root,2,self.payload)
            raise ValueError('old preparation failed')
        with patch.object(Runtime,'submit',side_effect=edit_then_fail):self.service.dispatch(self.root)
        turn=self.app.detail(self.root)['conversation']['turns'][1]
        self.assertEqual(turn['status'],'QUEUED');self.assertEqual(turn['content'],'周六 16 点')

    def test_atomic_failure_preserves_old_text_receipt_and_version(self):
        with patch('agent_framework.store.Store.event',side_effect=OSError('audit failed')):
            with self.assertRaises(OSError):update(self.app,self.root,2,self.payload)
        result=inspect(self.app,self.root,2,'edit-first')
        self.assertIsNone(result['receipt']);self.assertEqual(result['detail']['conversation']['revision'],2)
        self.assertEqual(result['detail']['conversation']['turns'][1]['content'],'周五 15 点')

    def test_scope_and_payload_validation(self):
        other=Application(self.tmp.name,principal='other');self.addCleanup(other.close)
        for call in (lambda:update(other,self.root,2,self.payload),lambda:inspect(other,self.root,2)):
            with self.assertRaises((KeyError,PolicyDenied)):call()
        for data in ({**self.payload,'content':''},{**self.payload,'content':'x'*16001},{**self.payload,'revision':True},{**self.payload,'revision':-1},{**self.payload,'request_id':'../bad'}):
            with self.subTest(data=repr(data)[:80]),self.assertRaises(ValueError):update(self.app,self.root,2,data)
        with self.assertRaises(ValueError):update(self.app,self.root,1,self.payload)
        self.assertEqual(update(self.app,self.root,2,{**self.payload,'content':'😀'*16000})['receipt']['content'],'😀'*16000)

    def test_unrelated_new_message_does_not_conflict_with_edit_revision(self):
        self.service.append(self.root,{'content':'后一个要求','request_id':'next','revision':2})
        detail=update(self.app,self.root,2,self.payload)['detail']
        self.assertEqual([t['content'] for t in detail['conversation']['turns']],['原始目标','周六 16 点','后一个要求'])
        self.assertEqual(detail['conversation']['revision'],4)

    def test_lookup_is_readonly_and_original_receipt_survives_multiple_edits(self):
        update(self.app,self.root,2,self.payload);update(self.app,self.root,2,{'content':'最终要求','revision':1,'request_id':'second'})
        before=self.app.detail(self.root)['events']
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('read dispatched')):
            self.assertIsNone(inspect(self.app,self.root,2,'not-found')['receipt'])
            self.assertEqual(self.service.message_submission(self.root,'original')['submission']['content'],'周五 15 点')
        self.assertEqual(self.app.detail(self.root)['events'],before)

    def test_editing_a_queued_retry_preserves_the_original_retry_receipt(self):
        root=self.app.control_store.load(self.app.tenant,self.root);root['status']='FAILED'
        with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(root),self.app.tenant,self.root))
        self.service.retry(self.root,1,{'revision':2})
        update(self.app,self.root,3,{**self.payload,'content':'修订后再试'})
        replay=self.service.retry(self.root,1,{'revision':2})
        self.assertEqual(len(replay['conversation']['turns']),3)
        self.assertEqual(replay['conversation']['turns'][2]['content'],'修订后再试')
        self.assertEqual(replay['conversation']['turns'][2]['retry_of'],1)
        self.assertEqual(self.service.retry_submission(self.root,1)['submission']['content'],'原始目标')

    def test_edit_during_cleanup_hold_does_not_release_or_dispatch_queue(self):
        root=self.app.control_store.load(self.app.tenant,self.root);root.update(status='FAILED',cleanup_failure={'kind':'PermissionError','pid':123,'pipes_closed':True},cleanup_model_error='model_timeout')
        with self.app.control_store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(root),self.app.tenant,self.root))
        self.dispatch.stop()
        with patch.object(self.app,'schedule') as schedule:result=update(self.app,self.root,2,self.payload)
        schedule.assert_not_called();self.assertEqual(result['detail']['conversation']['turns'][1]['status'],'QUEUED')
        self.assertTrue(result['detail']['conversation']['cleanup_review'])

    def test_historical_database_without_edit_table_keeps_original_message(self):
        from pathlib import Path
        from agent_framework.store import Store
        from agent_framework.task_message_edits import metadata,original_content
        row=self.service.rows(self.service.root(self.root))[1]
        with self.app.control_store.transaction() as db:db.execute('DROP TABLE task_message_edits')
        self.app.close();store=Store(Path(self.tmp.name)/'runtime.sqlite3',read_only=True)
        with store.read_snapshot() as db:
            self.assertEqual(metadata(store,db,self.app.tenant,self.root),{})
            self.assertEqual(original_content(store,db,row),'周五 15 点')

    def test_backup_restores_edits_and_both_receipt_types(self):
        from pathlib import Path
        from agent_framework.backups import create_backup,restore_backup
        update(self.app,self.root,2,self.payload);self.app.close()
        archive=create_backup(self.tmp.name,Path(self.tmp.name)/'backup');target=Path(self.tmp.name)/'restored';restore_backup(archive['backup'],target)
        restored=Application(target);self.addCleanup(restored.close)
        self.assertEqual(inspect(restored,self.root,2,'edit-first')['receipt']['content'],'周六 16 点')
        self.assertEqual(TaskConversations(restored).message_submission(self.root,'original')['submission']['content'],'周五 15 点')


class MessageEditHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_edit_route_and_readonly_receipt(self):
        from tests.test_run_catalog import seed_history
        root=seed_history(self.app,count=1,turns=1,body_bytes=10)[0]
        with patch.object(TaskConversations,'dispatch',return_value=False):
            TaskConversations(self.app).append(root,{'content':'旧消息','request_id':'message','revision':1})
            url='/api/tasks/'+root+'/messages/2/edit';payload={'content':'新消息','request_id':'edited','revision':0}
            status,_,body=self.request(url,'POST',json.dumps(payload))
            self.assertEqual(status,200);self.assertEqual(json.loads(body)['receipt']['revision'],1)
        result=json.loads(self.request(url+'?request_id=edited')[2]);self.assertEqual(result['receipt']['content'],'新消息')
        self.assertEqual(self.request(url,'POST',json.dumps({**payload,'request_id':'stale'}))[0],409)
        self.assertEqual(self.request('/task_message_edit.js')[0],200)
