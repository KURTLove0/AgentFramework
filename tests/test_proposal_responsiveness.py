"""Paused proposal models must not stall normal work in another browser window."""
from contextlib import contextmanager
import threading
import unittest
from unittest.mock import patch

from agent_framework.workflow_chat import WorkflowChat
from agent_framework.learning import Learning, agent_generate
from agent_framework.proposal_capacity import ProposalCapacityBusy
from agent_framework.workflow_chat_requests import WorkflowChatRequests
from tests import test_http_responsiveness as http_fixture


class ProposalResponsivenessTests(unittest.TestCase):
    setUp = http_fixture.HTTPResponsivenessTests.setUp
    tearDown = http_fixture.HTTPResponsivenessTests.tearDown
    request = http_fixture.HTTPResponsivenessTests.request
    blocked_save = http_fixture.HTTPResponsivenessTests.blocked_save

    def inputs(self):
        agent = self.app.agents.save(http_fixture.profile())
        library, access = self.app.library(), self.app.library_access()
        source = library.create(access, {'title': '生成并发验收资料', 'content': {'text': '会议记录需要明确负责人及原始来源。'}})
        library.transition(access, source['ref'], 'REVIEW')
        source = library.transition(access, source['ref'], 'PUBLISHED')
        common = {'request_id': 'design-one', 'agent_id': agent['id'], 'agent_revision': 1, 'consent': False}
        return agent, {**common, 'message': '新建「整理员」负责会议纪要'}, {**common, 'request_id': 'learning-one', 'purpose': 'ontology', 'source_refs': [source['ref']], 'instruction': '保留来源'}

    @contextmanager
    def paused(self, path, payload):
        entered, release = threading.Event(), threading.Event()
        original = WorkflowChat.mock if path == '/api/workflow-chat' else agent_generate
        target = 'agent_framework.workflow_chat.WorkflowChat.mock' if path == '/api/workflow-chat' else 'agent_framework.learning.agent_generate'
        def waiting(*args, **kwargs):
            entered.set()
            if not release.wait(10): raise RuntimeError('test generation was not released')
            return original(*args, **kwargs)
        with patch(target, side_effect=waiting) as model:
            future = self.clients.submit(self.request, path, 'POST', payload, timeout=12)
            try:
                self.assertTrue(entered.wait(3), 'proposal did not reach the model')
                yield future, model
            finally:
                release.set()
                future.result(4)

    def test_design_does_not_block_draft_save_or_task_creation(self):
        agent, design, _ = self.inputs()
        with self.paused('/api/workflow-chat', design) as (future, _):
            status, saved = self.request('/api/task-draft', 'POST', {'revision': 0, 'draft': {'goal': '设计等待期间保存的目标'}}, timeout=1)
            self.assertEqual(status, 200)
            self.assertEqual(saved['revision'], 1)
            status, created = self.request('/api/tasks', 'POST', {'request_id': 'task-during-design', 'goal': '先处理独立任务', 'agent_id': agent['id'], 'agent_revision': 1}, timeout=1)
            self.assertEqual(status, 202)
            self.assertTrue(created['run']['run_id'])
            self.assertFalse(future.done())
        self.assertEqual(future.result()[0], 200)

    def test_ontology_and_retrospective_allow_other_writes_and_replay_in_progress(self):
        agent, _, ontology = self.inputs()
        run = self.app.create({'start': False, 'scenario': 'denied', 'grant': False})['run']['run_id']
        self.app.runtime().run(run)
        retrospective = {k: v for k, v in ontology.items() if k != 'source_refs'}
        retrospective.update(purpose='retrospective', request_id='review-one', run_id=run)
        for index, payload in enumerate((ontology, retrospective)):
            with self.subTest(purpose=payload['purpose']), self.paused('/api/learning-proposals', payload) as (future, model):
                status, saved = self.request('/api/task-draft', 'POST', {'revision': index, 'draft': {'goal': '复盘等待期间仍可工作'}}, timeout=1)
                self.assertEqual(status, 200)
                status, replay = self.request('/api/learning-proposals', 'POST', payload, timeout=1)
                self.assertEqual(status, 201)
                self.assertEqual(replay['status'], 'GENERATING')
                self.assertEqual(model.call_count, 1)
                self.assertEqual(self.request('/api/learning-proposals', 'POST', payload | {'instruction': 'different'}, timeout=1)[0], 409)
                self.assertFalse(future.done())
            self.assertEqual(future.result()[1]['status'], 'DRAFT')

    def test_running_design_duplicate_returns_promptly_without_a_second_generation(self):
        _, design, _ = self.inputs()
        with self.paused('/api/workflow-chat', design) as (_, model):
            self.assertEqual(self.request('/api/workflow-chat', 'POST', design, timeout=1)[0], 409)
            self.assertEqual(self.request('/api/workflow-chat', 'POST', design | {'message': 'different'}, timeout=1)[0], 409)
            status, receipt = self.request('/api/workflow-chat-requests/design-one', timeout=1)
            self.assertEqual(status, 200)
            self.assertEqual(receipt['state'], 'RUNNING')
            self.assertEqual(model.call_count, 1)

    def test_shared_capacity_rejects_unaccepted_work_but_replays_completed_results(self):
        _, design, ontology = self.inputs()
        accepted_design = self.request('/api/workflow-chat', 'POST', design)
        accepted_learning = self.request('/api/learning-proposals', 'POST', ontology)
        busy_design, busy_learning = design | {'request_id': 'busy-design'}, ontology | {'request_id': 'busy-learning'}
        later_design, later_learning = design | {'request_id': 'later-design'}, ontology | {'request_id': 'later-learning'}
        with self.paused('/api/workflow-chat', busy_design) as (_, model), self.paused('/api/learning-proposals', busy_learning) as (_, learning):
            for path, payload, lookup in (('/api/workflow-chat', later_design, '/api/workflow-chat-requests/later-design'),
                                          ('/api/learning-proposals', later_learning, '/api/learning-requests/later-learning')):
                status, body = self.request(path, 'POST', payload, timeout=1)
                self.assertEqual(status, 503)
                self.assertEqual(body['code'], 'proposal_capacity_full')
                self.assertEqual(self.request(lookup, timeout=1)[0], 404)
            self.assertEqual(self.request('/api/workflow-chat', 'POST', design, timeout=1), accepted_design)
            self.assertEqual(self.request('/api/learning-proposals', 'POST', ontology, timeout=1), accepted_learning)
            self.assertEqual(model.call_count, 1)
            self.assertEqual(learning.call_count, 1)
            self.assertEqual(self.request('/api/task-draft', 'POST', {'revision': 0, 'draft': {'goal': '容量满时仍可保存'}}, timeout=1)[0], 200)
        self.assertEqual(self.request('/api/workflow-chat', 'POST', later_design)[0], 200)
        self.assertEqual(self.request('/api/learning-proposals', 'POST', later_learning)[1]['status'], 'DRAFT')

    def test_capacity_is_shared_across_workspace_views(self):
        _, design, ontology = self.inputs()
        space = self.app.workspaces.save(dict(name='另一个生成空间', business='隔离测试', scenario='并发', description='', revision=0))
        other = self.app.scoped(space['id'])
        other_agent = other.agents.save(http_fixture.profile())
        payload = design | {'agent_id': other_agent['id'], 'request_id': 'other-space-design'}
        with self.paused('/api/workflow-chat', design), self.paused('/api/learning-proposals', ontology):
            status, body = self.request('/api/workflow-chat', 'POST', payload, {'X-Agent-Workspace': space['id']}, timeout=1)
            self.assertEqual(status, 503)
            self.assertEqual(body['code'], 'proposal_capacity_full')
            self.assertEqual(self.request('/api/workflow-chat-requests/other-space-design', headers={'X-Agent-Workspace': space['id']})[0], 404)
        self.assertEqual(self.request('/api/workflow-chat', 'POST', payload, {'X-Agent-Workspace': space['id']})[0], 200)
        self.assertEqual(WorkflowChat(self.app).list()[0]['id'], WorkflowChatRequests(self.app).get('design-one')['response']['id'])

    def test_configuration_changes_are_prompt_and_design_commit_still_checks_version(self):
        agent, design, _ = self.inputs()
        with self.paused('/api/workflow-chat', design) as (future, _):
            status, archived = self.request('/api/agents/' + agent['id'] + '/archive', 'POST', {'revision': 1, 'archived': True}, timeout=1)
            self.assertEqual(status, 200)
            self.assertTrue(archived['archived'])
        self.assertEqual(future.result()[0], 409)
        self.assertEqual(WorkflowChat(self.app).list(), [])
        self.assertEqual(WorkflowChatRequests(self.app).get('design-one')['state'], 'ERROR')

    def test_accepted_learning_keeps_its_frozen_input_when_agent_changes(self):
        agent, _, ontology = self.inputs()
        with self.paused('/api/learning-proposals', ontology) as (future, _):
            self.assertEqual(self.request('/api/agents/' + agent['id'] + '/archive', 'POST', {'revision': 1, 'archived': True}, timeout=1)[0], 200)
        status, proposal = future.result()
        self.assertEqual(status, 201)
        self.assertEqual(proposal['status'], 'DRAFT')
        self.assertEqual(proposal['agent_revision'], 1)

    def test_generation_does_not_wait_behind_an_unrelated_configuration_preflight(self):
        agent, design, ontology = self.inputs()
        # The fixture pauses AgentRegistry.prepare itself. Reuse an existing
        # executor so design does not intentionally call that same preflight.
        design['message'] = '先' + agent['name'] + '整理会议'
        with self.blocked_save():
            self.assertEqual(self.request('/api/workflow-chat', 'POST', design, timeout=1)[0], 200)
            self.assertEqual(self.request('/api/learning-proposals', 'POST', ontology, timeout=1)[0], 201)

    def test_scheduler_can_acquire_ordinary_command_lock_during_generation(self):
        _, design, _ = self.inputs()
        ticked = threading.Event()
        with self.paused('/api/workflow-chat', design), patch('agent_framework.workspace_scheduler.tick', side_effect=lambda app: ticked.set()):
            self.app.start_scheduler()
            try: self.assertTrue(ticked.wait(1), 'proposal model occupied the scheduler command lock')
            finally:
                self.app.scheduler_stop.set()
                self.app.scheduler_thread.join(2)

    def test_model_failures_and_acceptance_rollback_release_capacity(self):
        _, design, ontology = self.inputs()
        with self.app.proposal_capacity.reserve():
            for path, payload, target in (('/api/workflow-chat', design, 'agent_framework.workflow_chat.WorkflowChat.mock'),
                                          ('/api/learning-proposals', ontology, 'agent_framework.learning.agent_generate')):
                with patch(target, side_effect=RuntimeError('synthetic model failure')), self.assertLogs(level='ERROR'):
                    self.assertEqual(self.request(path, 'POST', payload)[0], 500)
            with self.app.control_store.connect() as db:
                db.execute("CREATE TRIGGER refuse_design BEFORE INSERT ON workflow_chat_requests BEGIN SELECT RAISE(ABORT,'synthetic acceptance failure'); END")
            with self.assertLogs(level='ERROR'):
                self.assertEqual(self.request('/api/workflow-chat', 'POST', design | {'request_id': 'rolled-back'})[0], 500)
            with self.app.control_store.connect() as db: db.execute('DROP TRIGGER refuse_design')
            self.assertEqual(self.request('/api/workflow-chat-requests/rolled-back')[0], 404)
            self.assertEqual(self.request('/api/workflow-chat', 'POST', design | {'request_id': 'after-errors'})[0], 200)
            self.assertEqual(self.request('/api/learning-proposals', 'POST', ontology | {'request_id': 'after-errors'})[0], 201)

    def test_generation_auth_and_scope_checks_still_run_before_capacity_errors(self):
        _, design, _ = self.inputs()
        with self.app.proposal_capacity.reserve(), self.app.proposal_capacity.reserve():
            for headers in ({'X-Agent-Token': ''}, {'Origin': 'https://outside.example'}, {'X-Agent-Workspace': 'missing-space'}):
                self.assertIn(self.request('/api/workflow-chat', 'POST', design, headers, timeout=1)[0], (403, 404))
            self.assertEqual(self.request('/api/workflow-chat', 'POST', design | {'unknown': True}, timeout=1)[0], 400)
            self.assertEqual(self.request('/api/learning-proposals', 'POST', {'request_id': 'invalid'}, timeout=1)[0], 400)

    def test_capacity_is_released_even_after_a_nonordinary_exception(self):
        class Interrupted(BaseException): pass
        with self.app.proposal_capacity.reserve():
            with self.assertRaises(Interrupted), self.app.proposal_capacity.reserve(): raise Interrupted()
            with self.app.proposal_capacity.reserve():
                with self.assertRaises(ProposalCapacityBusy), self.app.proposal_capacity.reserve(): pass
