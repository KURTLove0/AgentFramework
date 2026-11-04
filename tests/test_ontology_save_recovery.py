"""Exact ontology save receipts distinguish the accepted revision from later edits."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
import sqlite3
import unittest
from unittest.mock import patch

from agent_framework.contracts import digest,PolicyDenied
from agent_framework.knowledge import Access,Library
from agent_framework.ontology import revise,save_status
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application
import test_asset_write_safety as fixture


class OntologySaveRecoveryTests(unittest.TestCase):
    ontology=fixture.AssetWriteSafetyTests.ontology
    publish=fixture.AssetWriteSafetyTests.publish
    delete=fixture.AssetWriteSafetyTests.delete
    def setUp(self):
        fixture.AssetWriteSafetyTests.setUp(self);self.base=self.ontology(True)
        self.content=deepcopy(self.base['content']);self.content['description']='本次保存的修改'

    def save(self,key='ontology-save-test',**kwargs):
        return revise(kwargs.get('lib',self.lib),kwargs.get('access',self.access),kwargs.get('ref',self.base['ref']),
                      {'request_id':key,'content':kwargs.get('content',self.content)})

    def counts(self):
        with self.lib.store.connect() as db:
            return {table:db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['asset_versions','asset_search','asset_events','asset_save_requests']}

    def test_exact_retry_returns_same_revision_without_extra_assets_indexes_or_events(self):
        first=self.save();before=self.counts();again=self.save()
        self.assertEqual(first['ref'],again['ref']);self.assertEqual(self.counts(),before)
        self.assertFalse(first['save_receipt']['replayed']);self.assertTrue(again['save_receipt']['replayed'])
        self.assertEqual(first['save_receipt']['request_hash'],digest({'operation':'ontology.revise','base_ref':self.base['ref'],'content':self.content}))

    def test_status_distinguishes_own_save_from_another_pages_later_version(self):
        own=self.save();later=deepcopy(self.content);later['description']='另一页面随后修订'
        current=self.save('later',ref=own['ref'],content=later)
        status=save_status(self.lib,self.access,'ontology-save-test',self.base['ref'])
        self.assertEqual(status['saved']['ref'],own['ref']);self.assertEqual(status['latest']['ref'],current['ref'])
        self.assertEqual(status['saved']['content']['description'],'本次保存的修改')
        self.assertEqual(self.save()['ref'],own['ref'])

    def test_missing_request_is_not_inferred_from_a_different_latest_version(self):
        other=self.save('other-page');before=self.counts()
        status=save_status(self.lib,self.access,'not-accepted',self.base['ref'])
        self.assertEqual(status['state'],'MISSING');self.assertIsNone(status['saved']);self.assertEqual(status['latest']['ref'],other['ref']);self.assertEqual(before,self.counts())

    def test_changed_content_base_or_operation_cannot_reuse_request(self):
        first=self.save();before=self.counts()
        with self.assertRaises(ConfigConflict):self.save(content={**self.content,'description':'不同内容'})
        with self.assertRaises(ConfigConflict):self.save(ref=first['ref'])
        with self.assertRaises(ConfigConflict):self.lib.create(self.access,{'title':'普通资料','content':{'text':'other'}},request_id='ontology-save-test')
        self.assertEqual(self.counts(),before)

    def test_concurrent_identical_requests_across_applications_write_once(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(self.save,lib=lib) for lib in [self.lib,self.other_lib]]
            values=[future.result() for future in futures]
        self.assertEqual(values[0]['ref'],values[1]['ref']);self.assertEqual(values[0]['version'],2)
        with self.lib.store.connect() as db:self.assertEqual(db.execute("SELECT COUNT(*) FROM asset_events WHERE event='ontology.revised'").fetchone()[0],1)

    def test_replay_survives_restart_withdrawal_and_source_changes(self):
        own=self.save();self.lib.transition(self.access,own['ref'],'REVIEW');self.lib.transition(self.access,own['ref'],'WITHDRAWN')
        self.lib.transition(self.access,self.base['provenance']['sources'][0]['ref'],'WITHDRAWN')
        another=Application(self.tmp.name);self.addCleanup(another.close)
        result=self.save(lib=another.scoped(self.space['id']).library());self.assertEqual(result['status'],'WITHDRAWN');self.assertEqual(result['save_receipt']['status'],'DRAFT')
        self.assertEqual(result['ref'],own['ref'])

    def test_failure_to_store_receipt_rolls_back_version_index_and_audit(self):
        before=self.counts()
        with self.lib.store.connect() as db:db.execute("CREATE TRIGGER fail_ontology_receipt BEFORE INSERT ON asset_save_requests BEGIN SELECT RAISE(ABORT,'receipt failed'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.save()
        self.assertEqual(before,self.counts())

    def test_saved_reply_describes_its_commit_even_when_another_page_saves_afterward(self):
        original=self.lib.store.transaction
        @contextmanager
        def interleave():
            with original() as db:yield db
            self.save('after-commit',lib=self.other_lib,ref=self.base['id']+'@2',content={**self.content,'description':'after'})
        with patch.object(self.lib.store,'transaction',interleave):result=self.save()
        self.assertEqual(result['version'],2);self.assertEqual(result['content']['description'],'本次保存的修改')

    def test_status_is_read_only_and_uses_one_snapshot(self):
        self.save();queries=[];connect=self.lib.store.connect
        def traced():
            db=connect();db.set_trace_callback(queries.append);return db
        with patch.object(self.lib.store,'connect',traced):save_status(self.lib,self.access,'ontology-save-test',self.base['ref'])
        self.assertTrue(all(q.lstrip().split()[0].upper() in ['SELECT','BEGIN','COMMIT'] for q in queries),queries)

    def test_deleted_workspace_blocks_new_save_and_readback(self):
        self.save();self.delete();before=self.counts()
        with self.assertRaises(KeyError):self.save()
        with self.assertRaises(KeyError):save_status(self.lib,self.access,'ontology-save-test',self.base['ref'])
        self.assertEqual(self.counts(),before)

    def test_private_receipt_scope_cannot_be_read_by_another_principal_or_environment(self):
        self.save()
        for access in [Access(self.access.tenant,'other',self.access.project,roles=self.access.roles),Access(self.access.tenant,self.access.principal,'different',roles=self.access.roles)]:
            with self.assertRaises((KeyError,PolicyDenied)):
                save_status(self.lib,access,'ontology-save-test',self.base['ref'])

