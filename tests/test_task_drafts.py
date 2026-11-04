"""Reviewed draft revisions survive deletion, recreation and task submission."""
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.definitions import default_definition
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application


class TaskDraftTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='task-drafts-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)

    def save(self,goal,revision):
        return self.app.save_task_draft({'revision':revision,'draft':{'goal':goal}})

    def test_discard_keeps_a_revision_and_stale_save_cannot_recreate_old_content(self):
        original=self.save('原草稿',0)
        cleared=self.app.discard_task_draft({'revision':original['revision']})
        self.assertIsNone(cleared['draft']);self.assertGreater(cleared['revision'],original['revision'])
        latest=self.save('新一份草稿',cleared['revision'])
        with self.assertRaises(ConfigConflict):self.save('旧页面迟到的输入',original['revision'])
        self.assertEqual(self.app.task_draft(),latest)

    def test_confirmation_cannot_discard_a_newer_draft_and_retry_is_idempotent(self):
        original=self.save('已查看的草稿',0);latest=self.save('另一页面的新草稿',original['revision'])
        with self.assertRaises(ConfigConflict):self.app.discard_task_draft({'revision':original['revision']})
        self.assertEqual(self.app.task_draft(),latest)
        cleared=self.app.discard_task_draft({'revision':latest['revision']})
        self.assertEqual(self.app.discard_task_draft({'revision':latest['revision']}),cleared)
        newer=self.save('再次新建的草稿',cleared['revision'])
        with self.assertRaises(ConfigConflict):self.app.discard_task_draft({'revision':latest['revision']})
        self.assertEqual(self.app.task_draft(),newer)

    def agent_payload(self):
        agent=self.app.agents.save({'name':'草稿验证助手','description':'整理目标','runtime':'mock','model':'builtin','options':{},'prompt':'按目标完成任务。',
            'skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('草稿验证助手','general-assistant@1.0.0')})
        return {'goal':'按本页内容创建任务','agent_id':agent['id'],'agent_revision':1,'request_id':'draft-task','clear_draft':True}

    def test_task_accepted_from_stale_draft_preserves_new_content_and_returns_its_receipt(self):
        payload=self.agent_payload();original=self.save('本页草稿',0);latest=self.save('其他页面正在编辑的草稿',original['revision'])
        detail=self.app.start_task({**payload,'draft_revision':original['revision']},start=False)
        self.assertEqual(detail['run']['task']['goal'],payload['goal'])
        self.assertEqual(self.app.task_draft(),latest)
        self.assertEqual(detail['task_draft'],latest)

    def test_matching_task_submission_clears_once_and_replay_preserves_later_draft(self):
        payload=self.agent_payload();draft=self.save('本页草稿',0)
        data={**payload,'draft_revision':draft['revision']}
        first=self.app.start_task(data,start=False)
        self.assertIsNone(first['task_draft']['draft']);self.assertGreater(first['task_draft']['revision'],draft['revision'])
        latest=self.save('新任务的草稿',first['task_draft']['revision'])
        repeated=self.app.start_task(data,start=False)
        self.assertEqual(first['run']['run_id'],repeated['run']['run_id'])
        self.assertEqual(repeated['task_draft'],latest)

    def test_unreviewed_discard_and_cleanup_are_rejected_without_mutation(self):
        draft=self.save('需保护的草稿',0)
        for data in ({},{'revision':True},{'revision':-1},{'revision':1,'extra':True}):
            with self.subTest(data=data),self.assertRaises(ValueError):self.app.discard_task_draft(data)
        payload=self.agent_payload()
        with self.assertRaises(ValueError):self.app.start_task(payload,start=False)
        self.assertEqual(self.app.task_draft(),draft)

    def test_tombstone_persists_after_restart_and_scopes_are_independent(self):
        draft=self.save('待放弃草稿',0);cleared=self.app.discard_task_draft({'revision':draft['revision']})
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(restarted.task_draft(),cleared)
        other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close)
        self.assertEqual(other.task_draft()['revision'],0)
        self.assertEqual(other.save_task_draft({'revision':0,'draft':{'goal':'别人的草稿'}})['revision'],1)
        self.assertEqual(self.app.task_draft(),cleared)

    def test_deleted_workspace_rejects_stale_draft_writes(self):
        workspace=self.app.workspaces.save({'name':'待删除空间','business':'测试','scenario':'草稿','description':'','revision':0})
        scoped=self.app.scoped(workspace['id']);draft=scoped.save_task_draft({'revision':0,'draft':{'goal':'空间草稿'}})
        self.app.workspaces.lifecycle(workspace['id'],1,True)
        with self.assertRaises(KeyError):scoped.save_task_draft({'revision':draft['revision'],'draft':{'goal':'迟到写入'}})
        with self.assertRaises(KeyError):scoped.discard_task_draft({'revision':draft['revision']})
