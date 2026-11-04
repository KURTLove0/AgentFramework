"""Private favorites organize tasks without changing their execution."""
import unittest
import tempfile
import json
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from agent_framework.web import Application
from agent_framework.contracts import PolicyDenied
from agent_framework.runtime_config import ConfigConflict
from tests.test_run_catalog import seed_history
from tests import test_web as fixtures


class TaskFavoriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.roots=seed_history(self.app,count=4,turns=2,body_bytes=40)

    def test_favorite_is_persistent_without_rewriting_execution(self):
        root=self.roots[0];before=self.app.detail(root)
        saved=self.app.favorite_task(root,{'favorited':True,'revision':0})
        self.assertTrue(saved['receipt']['favorited'])
        self.assertEqual(saved['detail']['run'],before['run'])
        self.assertEqual(saved['detail']['conversation']['revision'],before['conversation']['revision'])
        for old,new in zip(before['conversation']['turns'],saved['detail']['conversation']['turns']):
            self.assertEqual({k:v for k,v in old.items() if k!='event_seq'},{k:v for k,v in new.items() if k!='event_seq'})
        other=Application(self.tmp.name);self.addCleanup(other.close)
        self.assertEqual(other.detail(root)['favorite'],saved['receipt'])

    def test_filter_uses_favorites_before_pagination_and_combines_with_archive(self):
        for root in self.roots[:3]:self.app.favorite_task(root,{'favorited':True,'revision':0})
        first=self.app.runs({'favorites':'only','limit':1,'sort':'created_asc'})
        second=self.app.runs({'favorites':'only','limit':1,'sort':'created_asc','cursor':first['next_cursor']})
        self.assertEqual(first['filtered_total'],3)
        self.assertEqual([first['runs'][0]['run_id'],second['runs'][0]['run_id']],self.roots[:2])
        self.app.archive_task(self.roots[0],{'archived':True,'revision':0})
        self.assertEqual(self.app.runs({'favorites':'only'})['filtered_total'],2)
        self.assertEqual(self.app.runs({'favorites':'only','visibility':'all'})['filtered_total'],3)
        self.assertEqual(self.app.runs({'favorites':'only','visibility':'archived'})['runs'][0]['run_id'],self.roots[0])

    def test_empty_filter_and_invalid_options_are_explicit(self):
        self.assertEqual(self.app.runs({'favorites':'only'})['filtered_total'],0)
        for value in ('invalid','true',True):
            with self.subTest(value=value),self.assertRaises(ValueError):self.app.runs({'favorites':value})

    def test_stale_change_cannot_undo_newer_choice_but_same_retry_is_idempotent(self):
        root=self.roots[0];payload={'favorited':True,'revision':0}
        self.app.favorite_task(root,payload);self.app.favorite_task(root,payload)
        self.assertEqual(self.app.detail(root)['favorite']['revision'],1)
        self.app.favorite_task(root,{'favorited':False,'revision':1})
        with self.assertRaises(ConfigConflict):self.app.favorite_task(root,payload)
        self.assertFalse(self.app.detail(root)['favorite']['favorited'])

    def test_two_instances_accept_one_change_and_one_audit(self):
        other=Application(self.tmp.name);self.addCleanup(other.close);root=self.roots[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda app:app.favorite_task(root,{'favorited':True,'revision':0}),(self.app,other)))
        self.assertEqual([r['receipt']['revision'] for r in results],[1,1])
        self.assertEqual(len([e for e in self.app.detail(root)['events'] if e['kind']=='task.favorite_changed']),1)

    def test_scope_and_deleted_workspace_protect_preference(self):
        from agent_framework.task_favorites import inspect
        root=self.roots[0];other=Application(self.tmp.name,principal='other');self.addCleanup(other.close)
        workspace=self.app.workspaces.save({'name':'其他','business':'测试','scenario':'收藏','description':'','revision':0})
        for app in (other,self.app.scoped(workspace['id'])):
            with self.assertRaises((PolicyDenied,KeyError)):app.favorite_task(root,{'favorited':True,'revision':0})
            with self.assertRaises((PolicyDenied,KeyError)):inspect(app,root)
            self.assertEqual(app.runs({'favorites':'only'})['filtered_total'],0)
        with self.app.control_store.transaction() as db:db.execute('UPDATE workspaces SET deleted=1 WHERE tenant=? AND id=?',(self.app.tenant,self.app.workspace['id']))
        with self.assertRaises(KeyError):self.app.favorite_task(root,{'favorited':True,'revision':0})

    def test_child_identity_resolves_root_and_read_does_not_dispatch(self):
        from agent_framework.task_conversations import TaskConversations
        from agent_framework.task_favorites import inspect
        root=self.roots[0];child=root+'-turn-2'
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('preference dispatched')):
            result=self.app.favorite_task(child,{'favorited':True,'revision':0})
            self.assertEqual(result['task_id'],root)
            before=self.app.detail(root)['events']
            self.assertTrue(inspect(self.app,child)['detail']['favorite']['favorited'])
            self.assertEqual(before,self.app.detail(root)['events'])

    def test_audit_failure_rolls_back_metadata(self):
        root=self.roots[0]
        with patch('agent_framework.store.Store.event',side_effect=OSError('audit unavailable')):
            with self.assertRaises(OSError):self.app.favorite_task(root,{'favorited':True,'revision':0})
        self.assertEqual(self.app.detail(root)['favorite']['revision'],0)

    def test_filter_cursor_is_bound_to_favorite_condition(self):
        first=self.app.runs({'limit':1})
        with self.assertRaises(ValueError):self.app.runs({'favorites':'only','cursor':first['next_cursor']})
        self.app.favorite_task(self.roots[0],{'favorited':True,'revision':0})
        self.app.rename_task(self.roots[0],{'name':'常用评估','revision':0})
        self.assertEqual(self.app.runs({'favorites':'only','search':'常用评估','status':'SUCCEEDED'})['filtered_total'],1)
        self.assertEqual(self.app.runs({'favorites':'only','status':'FAILED'})['filtered_total'],0)

    def test_payload_validation(self):
        for payload in ({'favorited':1,'revision':0},{'favorited':True,'revision':True},{'favorited':True,'revision':-1},{'favorited':True,'revision':2**53},{'favorited':True,'revision':0,'goal':'different'}):
            with self.subTest(payload=payload),self.assertRaises(ValueError):self.app.favorite_task(self.roots[0],payload)

    def test_historical_readonly_store_without_favorites_uses_defaults(self):
        from agent_framework.store import Store
        from agent_framework.task_favorites import read
        from agent_framework.run_catalog import accessible_roots
        with self.app.control_store.transaction() as db:db.execute('DROP TABLE task_favorites')
        self.app.close();store=Store(Path(self.tmp.name)/'runtime.sqlite3',read_only=True)
        with store.read_snapshot() as db:self.assertFalse(read(self.app,store,self.roots[0],db)['favorited'])
        for compact in (True,False):self.assertTrue(all(not s['favorite']['favorited'] for s in accessible_roots(self.app,store,compact=compact)))

    def test_backup_restores_favorites_and_export_keeps_original_content(self):
        from agent_framework.backups import create_backup,restore_backup
        from agent_framework.task_conversations import TaskConversations
        root=self.roots[0];before=TaskConversations(self.app).export(root)
        self.app.favorite_task(root,{'favorited':True,'revision':0})
        after=TaskConversations(self.app).export(root)
        self.assertEqual(before['goal'],after['goal']);self.assertNotIn('favorite',after)
        bundle=Path(self.tmp.name)/'favorite.zip';target=Path(self.tmp.name)/'restored'
        create_backup(self.tmp.name,bundle);restore_backup(bundle,target)
        restored=Application(str(target));self.addCleanup(restored.close)
        self.assertEqual(restored.runs({'favorites':'only'})['runs'][0]['run_id'],root)


class TaskFavoriteHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_http_toggle_inspect_filter_conflict_and_asset(self):
        root=seed_history(self.app,count=1,turns=1,body_bytes=10)[0];url='/api/tasks/'+root+'/favorite'
        self.assertFalse(json.loads(self.request(url)[2])['detail']['favorite']['favorited'])
        status,_,body=self.request(url,'POST',json.dumps({'favorited':True,'revision':0}))
        self.assertEqual(status,200);self.assertTrue(json.loads(body)['receipt']['favorited'])
        self.assertEqual(json.loads(self.request('/api/runs?favorites=only')[2])['filtered_total'],1)
        self.assertEqual(self.request(url,'POST',json.dumps({'favorited':False,'revision':0}))[0],409)
        self.assertEqual(self.request('/task_favorites.js')[0],200)
