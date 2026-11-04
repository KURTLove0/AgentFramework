"""Workspace write responses describe the transaction that accepted the edit."""
from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.store import Store
from agent_framework.workspaces import WorkspaceRegistry


def body(name,revision=0):
    return {'name':name,'business':'测试','scenario':'保存回执','description':'','revision':revision}


class WorkspaceWriteReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'state.db')
        self.registry=WorkspaceRegistry(self.store,'tenant-test')

    def test_create_receipt_does_not_depend_on_a_followup_read(self):
        with patch.object(self.registry,'get',side_effect=AssertionError('follow-up read')):
            saved=self.registry.save(body('创建结果'))
        self.assertEqual(saved['name'],'创建结果');self.assertEqual(saved['revision'],1)
        self.assertEqual(self.registry.get(saved['id']),saved)

    def test_edit_receipt_remains_the_accepted_revision_when_another_process_edits_after_commit(self):
        first=self.registry.save(body('初始名称'))
        other=WorkspaceRegistry(Store(Path(self.tmp.name)/'state.db'),'tenant-test')
        original=self.store.transaction

        @contextmanager
        def commit_then_edit():
            with original() as db:
                yield db
            other.save(body('另一进程随后保存',2),first['id'])

        with patch.object(self.store,'transaction',commit_then_edit):
            accepted=self.registry.save(body('本次保存',1),first['id'])
        self.assertEqual(accepted['name'],'本次保存');self.assertEqual(accepted['revision'],2)
        self.assertEqual(accepted['project_id'],first['project_id'])
        current=self.registry.get(first['id']);self.assertEqual(current['revision'],3);self.assertEqual(current['name'],'另一进程随后保存')

    def test_edit_receipt_survives_a_concurrent_deletion_after_commit(self):
        first=self.registry.save(body('即将编辑'))
        other=WorkspaceRegistry(Store(Path(self.tmp.name)/'state.db'),'tenant-test')
        original=self.store.transaction

        @contextmanager
        def commit_then_delete():
            with original() as db:
                yield db
            other.lifecycle(first['id'],2,True)

        with patch.object(self.store,'transaction',commit_then_delete):
            accepted=self.registry.save(body('已接受修改',1),first['id'])
        self.assertEqual(accepted['revision'],2);self.assertFalse(accepted['deleted'])
        self.assertTrue(self.registry.get(first['id'],include_deleted=True)['deleted'])
