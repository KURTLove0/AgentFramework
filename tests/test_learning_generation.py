"""Expired proposal work is visible without replay, and cannot commit late results."""
import json
from pathlib import Path
from unittest.mock import patch
import unittest

from agent_framework.backups import BackupError, create_backup, restore_backup
from agent_framework.learning import Learning, agent_generate
from agent_framework.learning_generation import LearningGenerationExpired
from agent_framework.web import Application
from tests import test_learning_acceptance as fixture


class LearningGenerationTests(unittest.TestCase):
    setUp = fixture.LearningAcceptanceTests.setUp
    request = fixture.LearningAcceptanceTests.request

    def pending(self):
        class ProcessExit(BaseException): pass
        with patch('agent_framework.learning.agent_generate', side_effect=ProcessExit):
            with self.assertRaises(ProcessExit): self.service.generate(self.request())
        return self.service.get_by_request(self.request()['request_id'])

    def expire(self, identity):
        with self.service.store.transaction() as db:
            db.execute("UPDATE learning_proposals SET data=json_set(data,'$.generation_claim.expires_at',0) WHERE id=?", (identity,))

    def test_restart_reads_original_live_claim_without_replaying(self):
        pending = self.pending()
        restarted = Application(self.tmp.name)
        self.addCleanup(restarted.close)
        service = Learning(restarted.scoped(self.space['id']))
        with patch('agent_framework.learning.agent_generate', side_effect=AssertionError('read must not replay')):
            result = service.generate(self.request())
        self.assertEqual(result['id'], pending['id'])
        self.assertEqual(result['status'], 'GENERATING')
        self.assertGreater(result['generation_expires_at'], result['created_at'])
        self.assertNotIn('generation_claim', result)

    def test_expired_detail_request_lookup_and_history_agree_without_writes(self):
        pending = self.pending()
        self.expire(pending['id'])
        queries = []
        connect = self.service.store.connect
        def traced():
            db = connect(); db.set_trace_callback(queries.append); return db
        with patch.object(self.service.store, 'connect', side_effect=traced), patch('agent_framework.learning.agent_generate', side_effect=AssertionError('must not generate')):
            detail = self.service.get(pending['id'])
            by_request = self.service.get_by_request(self.request()['request_id'])
            history = self.service.page()['proposals'][0]
        for value in (detail, by_request, history):
            self.assertEqual(value['status'], 'INTERRUPTED')
            self.assertEqual(value['generation_expires_at'], 0)
            self.assertIn('不会自动', value['generation_message'])
        self.assertTrue(all(q.startswith(('SELECT', 'BEGIN', 'COMMIT')) for q in queries))
        with self.service.store.connect() as db:
            row = db.execute('SELECT status,revision FROM learning_proposals WHERE id=?', (pending['id'],)).fetchone()
        self.assertEqual(tuple(row), ('GENERATING', 1))

    def test_generation_finishing_after_its_deadline_cannot_commit(self):
        with patch('agent_framework.learning.GENERATION_SECONDS', -1):
            with self.assertRaises(LearningGenerationExpired): self.service.generate(self.request())
        result = self.service.get_by_request(self.request()['request_id'])
        self.assertEqual(result['status'], 'INTERRUPTED')
        self.assertIsNone(result['output'])
        self.assertEqual(result['revision'], 1)

    def test_late_success_or_failure_cannot_overwrite_replaced_claim(self):
        for fail in (False, True):
            request = self.request() | {'request_id': 'replaced-' + str(fail)}
            def replace(*args):
                pending = self.service.get_by_request(request['request_id'])
                with self.service.store.transaction() as db:
                    db.execute("UPDATE learning_proposals SET data=json_set(data,'$.generation_claim.owner','replacement-owner','$.audit_marker','preserved') WHERE id=?", (pending['id'],))
                if fail: raise RuntimeError('late model failure')
                return agent_generate(*args)
            with self.subTest(fail=fail), patch('agent_framework.learning.agent_generate', side_effect=replace):
                with self.assertRaises(LearningGenerationExpired): self.service.generate(request)
            result = self.service.get_by_request(request['request_id'])
            self.assertEqual(result['revision'], 1)
            self.assertIsNone(result['error'])
            self.assertEqual(result['audit_marker'], 'preserved')

    def test_legacy_pending_uses_saved_time_and_completed_results_do_not_expire(self):
        completed = self.service.generate(self.request())
        with self.service.store.transaction() as db:
            db.execute("UPDATE learning_proposals SET data=json_set(data,'$.generation_claim.expires_at',0) WHERE id=?", (completed['id'],))
        self.assertEqual(self.service.get(completed['id'])['status'], 'DRAFT')
        with self.service.store.transaction() as db:
            db.execute("UPDATE learning_proposals SET status='GENERATING',data=json_set(json_remove(data,'$.generation_claim'),'$.created_at',1,'$.output',NULL) WHERE id=?", (completed['id'],))
        result = self.service.get(completed['id'])
        self.assertEqual(result['status'], 'INTERRUPTED')
        self.assertEqual(result['generation_expires_at'], 241)

    def test_expired_replay_returns_original_until_user_submits_a_new_request(self):
        pending = self.pending(); self.expire(pending['id'])
        with patch('agent_framework.learning.agent_generate', wraps=agent_generate) as generate:
            self.assertEqual(self.service.generate(self.request())['status'], 'INTERRUPTED')
            self.assertEqual(generate.call_count, 0)
            replacement = self.service.generate(self.request() | {'request_id': 'explicit-new-generation'})
            self.assertEqual(generate.call_count, 1)
        self.assertNotEqual(replacement['id'], pending['id'])
        self.assertEqual(replacement['status'], 'DRAFT')
        self.assertEqual(self.service.get(pending['id'])['status'], 'INTERRUPTED')

    def test_active_generation_blocks_backup_and_expired_restore_is_interrupted(self):
        pending = self.pending()
        archive, restored = Path(self.tmp.name) / 'learning-backup.zip', Path(self.tmp.name) / 'restored-learning'
        with self.assertRaisesRegex(BackupError, '复盘或本体'): create_backup(self.tmp.name, archive)
        self.expire(pending['id'])
        create_backup(self.tmp.name, archive)
        receipt = restore_backup(archive, restored)
        self.assertEqual(receipt['leases_cleared']['learning_proposals'], 1)
        app = Application(restored); self.addCleanup(app.close)
        result = Learning(app.scoped(self.space['id'])).get(pending['id'])
        self.assertEqual(result['status'], 'INTERRUPTED')
        with self.service.store.connect() as db:
            claim = json.loads(db.execute('SELECT data FROM learning_proposals WHERE id=?', (pending['id'],)).fetchone()[0])['generation_claim']
        self.assertNotEqual(claim['owner'], '')

    def test_private_scope_does_not_expose_expired_generation(self):
        pending = self.pending(); self.expire(pending['id'])
        other = Application(self.tmp.name, principal='other-reader'); self.addCleanup(other.close)
        service = Learning(other.scoped(self.space['id']))
        self.assertEqual(service.page()['proposals'], [])
        with self.assertRaises(KeyError): service.get(pending['id'])
        with self.assertRaises(KeyError): service.get_by_request(self.request()['request_id'])
