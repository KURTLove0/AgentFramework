"""Edit history exposes immutable changes without advancing task execution."""
import base64
from contextlib import contextmanager
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from agent_framework.contracts import PolicyDenied
from agent_framework.task_conversations import TaskConversations
from agent_framework.task_message_edits import update
from agent_framework.task_message_history import history
from agent_framework.web import Application
from tests import test_task_message_edits as edit_fixtures
from tests import test_web as web_fixtures


class MessageHistoryTests(unittest.TestCase):
    setUp=edit_fixtures.MessageEditTests.setUp

    def seed(self,count):
        for n in range(count):update(self.app,self.root,2,{'content':'修改 '+str(n+1),'revision':n,'request_id':'edit-'+str(n+1)})

    def test_complete_before_after_chain_and_original_submission(self):
        self.seed(23);result=history(self.app,self.root,2,{'limit':7});rows=[]
        self.assertEqual(result['original_content'],'周五 15 点');self.assertEqual(result['current']['content'],'修改 23');self.assertIsNone(result['execution'])
        while True:
            rows+=result['changes']
            if not result['next_cursor']:break
            result=history(self.app,self.root,2,{'limit':7,'cursor':result['next_cursor']})
        self.assertEqual([r['revision'] for r in rows],list(range(23,0,-1)))
        for row in rows:self.assertEqual(row['before'],'周五 15 点' if row['revision']==1 else '修改 '+str(row['revision']-1))
        self.assertEqual(result['total'],23)

    def test_new_changes_do_not_shift_older_pages(self):
        self.seed(4);first=history(self.app,self.root,2,{'limit':2})
        update(self.app,self.root,2,{'content':'新发生的修改','revision':4,'request_id':'newer'})
        older=history(self.app,self.root,2,{'limit':2,'cursor':first['next_cursor']})
        self.assertEqual([r['revision'] for r in older['changes']],[2,1]);self.assertEqual(older['snapshot_revision'],4)
        self.assertEqual(older['latest_revision'],5);self.assertEqual(older['total'],4)
        self.assertEqual(history(self.app,self.root,2)['changes'][0]['revision'],5)

    def test_current_text_page_and_counts_share_one_read_snapshot(self):
        self.seed(2);other=Application(self.tmp.name);self.addCleanup(other.close)
        store=self.app.control_store;read=store.read_snapshot;fired=[]
        @contextmanager
        def snapshot(db=None):
            with read(db) as connection:
                if db is None:
                    def trace(sql):
                        if not fired and sql.startswith('SELECT COUNT(*) FROM task_message_edits'):
                            fired.append(True);update(other,self.root,2,{'content':'并发新内容','revision':2,'request_id':'concurrent'})
                    connection.set_trace_callback(trace)
                try:yield connection
                finally:
                    if db is None:connection.set_trace_callback(None)
        with patch.object(store,'read_snapshot',snapshot):result=history(self.app,self.root,2,store=store)
        self.assertTrue(fired);self.assertEqual(result['current']['content'],'修改 2');self.assertEqual(result['total'],2)
        self.assertEqual(result['latest_revision'],2);self.assertEqual([r['revision'] for r in result['changes']],[2,1])
        self.assertEqual(history(self.app,self.root,2)['current']['content'],'并发新内容')

    def test_history_order_uses_revision_when_clock_moves_back(self):
        self.seed(2)
        with self.app.control_store.transaction() as db:db.execute('UPDATE task_message_edits SET created=100-revision WHERE tenant=? AND task_id=?',(self.app.tenant,self.root))
        rows=history(self.app,self.root,2)['changes'];self.assertEqual([r['revision'] for r in rows],[2,1]);self.assertLess(rows[0]['saved_at'],rows[1]['saved_at'])

    def test_execution_content_remains_available_after_dispatch(self):
        self.seed(1);self.dispatch.stop()
        with patch.object(self.app,'schedule'):self.service.dispatch(self.root)
        result=history(self.app,self.root,2);self.assertEqual(result['execution']['content'],'修改 1')
        self.assertEqual(result['execution']['run_id'],self.service.rows(self.service.root(self.root))[1]['run_id'])
        self.assertEqual(result['original_content'],'周五 15 点')

    def test_cancelled_queue_keeps_history_without_execution(self):
        self.seed(1);self.service.cancel_queued(self.root,2,{'revision':3})
        result=history(self.app,self.root,2);self.assertEqual(result['current']['status'],'CANCELLED');self.assertIsNone(result['execution'])
        self.assertEqual(result['changes'][0]['after'],'修改 1')

    def test_scopes_and_cursor_cannot_cross_messages(self):
        self.seed(2);cursor=history(self.app,self.root,2,{'limit':1})['next_cursor']
        self.service.append(self.root,{'content':'另一条消息','request_id':'third','revision':4})
        with self.assertRaises(ValueError):history(self.app,self.root,3,{'cursor':cursor})
        other=Application(self.tmp.name,principal='another');self.addCleanup(other.close)
        space=self.app.workspaces.save({'name':'其他空间','business':'验证','scenario':'记录','description':'','revision':0})
        for app in (other,self.app.scoped(space['id'])):
            with self.assertRaises((PolicyDenied,KeyError)):history(app,self.root,2)

    def test_invalid_bounds_and_cursors_are_rejected(self):
        self.seed(2)
        for params in ({'limit':0},{'limit':21},{'limit':True},{'limit':1.2},{'limit':'bad'},{'cursor':'!invalid'},{'cursor':'x'*1025}):
            with self.subTest(params=params),self.assertRaises(ValueError):history(self.app,self.root,2,params)
        cursor=history(self.app,self.root,2,{'limit':1})['next_cursor'];decoded=json.loads(base64.urlsafe_b64decode(cursor+'='*(-len(cursor)%4)))
        for change in ({'v':True},{'through':999},{'before':0},{'scope':'another'},{'extra':1}):
            bad=base64.urlsafe_b64encode(json.dumps({**decoded,**change}).encode()).decode()
            with self.assertRaises(ValueError):history(self.app,self.root,2,{'cursor':bad})
        with self.assertRaises(KeyError):history(self.app,self.root,9)

    def test_read_is_bounded_and_does_not_hydrate_details_or_write(self):
        self.seed(21);before=self.app.detail(self.root)['events']
        with patch.object(self.app,'detail',side_effect=AssertionError('history hydrated full detail')),patch.object(TaskConversations,'dispatch',side_effect=AssertionError('history dispatched')):
            result=history(self.app,self.root,2,{'limit':20})
        self.assertEqual(len(result['changes']),20);self.assertTrue(result['next_cursor']);self.assertEqual(before,self.app.detail(self.root)['events'])
        self.assertNotIn('request_id',result['changes'][0])

    def test_empty_and_old_readonly_database_are_explicit(self):
        from agent_framework.store import Store
        result=history(self.app,self.root,2);self.assertEqual(result['changes'],[]);self.assertEqual(result['total'],0);self.assertEqual(result['snapshot_revision'],0)
        with self.app.control_store.transaction() as db:db.execute('DROP TABLE task_message_edits')
        self.app.close();store=Store(Path(self.tmp.name)/'runtime.sqlite3',read_only=True)
        self.assertEqual(history(self.app,self.root,2,store=store)['original_content'],'周五 15 点')


class MessageHistoryHTTPTests(unittest.TestCase):
    setUp=web_fixtures.HTTPTests.setUp
    tearDown=web_fixtures.HTTPTests.tearDown
    request=web_fixtures.HTTPTests.request

    def test_route_is_readonly_and_returns_exact_turn(self):
        from tests.test_run_catalog import seed_history
        root=seed_history(self.app,count=1,turns=1,body_bytes=10)[0]
        with patch.object(TaskConversations,'dispatch',return_value=False):
            TaskConversations(self.app).append(root,{'content':'原要求','request_id':'followup','revision':1})
            update(self.app,root,2,{'content':'改过的要求','request_id':'edit','revision':0})
        url='/api/tasks/'+root+'/messages/2/edits';status,_,raw=self.request(url)
        self.assertEqual(status,200);data=json.loads(raw);self.assertEqual(data['turn'],2);self.assertEqual(data['changes'][0]['before'],'原要求')
        self.assertEqual(self.request(url+'?limit=21')[0],400)
        self.assertNotEqual(self.request(url,'POST','{}')[0],200)
        self.assertEqual(self.request('/task_message_history.js')[0],200)
