"""Task names organize records without rewriting execution inputs."""
import tempfile
import unittest
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from agent_framework.web import Application
from agent_framework.contracts import PolicyDenied
from agent_framework.contracts import canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.task_names import inspect
from tests.test_run_catalog import seed_history
from tests import test_web as fixtures


class TaskNameTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.roots=seed_history(self.app,count=3,turns=2,body_bytes=40)

    def test_rename_searches_both_name_and_original_goal_without_rewriting_runs(self):
        root=self.roots[0];before=self.app.detail(root)
        saved=self.app.rename_task(root,{'name':'  十一月发布评估  ','revision':0})
        self.assertEqual(saved['detail']['task_name']['name'],'十一月发布评估')
        after=self.app.detail(root);self.assertEqual(after['run'],before['run'])
        self.assertEqual(after['conversation']['goal'],before['conversation']['goal'])
        for old,new in zip(before['conversation']['turns'],after['conversation']['turns']):
            self.assertEqual(old['content'],new['content']);self.assertEqual(old['reply'],new['reply'])
            self.assertEqual(old['status'],new['status']);self.assertEqual(old['checkpoint_version'],new['checkpoint_version'])
        for search in ('十一月发布评估','历史目标-0000'):
            rows=self.app.runs({'search':search})['runs'];self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['title'],'十一月发布评估')
            self.assertEqual(rows[0]['goal'],'历史目标-0000')

    def test_stale_rename_cannot_replace_newer_name_or_reset(self):
        root=self.roots[0];first={'name':'发布检查','revision':0}
        self.app.rename_task(root,first);self.app.rename_task(root,first)
        self.assertEqual(self.app.detail(root)['task_name']['revision'],1)
        self.app.rename_task(root,{'name':'','revision':1})
        with self.assertRaises(ConfigConflict):self.app.rename_task(root,first)
        self.assertEqual(self.app.runs({'search':root})['runs'][0]['title'],'历史目标-0000')

    def test_archived_names_are_discoverable_without_restoring_task(self):
        root=self.roots[0];self.app.archive_task(root,{'archived':True,'revision':0})
        self.app.rename_task(root,{'name':'已交付的周报','revision':0})
        self.assertTrue(self.app.detail(root)['archive']['archived'])
        self.assertEqual(self.app.runs({'search':'已交付的周报'})['filtered_total'],0)
        self.assertEqual(self.app.runs({'search':'已交付的周报','visibility':'all'})['filtered_total'],1)

    def test_two_application_instances_accept_one_identical_name_change(self):
        other=Application(self.tmp.name);self.addCleanup(other.close);root=self.roots[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            packets=list(pool.map(lambda app:app.rename_task(root,{'name':'共同命名','revision':0}),(self.app,other)))
        self.assertEqual([p['receipt']['revision'] for p in packets],[1,1])
        self.assertEqual(len([e for e in self.app.detail(root)['events'] if e['kind']=='task.renamed']),1)
        self.assertNotIn('共同命名',json.dumps(self.app.detail(root)['events'],ensure_ascii=False))

    def test_rename_and_audit_roll_back_together(self):
        root=self.roots[0]
        with patch('agent_framework.store.Store.event',side_effect=OSError('audit unavailable')):
            with self.assertRaises(OSError):self.app.rename_task(root,{'name':'不应部分保存','revision':0})
        self.assertEqual(self.app.detail(root)['task_name']['revision'],0)

    def test_read_only_lookup_does_not_register_conversation_or_dispatch(self):
        root=self.roots[0];before=self.app.detail(root)
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('read dispatched')):
            self.assertEqual(inspect(self.app,root)['detail']['task_name']['name'],'')
        self.assertEqual(self.app.detail(root)['events'],before['events'])

    def test_scope_and_deleted_workspace_protect_names(self):
        root=self.roots[0];other=Application(self.tmp.name,principal='other');self.addCleanup(other.close)
        workspace=self.app.workspaces.save({'name':'其他','business':'测试','scenario':'名称','description':'','revision':0})
        for app in (other,self.app.scoped(workspace['id'])):
            with self.assertRaises((PolicyDenied,KeyError)):app.rename_task(root,{'name':'拒绝修改','revision':0})
            with self.assertRaises((PolicyDenied,KeyError)):inspect(app,root)
        with self.app.control_store.transaction() as db:db.execute('UPDATE workspaces SET deleted=1 WHERE tenant=? AND id=?',(self.app.tenant,self.app.workspace['id']))
        with self.assertRaises(KeyError):self.app.rename_task(root,{'name':'拒绝修改','revision':0})

    def test_names_validate_single_line_unicode_length_and_revision(self):
        root=self.roots[0]
        for payload in ({'name':'x'*121,'revision':0},{'name':'行\n名','revision':0},{'name':'x\x00','revision':0},{'name':'\ud800','revision':0},{'name':1,'revision':0},{'name':'x','revision':True},{'name':'x','revision':-1},{'name':'x','revision':2**53},{'name':'x','revision':0,'goal':'改写要求'}):
            with self.subTest(payload=repr(payload)),self.assertRaises(ValueError):self.app.rename_task(root,payload)
        self.assertEqual(self.app.rename_task(root,{'name':'😀'*120,'revision':0})['receipt']['name'],'😀'*120)

    def test_names_are_independent_of_active_turns_and_message_versions(self):
        root=self.roots[0];service=TaskConversations(self.app)
        self.app.rename_task(root,{'name':'持续处理事项','revision':0})
        with patch.object(TaskConversations,'dispatch',return_value=False):
            service.append(root,{'content':'新要求','request_id':'continued','revision':2})
            saved=self.app.rename_task(root,{'name':'更明确的事项','revision':1})
        self.assertEqual(saved['detail']['conversation']['revision'],3)
        self.assertEqual(saved['detail']['conversation']['turns'][-1]['content'],'新要求')
        self.assertEqual(saved['detail']['task_name']['revision'],2)

    def test_attention_uses_name_and_keeps_original_requirement(self):
        root=self.roots[0];child=root+'-turn-2';store=self.app.control_store;run=store.load(self.app.tenant,child);run['status']='FAILED'
        with store.transaction() as db:db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?',(canonical(run),self.app.tenant,child))
        self.app.rename_task(root,{'name':'需要检查的发布','revision':0})
        item=next(item for item in self.app.attention()['tasks'] if item['run_id']==root)
        self.assertEqual(item['title'],'需要检查的发布');self.assertEqual(item['goal'],'历史目标-0000');self.assertEqual(item['attention_kind'],'failed')

    def test_restart_backup_and_export_preserve_name_and_original_goal(self):
        from agent_framework.backups import create_backup,restore_backup
        from agent_framework.exports import conversation_markdown
        root=self.roots[0];self.app.rename_task(root,{'name':'每周总结','revision':0})
        before=self.app.detail(root);markdown=conversation_markdown(before['conversation'])
        self.assertTrue(markdown.startswith('# 每周总结\n'));self.assertIn('原始任务要求：历史目标-0000',markdown)
        self.assertIn('保留完整正文',markdown);self.app.close()
        backup=create_backup(self.tmp.name,Path(self.tmp.name)/'backup');target=Path(self.tmp.name)/'restored';restore_backup(backup['backup'],target)
        restored=Application(target);self.addCleanup(restored.close)
        self.assertEqual(restored.detail(root)['task_name'],before['task_name'])
        self.assertEqual(restored.runs({'search':'每周总结'})['filtered_total'],1)

    def test_readonly_historical_database_without_name_table_has_default_names(self):
        from agent_framework.store import Store
        from agent_framework.task_names import read
        from agent_framework.run_catalog import accessible_roots
        with self.app.control_store.transaction() as db:db.execute('DROP TABLE task_names')
        self.app.close();store=Store(Path(self.tmp.name)/'runtime.sqlite3',read_only=True)
        with store.read_snapshot() as db:self.assertEqual(read(self.app,store,self.roots[0],db),{'name':'','revision':0,'updated_at':None})
        for compact in (True,False):self.assertTrue(all(s['task_name']['name']=='' for s in accessible_roots(self.app,store,compact=compact)))


class TaskNameHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_http_name_lookup_export_and_asset(self):
        root=seed_history(self.app,count=1,turns=1,body_bytes=10)[0];url='/api/tasks/'+root+'/name'
        self.assertEqual(json.loads(self.request(url)[2])['detail']['task_name']['revision'],0)
        status,_,body=self.request(url,'POST',json.dumps({'name':'HTTP 名称','revision':0}))
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['receipt']['name'],'HTTP 名称')
        self.assertEqual(self.request(url,'POST',json.dumps({'name':'过期改名','revision':0}))[0],409)
        exported=json.loads(self.request('/api/tasks/'+root+'/export?kind=json')[2])
        self.assertEqual(exported['task_name']['name'],'HTTP 名称');self.assertEqual(exported['goal'],'历史目标-0000')
        self.assertEqual(self.request('/task_names.js')[0],200)
