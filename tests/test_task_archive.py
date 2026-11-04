"""Archiving organizes history without removing execution records."""
import tempfile
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from agent_framework.contracts import canonical, PolicyDenied
from tests.test_run_catalog import seed_history
from tests import test_web as fixtures


class TaskArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.roots = seed_history(self.app, count=3, turns=2, body_bytes=40)

    def test_archive_hides_default_list_but_keeps_detail_and_all_history(self):
        root = self.roots[0]
        before = self.app.detail(root)
        self.app.archive_task(root, {'archived': True, 'revision': 0})
        self.assertNotIn(root, [r['run_id'] for r in self.app.runs()['runs']])
        self.assertEqual([r['run_id'] for r in self.app.runs({'visibility': 'archived'})['runs']], [root])
        self.assertEqual(self.app.runs({'visibility': 'all'})['filtered_total'], 3)
        after = self.app.detail(root)
        self.assertEqual(after['run'], before['run'])
        self.assertTrue(after['archive']['archived'])
        self.assertEqual(len(after['conversation']['turns']), 2)

    def test_duplicate_archive_is_safe_and_old_action_cannot_undo_a_restore(self):
        root = self.roots[0]
        self.app.archive_task(root, {'archived': True, 'revision': 0})
        self.app.archive_task(root, {'archived': True, 'revision': 0})
        self.assertEqual(self.app.detail(root)['archive']['revision'], 1)
        self.app.archive_task(root, {'archived': False, 'revision': 1})
        with self.assertRaises(ConfigConflict):
            self.app.archive_task(root, {'archived': True, 'revision': 0})
        self.assertFalse(self.app.detail(root)['archive']['archived'])

    def test_new_message_restores_in_same_transaction_but_old_receipt_does_not(self):
        root = self.roots[0]
        self.app.archive_task(root, {'archived': True, 'revision': 0})
        service = TaskConversations(self.app)
        with patch.object(TaskConversations, 'dispatch', return_value=False):
            payload = {'content': '继续处理', 'request_id': 'new-message', 'revision': 2}
            detail = service.append(root, payload)
        self.assertFalse(detail['archive']['archived'])
        self.assertEqual(detail['archive']['revision'], 2)
        self.assertIn(root, [r['run_id'] for r in self.app.runs()['runs']])
        with patch.object(TaskConversations, 'dispatch', return_value=False):
            service.cancel_queued(root, 3, {'revision': 3})
            self.app.archive_task(root, {'archived': True, 'revision': 2})
            replay = service.append(root, payload)
        self.assertTrue(replay['archive']['archived'])

    def set_status(self, identity, status):
        store=self.app.control_store;state=store.load(self.app.tenant,identity);state['status']=status
        with store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(state),self.app.tenant,identity))

    def test_unfinished_and_queued_tasks_cannot_be_hidden(self):
        root=self.roots[0];child=root+'-turn-2'
        for status in ('CREATED','RUNNING','VERIFYING','WAITING_AUTH','WAITING_INPUT','NEEDS_REVIEW'):
            self.set_status(child,status)
            with self.subTest(status=status),self.assertRaises(ConfigConflict):self.app.archive_task(root,{'archived':True,'revision':0})
        self.set_status(child,'SUCCEEDED')
        with patch.object(TaskConversations,'dispatch',return_value=False):
            TaskConversations(self.app).append(root,{'content':'排队内容','request_id':'queued','revision':2})
        with self.assertRaises(ConfigConflict):self.app.archive_task(root,{'archived':True,'revision':0})
        self.assertFalse(self.app.detail(root)['archive']['archived'])

    def test_pending_stop_and_unresolved_write_prevent_archive(self):
        root=self.roots[0];child=root+'-turn-2';self.set_status(child,'RUNNING')
        self.app.control_store.request_cancellation(self.app.tenant,child)
        self.set_status(child,'FAILED')
        with self.assertRaises(ConfigConflict):self.app.archive_task(root,{'archived':True,'revision':0})
        run=self.app.create({'runtime':'mock','scenario':'unverifiable','consent':True,'grant':True,'start':False})['run']
        self.app.runtime().run(run['run_id']);self.set_status(run['run_id'],'FAILED')
        with self.assertRaisesRegex(ConfigConflict,'待核对'):self.app.archive_task(run['run_id'],{'archived':True,'revision':0})

    def test_archived_failures_leave_attention_without_changing_status(self):
        root=self.roots[0];self.set_status(root+'-turn-2','FAILED')
        self.assertIn(root,[item['run_id'] for item in self.app.attention()['tasks']])
        self.app.archive_task(root,{'archived':True,'revision':0})
        self.assertNotIn(root,[item['run_id'] for item in self.app.attention()['tasks']])
        item=self.app.runs({'visibility':'archived'})['runs'][0]
        self.assertEqual(item['status'],'FAILED')
        self.assertEqual(self.app.runs()['counts']['total'],3)

    def test_concurrent_archive_is_idempotent_and_restore_keeps_audit(self):
        other=Application(self.tmp.name);self.addCleanup(other.close);root=self.roots[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda app:app.archive_task(root,{'archived':True,'revision':0}),[self.app,other]))
        self.assertEqual([r['receipt']['revision'] for r in results],[1,1])
        events=self.app.detail(root)['events'];self.assertEqual(sum(e['kind']=='task.archived' for e in events),1)
        self.app.archive_task(root,{'archived':False,'revision':1})
        self.assertEqual(sum(e['kind']=='task.restored' for e in self.app.detail(root)['events']),1)

    def test_restore_and_message_acceptance_roll_back_together(self):
        from agent_framework import task_archive
        root=self.roots[0];self.app.archive_task(root,{'archived':True,'revision':0});before=self.app.detail(root)
        original=task_archive.restore_for_message
        def fail(*args):original(*args);raise RuntimeError('before commit')
        with patch.object(task_archive,'restore_for_message',side_effect=fail),self.assertRaises(RuntimeError):
            TaskConversations(self.app).append(root,{'content':'不能部分接受','request_id':'rollback','revision':2})
        after=self.app.detail(root)
        self.assertEqual(after['archive'],before['archive']);self.assertEqual(after['events'],before['events'])
        self.assertEqual(len(after['conversation']['turns']),2)

    def test_scope_and_deleted_workspace_protect_archive_and_inspection(self):
        from agent_framework.task_archive import inspect
        root=self.roots[0];other=Application(self.tmp.name,principal='other');self.addCleanup(other.close)
        workspace=self.app.workspaces.save({'name':'隔离空间','business':'测试','scenario':'归档','description':'','revision':0})
        for app in (other,self.app.scoped(workspace['id'])):
            with self.assertRaises((PolicyDenied,KeyError)):app.archive_task(root,{'archived':True,'revision':0})
            with self.assertRaises((PolicyDenied,KeyError)):inspect(app,root)
        with self.app.control_store.transaction() as db:db.execute('UPDATE workspaces SET deleted=1 WHERE tenant=? AND id=?',(self.app.tenant,self.app.workspace['id']))
        with self.assertRaises(KeyError):self.app.archive_task(root,{'archived':True,'revision':0})

    def test_visibility_is_validated_and_cursors_are_bound_to_it(self):
        self.app.archive_task(self.roots[0],{'archived':True,'revision':0})
        cursor=self.app.runs({'visibility':'all','limit':1})['next_cursor']
        with self.assertRaisesRegex(ValueError,'游标'):self.app.runs({'visibility':'active','cursor':cursor})
        with self.assertRaisesRegex(ValueError,'归档范围'):self.app.runs({'visibility':'invalid'})
        for payload in ({'archived':1,'revision':0},{'archived':True,'revision':True},{'archived':True,'revision':-1}):
            with self.assertRaises(ValueError):self.app.archive_task(self.roots[0],payload)

    def test_a_new_message_fences_an_older_archive_even_if_the_task_was_visible(self):
        root=self.roots[0];service=TaskConversations(self.app)
        with patch.object(TaskConversations,'dispatch',return_value=False):
            service.append(root,{'content':'较新的处理要求','request_id':'new-intent','revision':2})
            service.cancel_queued(root,3,{'revision':3})
        detail=self.app.detail(root)
        self.assertFalse(detail['archive']['archived']);self.assertEqual(detail['archive']['revision'],1)
        self.assertFalse(any(e['kind']=='task.restored' for e in detail['events']))
        with self.assertRaisesRegex(ConfigConflict,'归档状态已变化'):self.app.archive_task(root,{'archived':True,'revision':0})

    def test_restart_backup_restore_and_readonly_lookup_keep_archive(self):
        from agent_framework.backups import create_backup,restore_backup
        from agent_framework.task_archive import inspect
        root=self.roots[0];self.app.archive_task(root,{'archived':True,'revision':0});before=self.app.detail(root)
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('read dispatched')):
            self.assertTrue(inspect(self.app,root)['detail']['archive']['archived'])
        self.assertEqual(self.app.detail(root)['events'],before['events']);self.app.close()
        backup=create_backup(self.tmp.name,Path(self.tmp.name)/'backup');target=Path(self.tmp.name)/'restored';restore_backup(backup['backup'],target)
        restored=Application(target);self.addCleanup(restored.close)
        self.assertEqual(restored.detail(root)['archive'],before['archive']);self.assertEqual(restored.runs()['filtered_total'],2)


class TaskArchiveHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_http_archive_lookup_and_static_asset(self):
        root=seed_history(self.app,count=1,turns=1,body_bytes=10)[0];url='/api/tasks/'+root+'/archive'
        self.assertFalse(json.loads(self.request(url)[2])['detail']['archive']['archived'])
        status,_,body=self.request(url,'POST',json.dumps({'archived':True,'revision':0}))
        self.assertEqual(status,200);self.assertTrue(json.loads(body)['receipt']['archived'])
        self.assertEqual(json.loads(self.request('/api/runs?visibility=archived')[2])['filtered_total'],1)
        self.assertEqual(self.request('/task_archive.js')[0],200)
