"""Scoped reverse provenance excludes conversation turns and pages every root."""
import base64
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework import task_relations
from agent_framework.contracts import PolicyDenied, canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests.test_run_catalog import seed_history
from tests import test_web as http_fixture


def link(app,child,parent):
    with app.control_store.transaction() as db:
        db.execute("UPDATE runs SET state=json_set(state,'$.task.source_run_id',?) WHERE tenant_id=? AND id=?",(parent,app.tenant,child))


class TaskRelationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.roots=seed_history(self.app,count=8,turns=3,body_bytes=80)
        self.root=self.roots[0]
        for child in self.roots[1:5]:link(self.app,child,self.root)

    def read(self,identity=None,**params):return task_relations.relations(self.app,identity or self.root,params)

    def test_bidirectional_direct_only_includes_turn_sources_and_excludes_followups(self):
        link(self.app,self.roots[2],self.root+'-turn-2')
        link(self.app,self.roots[5],self.roots[1])
        result=self.read();self.assertEqual(result['source'],{'state':'none'})
        self.assertEqual([x['id'] for x in result['items']],self.roots[4:0:-1]);self.assertEqual(result['total'],4)
        self.assertEqual(result['items'][2]['source_turn'],2)
        child=self.read(self.roots[2]+'-turn-3');self.assertEqual(child['task_id'],self.roots[2]);self.assertEqual(child['source']['task']['id'],self.root)
        self.assertEqual(child['source']['turn'],2);self.assertEqual(child['source']['source_run_id'],self.root+'-turn-2')
        self.assertEqual(self.read(self.root+'-turn-2')['items'],result['items'])

    def test_current_names_archive_and_latest_status_without_hydrating_payloads(self):
        child=self.roots[4];self.app.rename_task(child,{'name':'已归档的关联名称','revision':0});self.app.archive_task(child,{'archived':True,'revision':0})
        with self.app.control_store.transaction() as db:
            db.execute("UPDATE runs SET state=json_set(state,'$.status','WAITING_INPUT') WHERE id=?",(child+'-turn-3',))
        expected=TaskConversations(self.app).view(child)['status']
        with patch.object(Store,'load',side_effect=AssertionError('full state')),patch.object(self.app,'detail',side_effect=AssertionError('detail')),patch.object(self.app,'runs',side_effect=AssertionError('catalog')),patch.object(TaskConversations,'dispatch',side_effect=AssertionError('dispatch')):
            result=self.read()['items'][0]
        self.assertEqual(result['title'],'已归档的关联名称');self.assertTrue(result['archived']);self.assertEqual(result['status'],expected)
        self.assertEqual(result['goal'],'历史目标-0004');self.assertEqual(result['agent']['revision'],1)
        self.assertNotIn('report',result);self.assertNotIn('保留完整正文',canonical(result))

    def test_unmaterialized_queue_and_cancellation_are_current_conversation_status(self):
        child=self.roots[1]
        with self.app.control_store.transaction() as db:
            db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',(self.app.tenant,child,4,child+'-pending','pending','补充','QUEUED',None,1))
        result={x['id']:x for x in self.read()['items']};self.assertEqual(result[child]['status'],'QUEUED')
        child=self.roots[2]
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.status','RUNNING') WHERE id=?",(child+'-turn-3',))
        self.app.control_store.request_cancellation(self.app.tenant,child+'-turn-3',principal=self.app.principal)
        expected=TaskConversations(self.app).view(child)['status']
        self.assertEqual({x['id']:x for x in self.read()['items']}[child]['status'],expected)

    def test_scope_denies_foreign_entry_and_hides_foreign_source_metadata(self):
        other=Application(self.tmp.name,principal='another-person');self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):task_relations.relations(other,self.root)
        private=self.roots[7]
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.task.principal','another-person','$.task.goal','private sentinel') WHERE id=?",(private,))
        link(self.app,self.root,private);link(self.app,private,self.root)
        result=self.read();self.assertEqual(result['source'],{'state':'unavailable'});self.assertNotIn('private sentinel',canonical(result));self.assertNotIn(private,canonical(result));self.assertEqual(result['total'],4)
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.task.principal','another-person') WHERE id=?",(self.root+'-turn-2',))
        with self.assertRaises(PolicyDenied):self.read(self.root+'-turn-2')

    def test_workspace_and_tenant_cannot_reuse_relation_ids(self):
        space=self.app.workspaces.save({'name':'另一个空间','business':'测试','scenario':'测试','description':'','revision':0})
        with self.assertRaises(PolicyDenied):task_relations.relations(self.app.scoped(space['id']),self.root)
        other=Application(self.tmp.name,tenant='different-tenant');self.addCleanup(other.close)
        with self.assertRaises(KeyError):task_relations.relations(other,self.root)
        with self.app.control_store.transaction() as db:db.execute('UPDATE task_conversations SET workspace=? WHERE id=?',(space['id'],self.roots[4]))
        self.assertEqual(self.read()['total'],3)

    def test_missing_and_self_source_are_unavailable(self):
        for source in ['missing-task',self.root]:
            link(self.app,self.root,source);self.assertEqual(self.read()['source'],{'state':'unavailable'})
        with self.assertRaises(KeyError):self.read('missing-task')

    def test_legacy_unregistered_root_can_link_without_creating_conversation_rows(self):
        child=self.roots[4]
        with self.app.control_store.transaction() as db:
            db.execute('DELETE FROM task_conversation_turns WHERE task_id=?',(child,));db.execute('DELETE FROM task_conversations WHERE id=?',(child,))
            db.execute("UPDATE runs SET state=json_remove(state,'$.task.conversation_context') WHERE id=?",(child,))
        self.assertEqual(self.read()['items'][0]['id'],child);self.assertEqual(self.read(child)['source']['task']['id'],self.root)
        with self.app.control_store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM task_conversations WHERE id=?',(child,)).fetchone()[0],0)

    def test_legacy_unregistered_source_keeps_direct_children(self):
        with self.app.control_store.transaction() as db:
            db.execute('DELETE FROM task_conversation_turns WHERE task_id=?',(self.root,))
            db.execute('DELETE FROM task_conversations WHERE id=?',(self.root,))
            db.execute("UPDATE runs SET state=json_remove(state,'$.task.conversation_context') WHERE id=?",(self.root,))
        self.assertEqual([x['id'] for x in self.read()['items']],self.roots[4:0:-1])
        self.assertEqual(self.read(self.roots[1])['source']['task']['id'],self.root)

    def test_unrelated_history_does_not_expand_relation_candidate_work(self):
        store=Store(self.app.control_store.path,read_only=True);connect=store.connect
        def measure():
            instructions=[0];candidate_query=[False]
            def progress():
                if candidate_query[0]:instructions[0]+=100
                return 0
            def traced():
                db=connect()
                db.set_progress_handler(progress,100)
                db.set_trace_callback(lambda sql:candidate_query.__setitem__(0,'linked AS (' in sql))
                return db
            with patch.object(store,'connect',new=traced):
                result=task_relations.relations(self.app,self.root,store=store)
            self.assertEqual([x['id'] for x in result['items']],self.roots[4:0:-1])
            return instructions[0]
        small=measure()
        seed_history(self.app,count=400,turns=2,prefix='unrelated',body_bytes=80)
        large=measure()
        self.assertGreater(small,0)
        self.assertLessEqual(large,small*3,'unrelated task bodies must not be scanned for relation candidates')

    def test_existing_database_adds_source_index_without_changing_tasks_or_cursor(self):
        store=self.app.control_store
        with store.transaction() as db:
            db.execute('DROP INDEX IF EXISTS runs_source')
            # A malformed record in another tenant must not block this tenant's
            # startup; preserve it for its own diagnostic/repair path.
            db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,0,?)',('foreign-tenant','broken-history','{invalid json'))
            before=[tuple(row) for row in db.execute('SELECT * FROM runs ORDER BY tenant_id,id')]
        first=self.read(limit=2)
        migrated=Store(store.path)
        with migrated.connect() as db:
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='runs_source'").fetchone())
            self.assertEqual([tuple(row) for row in db.execute('SELECT * FROM runs ORDER BY tenant_id,id')],before)
        second=task_relations.relations(self.app,self.root,{'limit':2,'cursor':first['next_cursor']},store=migrated)
        self.assertEqual(second['snapshot'],first['snapshot']);self.assertEqual(second['total'],4)
        self.assertEqual([x['id'] for x in second['items']],self.roots[2:0:-1])

    def test_all_pages_exceed_two_hundred_with_equal_timestamps(self):
        roots=seed_history(self.app,count=207,turns=1,prefix='many',body_bytes=1)
        with self.app.control_store.transaction() as db:
            for child in roots:db.execute("UPDATE runs SET state=json_set(state,'$.task.source_run_id',?,'$.created_at',42) WHERE id=?",(self.root,child))
        ids=[];params={'limit':50};snapshot=None
        while True:
            page=self.read(**params);snapshot=snapshot or page['snapshot'];self.assertEqual(page['snapshot'],snapshot);self.assertEqual(page['total'],211)
            ids.extend(x['id'] for x in page['items'])
            if not page['next_cursor']:break
            params['cursor']=page['next_cursor']
        self.assertEqual(ids,roots[::-1]+self.roots[4:0:-1]);self.assertEqual(len(ids),len(set(ids)))

    def test_backdated_new_insertion_does_not_shift_existing_page_range(self):
        first=self.read(limit=2);new=seed_history(self.app,count=1,turns=1,prefix='new',body_bytes=1)[0];link(self.app,new,self.root)
        with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.created_at',1) WHERE id=?",(new,))
        second=self.read(limit=2,cursor=first['next_cursor'])
        self.assertEqual(second['snapshot'],first['snapshot']);self.assertEqual(second['total'],4);self.assertEqual(second['new_count'],1)
        self.assertEqual([x['id'] for x in second['items']],self.roots[2:0:-1]);self.assertIsNone(second['next_cursor'])
        self.assertEqual(self.read()['items'][0]['id'],new);self.assertEqual(self.read()['total'],5)

    def test_cursor_rejects_wrong_root_malformed_positions_and_removed_anchor(self):
        first=self.read(limit=2);cursor=first['next_cursor'];decoded=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        with self.assertRaises(ValueError):self.read(self.roots[1],cursor=cursor)
        for field,value in [('v',True),('before',True),('through',10**9),('anchor','other-id'),('scope','other')]:
            invalid=decoded|{field:value};encoded=base64.urlsafe_b64encode(canonical(invalid).encode()).decode()
            with self.subTest(field=field),self.assertRaises(ValueError):self.read(cursor=encoded)
        for cursor in ['not a cursor','x'*2049,True]:
            with self.assertRaises(ValueError):self.read(cursor=cursor)
        link(self.app,decoded['anchor'],None)
        with self.assertRaises(ValueError):self.read(cursor=first['next_cursor'])

    def test_page_limit_validation(self):
        for value in [0,51,True,1.5,'1.5',{},[],None]:
            if value==[]:continue # HTTP empty list means omitted.
            with self.subTest(value=value),self.assertRaises(ValueError):self.read(limit=value)
        self.assertEqual(len(self.read(limit='1')['items']),1)

    def test_one_read_snapshot_keeps_counts_and_status_consistent_during_writer(self):
        original=task_relations._summaries;child=self.roots[4]
        def concurrent(*args):
            link(self.app,self.roots[6],self.root)
            with self.app.control_store.transaction() as db:db.execute("UPDATE runs SET state=json_set(state,'$.status','WAITING_INPUT') WHERE id=?",(child+'-turn-3',))
            return original(*args)
        with patch.object(task_relations,'_summaries',side_effect=concurrent):result=self.read()
        self.assertEqual(result['total'],4);self.assertEqual(result['items'][0]['status'],'SUCCEEDED')
        fresh=self.read();self.assertEqual(fresh['total'],5);self.assertEqual({x['id']:x for x in fresh['items']}[child]['status'],'WAITING_INPUT')

    def test_read_only_optional_metadata_does_not_migrate_or_write(self):
        store=self.app.control_store
        with store.transaction() as db:
            for name in ['task_names','task_archives']:db.execute('DROP TABLE '+name)
            db.execute('DROP INDEX IF EXISTS runs_source')
            schema=[tuple(row) for row in db.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')]
        readonly=Store(store.path,read_only=True)
        result=task_relations.relations(self.app,self.root,store=readonly);self.assertEqual(result['total'],4)
        with readonly.connect() as db:
            self.assertEqual([tuple(row) for row in db.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')],schema)


class TaskRelationsHTTPTests(unittest.TestCase):
    setUp=http_fixture.HTTPTests.setUp
    tearDown=http_fixture.HTTPTests.tearDown
    request=http_fixture.HTTPTests.request

    def test_scoped_read_route_child_alias_and_invalid_cursor(self):
        roots=seed_history(self.app,count=2,turns=2);link(self.app,roots[1],roots[0])
        status,_,body=self.request('/api/tasks/'+roots[0]+'-turn-2/relations');self.assertEqual(status,200)
        result=json.loads(body);self.assertEqual(result['task_id'],roots[0]);self.assertEqual(result['items'][0]['id'],roots[1])
        self.assertEqual(self.request('/api/tasks/'+roots[0]+'/relations?cursor=bad')[0],400)
        self.assertEqual(self.request('/api/tasks/missing-task/relations')[0],404)

    def test_static_module_available_in_local_package(self):
        status,headers,body=self.request('/task_relations.js');self.assertEqual(status,200);self.assertIn('text/javascript',headers['Content-Type']);self.assertIn('openTaskRelations',body.decode())
        self.assertIn('/task_relations.js',self.request('/')[2].decode())


if __name__=='__main__':unittest.main()
