"""Review writes remain attributable after lost replies and later writers."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import sqlite3
from pathlib import Path
import unittest
from unittest.mock import patch

from agent_framework.learning import Learning
from agent_framework.learning_writes import status
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application
from agent_framework.workspaces import WorkspaceDeleted
from agent_framework.backups import create_backup, restore_backup
import test_learning_acceptance as fixture


class LearningWriteRecoveryTests(unittest.TestCase):
    setUp=fixture.LearningAcceptanceTests.setUp
    request=fixture.LearningAcceptanceTests.request

    def draft(self):return self.service.generate(self.request())

    def save_body(self,p,key='review-save'):
        output=deepcopy(p['output']);output['name']='本页保存'
        return {'revision':p['revision'],'output':output,'request_id':key}

    def deposit_body(self,p,key='review-deposit'):
        return {'revision':p['revision'],'item_ids':['ontology'],'request_id':key}

    def count(self,table):
        with self.service.store.connect() as db:return db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]

    def test_save_replay_and_readback_return_original_after_newer_save_and_deposit(self):
        p=self.draft();q=self.save_body(p);own=self.service.save(p['id'],q)
        other=Learning(self.other);later=other.save(p['id'],self.save_body(own,'another-save'));deposited=other.deposit(p['id'],self.deposit_body(later,'another-deposit'))
        before=self.count('learning_write_requests')
        self.assertEqual(self.service.save(p['id'],q),own)
        packet=status(self.service,q['request_id'],p['id']);self.assertEqual(packet['saved'],own);self.assertEqual(packet['latest'],self.service.get(p['id']))
        self.assertEqual(packet['latest']['revision'],deposited['revision']);self.assertEqual(packet['saved']['status'],'DRAFT');self.assertEqual(self.count('learning_write_requests'),before)

    def test_unreceived_request_is_missing_even_after_someone_else_deposited(self):
        p=self.draft();self.service.deposit(p['id'],self.deposit_body(p,'other'))
        packet=status(self.service,'not-received',p['id']);self.assertEqual(packet['state'],'MISSING');self.assertIsNone(packet['saved']);self.assertEqual(packet['latest']['status'],'DEPOSITED')
        with self.assertRaises(ConfigConflict):self.service.deposit(p['id'],self.deposit_body(p,'not-received'))
        self.assertEqual(self.count('learning_write_requests'),1)

    def test_deposit_replays_after_restart_and_source_withdrawal_without_duplicate_assets(self):
        p=self.draft();q=self.deposit_body(p);own=self.service.deposit(p['id'],q);assets=self.count('asset_versions')
        self.lib.transition(self.access,self.source['ref'],'WITHDRAWN')
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close);service=Learning(restarted.scoped(self.space['id']))
        self.assertEqual(service.deposit(p['id'],q),own);self.assertEqual(self.count('asset_versions'),assets)
        self.assertEqual(status(service,q['request_id'],p['id'])['saved'],own)

    def test_key_reuse_for_changed_content_revision_operation_or_proposal_is_rejected(self):
        p=self.draft();q=self.save_body(p);saved=self.service.save(p['id'],q)
        for change in ({'revision':saved['revision']},{'output':p['output']}):
            with self.assertRaises(ConfigConflict):self.service.save(p['id'],{**q,**change})
        with self.assertRaises(ConfigConflict):self.service.deposit(p['id'],self.deposit_body(saved,q['request_id']))
        request=self.request();request['request_id']='another-generation';other=self.service.generate(request)
        with self.assertRaises(ConfigConflict):self.service.save(other['id'],self.save_body(other,q['request_id']))
        with self.assertRaises(ConfigConflict):status(self.service,q['request_id'],other['id'])

    def test_parallel_identical_writes_commit_once(self):
        p=self.draft();q=self.save_body(p);other=Learning(self.other)
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda svc:svc.save(p['id'],q),[self.service,other]))
        self.assertEqual(results[0],results[1]);self.assertEqual(self.count('learning_write_requests'),1)
        q=self.deposit_body(results[0])
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda svc:svc.deposit(p['id'],q),[self.service,other]))
        self.assertEqual(results[0],results[1]);self.assertEqual(self.count('learning_write_requests'),2)

    def test_receipt_failure_rolls_back_review_and_all_deposited_assets(self):
        p=self.draft();assets=self.count('asset_versions')
        with self.service.store.transaction() as db:db.execute("CREATE TRIGGER reject_learning_receipt BEFORE INSERT ON learning_write_requests BEGIN SELECT RAISE(ABORT,'receipt failure'); END")
        for method,body in [(self.service.save,self.save_body(p)),(self.service.deposit,self.deposit_body(p))]:
            with self.assertRaises(sqlite3.IntegrityError):method(p['id'],body)
            self.assertEqual(self.service.get(p['id']),p);self.assertEqual(self.count('asset_versions'),assets);self.assertEqual(self.count('learning_write_requests'),0)

    def test_reply_snapshot_is_frozen_before_another_writer_commits(self):
        p=self.draft();q=self.save_body(p);transaction=self.service.store.transaction
        @contextmanager
        def commit_then_save():
            with transaction() as db:yield db
            other=Learning(self.other);later=other.get(p['id']);output=deepcopy(later['output']);output['name']='其他页面'
            other.save(p['id'],{'revision':later['revision'],'output':output})
        with patch.object(self.service.store,'transaction',commit_then_save):own=self.service.save(p['id'],q)
        self.assertEqual(own['output']['name'],'本页保存');self.assertEqual(status(self.service,q['request_id'],p['id'])['saved'],own)
        self.assertEqual(self.service.get(p['id'])['output']['name'],'其他页面')

    def test_status_uses_one_read_only_snapshot(self):
        p=self.draft();q=self.save_body(p);self.service.save(p['id'],q);snapshot=self.service.store.read_snapshot;opened=0
        @contextmanager
        def read(db=None):
            nonlocal opened
            if db is None:opened+=1
            with snapshot(db) as current:yield current
        with patch.object(self.service.store,'read_snapshot',read),patch.object(self.service.store,'transaction',side_effect=AssertionError('read mutated')):
            self.assertEqual(status(self.service,q['request_id'],p['id'])['state'],'COMPLETE')
        self.assertEqual(opened,1)

    def test_workspace_and_principal_are_checked_and_deleted_workspace_cannot_replay(self):
        p=self.draft();q=self.save_body(p);self.service.save(p['id'],q)
        with self.assertRaises(KeyError):status(Learning(self.root),'review-save',p['id'])
        other=self.root.scoped(self.space['id']);other.principal='another-owner'
        with self.assertRaises(KeyError):status(Learning(other),'review-save',p['id'])
        self.root.workspaces.lifecycle(self.space['id'],1,True)
        with self.assertRaises(WorkspaceDeleted):status(self.service,'review-save',p['id'])
        with self.assertRaises(WorkspaceDeleted):self.service.save(p['id'],q)

    def test_invalid_request_and_tampered_receipt_are_not_replayed(self):
        p=self.draft();q=self.save_body(p)
        for change in ({'request_id':None},{'revision':True},{'revision':0}):
            with self.assertRaises(ValueError):self.service.save(p['id'],{**q,**change})
        self.service.save(p['id'],q)
        with self.service.store.transaction() as db:db.execute("UPDATE learning_write_requests SET result_hash='tampered'")
        with self.assertRaises(ConfigConflict):status(self.service,'review-save',p['id'])

    def test_backup_restore_preserves_both_receipts_and_replays_without_new_writes(self):
        p=self.draft();save=self.save_body(p);saved=self.service.save(p['id'],save);deposit=self.deposit_body(saved);done=self.service.deposit(p['id'],deposit)
        with fixture.tempfile.TemporaryDirectory() as destination:
            archive=Path(destination)/'backup.zip';target=Path(destination)/'restored'
            create_backup(self.tmp.name,archive);restore_backup(archive,target)
            app=Application(target)
            try:
                service=Learning(app.scoped(self.space['id']))
                self.assertEqual(service.save(p['id'],save),saved);self.assertEqual(service.deposit(p['id'],deposit),done)
                self.assertEqual(status(service,save['request_id'],p['id'])['saved'],saved)
                self.assertEqual(service.get(p['id'])['revision'],done['revision'])
                with service.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM learning_write_requests').fetchone()[0],2)
            finally:app.close()


if __name__=='__main__':unittest.main()
