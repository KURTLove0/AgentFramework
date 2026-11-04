"""History summaries remain correct without hydrating replies and audit trails."""
from copy import deepcopy
import base64
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from agent_framework.workspace_scheduler import WorkspaceScheduler
from tests.test_workflows import role


def seed_history(app, count=8, turns=3, prefix='history', body_bytes=2048):
    agent = role(app, '历史记录助手', 'general-assistant@1.0.0')
    template = app.start_task({'goal': '仅生成隔离历史样本', 'agent_id': agent['id'], 'agent_revision': 1,
                               'request_id': prefix + '-template'}, start=False)['run']
    roots = []
    with app.runtime().store.transaction() as db:
        for index in range(count):
            identity = prefix + '-' + str(index).zfill(4)
            roots.append(identity)
            created = time.time() - 100000 + index * 60
            db.execute('INSERT INTO task_conversations VALUES(?,?,?,?,?,?,?,?)',
                       (app.tenant, identity, app.workspace['id'], app.workspace['project_id'], app.principal, turns, created, created + turns))
            for number in range(1, turns + 1):
                run_id = identity if number == 1 else identity + '-turn-' + str(number)
                state = deepcopy(template)
                state.update(run_id=run_id, status='SUCCEEDED', version=1, created_at=created + number - 1,
                             updated_at=created + number, deadline=created + 3600, model_calls=1, model_tokens=15,
                             report={'title': '历史报告', 'content': '保留完整正文 ' + 'x' * body_bytes, 'citations': [], 'limitations': []})
                state['task'].update(goal='历史目标-' + str(index).zfill(4) if number == 1 else '补充消息-' + str(number),
                                     change_id=identity, source_run_id=None if number == 1 else identity)
                state['task']['conversation_context'].update(task_id=identity, turn=number, goal='历史目标-' + str(index).zfill(4))
                db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,?,?)', (app.tenant, run_id, 1, canonical(state)))
                db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',
                           (app.tenant, identity, number, run_id, 'message-' + str(number), state['task']['goal'], 'RUNNING', None, created + number - 1))
                for seq in range(1, 4):
                    db.execute('INSERT INTO events VALUES(?,?,?,?,?,?)',
                               (app.tenant, run_id, seq, created + number, 'model.progress', canonical({'kind': 'summary', 'text': '完整审计片段 ' + 'x' * body_bytes})))
        db.execute('DELETE FROM runs WHERE tenant_id=? AND id=?', (app.tenant, template['run_id']))
        db.execute('DELETE FROM events WHERE tenant_id=? AND run_id=?', (app.tenant, template['run_id']))
    return roots


class RunCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name)
        self.addCleanup(self.app.close)
        self.roots = seed_history(self.app)

    def set_status(self, identity, status, **fields):
        state = self.app.runtime().store.load(self.app.tenant, identity)
        state.update(status=status, **fields)
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE tenant_id=? AND id=?', (canonical(state), self.app.tenant, identity))

    def extra_turn(self, root, state, error=None):
        with self.app.runtime().store.transaction() as db:
            db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',
                       (self.app.tenant, root, 4, root + '-queued', 'extra', '新补充内容', state, error, time.time()))

    def test_summary_matches_full_conversation_for_completed_waiting_queued_cancelled_and_failed_turns(self):
        self.set_status(self.roots[0] + '-turn-3', 'WAITING_INPUT', last_error='请补充信息')
        self.set_status(self.roots[1] + '-turn-3', 'WAITING_AUTH', last_error='需要授权')
        self.extra_turn(self.roots[2], 'QUEUED')
        self.extra_turn(self.roots[3], 'CANCELLED')
        self.extra_turn(self.roots[4], 'ERROR', '补充轮次不能创建')
        self.set_status(self.roots[5] + '-turn-3', 'FAILED', last_error='模型响应失败')
        page = {item['run_id']: item for item in self.app.runs()['runs']}
        for root in self.roots:
            view = TaskConversations(self.app).view(root)
            with self.subTest(root=root):
                for key in ('status', 'updated_at', 'deadline', 'model_calls', 'model_tokens', 'last_error'):
                    self.assertEqual(page[root][key], view[key], key)
                self.assertEqual(page[root]['goal'], '历史目标-' + root.rsplit('-', 1)[1])
        self.assertEqual(self.app.runs()['counts']['total'], 8)
        self.assertEqual(self.app.runs({'status': 'group:waiting'})['filtered_total'], 2)

    def test_list_does_not_load_reply_audit_or_actions_and_filters_before_pagination(self):
        statements = []
        original = Store.connect
        def traced(store):
            db = original(store)
            db.set_trace_callback(statements.append)
            return db
        with patch.object(Store, 'connect', new=traced):
            page = self.app.runs({'search': '历史目标-0003', 'limit': 1})
        self.assertEqual([row['run_id'] for row in page['runs']], [self.roots[3]])
        self.assertEqual(page['counts']['total'], 8)
        heavy = [sql for sql in statements if 'FROM events ' in sql or 'FROM actions ' in sql]
        self.assertEqual(heavy, [], 'History listing hydrated audit/actions for header-only rows')

    def test_latest_turn_job_drives_running_count_and_filter(self):
        identity = self.roots[0] + '-turn-3'
        self.set_status(identity, 'RUNNING')
        self.app.jobs[identity] = {'active': True, 'state': 'RUNNING', 'cancel': threading.Event()}
        page = self.app.runs({'status': 'group:running'})
        self.assertEqual(page['counts']['running'], 1)
        self.assertEqual([row['run_id'] for row in page['runs']], [self.roots[0]])
        self.assertTrue(page['runs'][0]['job']['active'])

    def test_scope_queries_hide_other_workspaces_principals_and_tenants(self):
        space = self.app.workspaces.save({'name': '隔离空间', 'business': '测试', 'scenario': '历史', 'description': '', 'revision': 0})
        seed_history(self.app.scoped(space['id']), count=2, prefix='other-space')
        other = Application(self.tmp.name, principal='other-person')
        self.addCleanup(other.close)
        seed_history(other, count=2, prefix='other-person')
        tenant = Application(self.tmp.name, tenant='other-tenant')
        self.addCleanup(tenant.close)
        seed_history(tenant, count=2, prefix='other-tenant')
        self.assertEqual({row['run_id'] for row in self.app.runs()['runs']}, set(self.roots))
        self.assertEqual(self.app.runs()['counts']['total'], 8)

    def test_updated_cursor_keeps_its_boundary_when_anchor_gets_a_followup(self):
        for sort in ('updated_desc', 'updated_asc'):
            initial_order=[row['run_id'] for row in self.app.runs({'sort':sort})['runs']]
            first=self.app.runs({'sort':sort,'limit':7})
            anchor=first['runs'][-1]['run_id']
            self.set_status(anchor+'-turn-3','SUCCEEDED',updated_at=time.time())
            following=self.app.runs({'sort':sort,'limit':7,'cursor':first['next_cursor']})
            with self.subTest(sort=sort):
                self.assertEqual([row['run_id'] for row in following['runs']],initial_order[7:])

    def test_cursor_is_bound_to_its_filters_sort_and_scope(self):
        cursor = self.app.runs({'sort': 'created_asc', 'limit': 2})['next_cursor']
        for change in ({'sort': 'created_desc'}, {'sort': 'created_asc', 'search': '历史目标'}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, '分页游标'):
                self.app.runs({**change, 'cursor': cursor})
        other = Application(self.tmp.name, principal='another-principal')
        self.addCleanup(other.close)
        with self.assertRaisesRegex(ValueError, '分页游标'):
            other.runs({'sort': 'created_asc', 'cursor': cursor})

    def test_invalid_options_fail_without_reading_history(self):
        with patch.object(self.app, 'accessible_run_states', side_effect=AssertionError('history was read')):
            for options in ({'limit': 'bad'}, {'limit': 201}, {'created_after': 'nan'}, {'created_before': 'inf'}, {'sort': 'unknown'}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    self.app.runs(options)

    def test_legacy_cursor_remains_supported_for_existing_clients(self):
        cursor = base64.urlsafe_b64encode(self.roots[2].encode()).decode().rstrip('=')
        page = self.app.runs({'sort': 'created_asc', 'limit': 2, 'cursor': cursor})
        self.assertEqual([row['run_id'] for row in page['runs']], self.roots[3:5])

    def test_completed_history_does_not_wake_the_background_dispatcher(self):
        with patch.object(TaskConversations, 'dispatch', side_effect=AssertionError('completed history was dispatched')):
            TaskConversations.tick(self.app)

    def test_dispatch_resume_checks_metadata_without_hydrating_completed_turns(self):
        identity = self.roots[0] + '-turn-3'
        self.set_status(identity, 'RUNNING')
        with patch.object(Store, 'result', side_effect=AssertionError('completed history was hydrated')), patch.object(self.app, 'schedule') as schedule:
            self.assertTrue(TaskConversations(self.app).dispatch(self.roots[0]))
            schedule.assert_called_once_with(identity,automatic=True)

    def test_attention_uses_latest_turn_leases_and_avoids_audit_reads(self):
        identity = self.roots[0] + '-turn-3'
        self.set_status(identity, 'RUNNING')
        lease = self.app.runtime().store.acquire(self.app.tenant, identity, 30)
        try:
            with patch.object(Store, 'result', side_effect=AssertionError('attention hydrated full runs')):
                attention = self.app.attention()
            self.assertFalse(any(row['run_id'] == self.roots[0] for row in attention['tasks']))
        finally:
            state = self.app.runtime().store.load(self.app.tenant, identity)
            self.app.runtime().store.release(state, lease)
        attention = self.app.attention()
        item = next(row for row in attention['tasks'] if row['run_id'] == self.roots[0])
        self.assertEqual(item['attention_kind'], 'resume')

    def test_private_legacy_conversation_does_not_break_or_leak_through_another_users_history(self):
        root = self.app.runtime().store.load(self.app.tenant, self.roots[0])
        root['snapshot'].pop('context_policy', None)
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE runs SET state=? WHERE id=?', (canonical(root), root['run_id']))
        other = Application(self.tmp.name, principal='another-principal')
        self.addCleanup(other.close)
        self.assertEqual(other.runs()['counts']['total'], 0)

    def test_equal_timestamps_paginate_by_identity_without_duplicates(self):
        for root in self.roots:
            self.set_status(root, 'SUCCEEDED', created_at=1000)
        cursor=None;seen=[]
        while True:
            options={'sort': 'created_asc', 'limit': 3}
            if cursor:options['cursor']=cursor
            page=self.app.runs(options)
            seen.extend(row['run_id'] for row in page['runs'])
            cursor=page['next_cursor']
            if not cursor:break
        self.assertEqual(seen,sorted(self.roots))

    def test_summary_batches_beyond_sql_parameter_limits_keep_every_task(self):
        more=seed_history(self.app,count=405,turns=1,prefix='batch-history',body_bytes=0)
        cursor=None;seen=[]
        while True:
            options={'limit': 200}
            if cursor:options['cursor']=cursor
            page=self.app.runs(options)
            seen.extend(row['run_id'] for row in page['runs'])
            cursor=page['next_cursor']
            if not cursor:break
        self.assertEqual(len(seen),len(set(seen)))
        self.assertEqual(set(seen),set(self.roots+more))

    def test_unchanged_daily_plan_does_not_read_history_again(self):
        service=WorkspaceScheduler(self.app)
        plan=service.generate()
        with patch.object(self.app,'accessible_run_states',side_effect=AssertionError('unchanged plan read history')):
            self.assertEqual(service.generate(),plan)

    def test_builtin_tasks_do_not_gain_missing_profile_search_terms(self):
        self.app.create({'goal': '内置岗位的历史任务', 'start': False})
        self.assertEqual(self.app.runs({'search': 'none'})['filtered_total'], 0)

    def test_queue_cancellation_updates_history_activity_without_a_model_event(self):
        root=self.roots[0]
        self.extra_turn(root,'QUEUED')
        before=TaskConversations(self.app).view(root)['updated_at']
        TaskConversations(self.app).cancel_queued(root,4,{'revision':3})
        view=TaskConversations(self.app).view(root)
        self.assertGreater(view['updated_at'],before)
        row=next(row for row in self.app.runs()['runs'] if row['run_id']==root)
        self.assertEqual(row['updated_at'],view['updated_at'])


if __name__ == '__main__':
    unittest.main()
