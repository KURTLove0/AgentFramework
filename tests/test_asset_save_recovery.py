"""Asset retries recover the same version without duplicate index or audit writes."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.contracts import PolicyDenied
from agent_framework.knowledge import Access,Library
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application,WebServer


def payload(kind='KNOWLEDGE',**changes):
    return {'kind':kind,'title':'可靠保存的资料','content':{'language':'zh'} if kind=='PREFERENCE' else {'text':'保存原事实与来源。'},**changes}


class AssetSaveRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.library=self.app.library();self.access=self.app.library_access()

    def save(self,data=None,key='asset-save-test',library=None,access=None):
        return (library or self.library).create(access or self.access,data or payload(),request_id=key)

    def counts(self):
        with self.library.store.connect() as db:
            return {table:db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['asset_versions','asset_search','asset_events','asset_save_requests']}

    def test_duplicate_creates_return_one_asset_receipt_and_one_audit(self):
        first=self.save();second=self.save();self.assertEqual(first['ref'],second['ref']);self.assertFalse(first['save_receipt']['replayed']);self.assertTrue(second['save_receipt']['replayed'])
        self.assertEqual(first['content_hash'],second['save_receipt']['content_hash']);self.assertEqual(first['save_receipt']['ref'],first['ref'])
        self.assertEqual(self.counts(),{'asset_versions':1,'asset_search':1,'asset_events':1,'asset_save_requests':1})

    def test_all_four_manual_kinds_support_exact_retries(self):
        for kind in ['KNOWLEDGE','PREFERENCE','MEMORY','CAPABILITY']:
            with self.subTest(kind=kind):
                first=self.save(payload(kind),kind);self.assertEqual(self.save(payload(kind),kind)['ref'],first['ref'])
        self.assertEqual(self.counts()['asset_versions'],4)

    def test_omitted_generated_defaults_do_not_change_the_retry_hash(self):
        first=self.save();again=self.save();self.assertEqual(first['observed_at'],again['observed_at']);self.assertEqual(first['effective_at'],again['effective_at'])

    def test_changed_content_or_revision_with_same_key_is_a_conflict(self):
        first=self.save();before=self.counts()
        for changes in [{'title':'其他内容'},{'content':{'text':'其他正文'}},{'id':first['id'],'supersedes':first['ref']}]:
            with self.subTest(changes=changes),self.assertRaises(ConfigConflict):self.save(payload(**changes))
        self.assertEqual(self.counts(),before)

    def test_revision_retries_do_not_create_another_version(self):
        first=self.save();data=payload(id=first['id'],supersedes=first['ref'],title='修订')
        revision=self.save(data,'revision-key');again=self.save(data,'revision-key');self.assertEqual(revision['ref'],again['ref']);self.assertEqual(again['version'],2)
        self.assertEqual(self.counts()['asset_versions'],2);self.assertEqual(self.counts()['asset_events'],2)

    def test_receipt_is_stable_when_a_later_version_already_exists(self):
        first=self.save();self.save(payload(id=first['id'],supersedes=first['ref'],title='后续版本'),'new-key')
        recovered=self.library.save_request(self.access,'asset-save-test');self.assertEqual(recovered['version'],1);self.assertEqual(recovered['title'],first['title']);self.assertEqual(self.save()['ref'],first['ref'])

    def test_current_status_and_accepted_draft_status_are_separate(self):
        first=self.save();self.library.transition(self.access,first['ref'],'REVIEW');self.library.transition(self.access,first['ref'],'PUBLISHED')
        recovered=self.save();self.assertEqual(recovered['status'],'PUBLISHED');self.assertEqual(recovered['save_receipt']['status'],'DRAFT');self.assertEqual(self.counts()['asset_versions'],1)

    def test_withdrawal_does_not_make_retry_create_or_republish(self):
        first=self.save();self.library.transition(self.access,first['ref'],'REVIEW');self.library.transition(self.access,first['ref'],'WITHDRAWN');before=self.counts()
        self.assertEqual(self.save()['status'],'WITHDRAWN');self.assertEqual(self.counts(),before)

    def test_concurrent_retries_from_separate_connections_commit_once(self):
        other=self.app.library()
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda lib:self.save(library=lib),[self.library,other]))
        self.assertEqual(results[0]['ref'],results[1]['ref']);self.assertEqual(self.counts(),{'asset_versions':1,'asset_search':1,'asset_events':1,'asset_save_requests':1})

    def test_receipt_survives_a_new_library_instance_and_application_restart(self):
        first=self.save();reopened=Application(self.tmp.name);self.addCleanup(reopened.close)
        self.assertEqual(reopened.library().save_request(reopened.library_access(),'asset-save-test')['ref'],first['ref'])
        self.assertEqual(self.save(library=reopened.library())['ref'],first['ref'])

    def test_receipt_insert_failure_rolls_back_asset_index_and_audit(self):
        with self.library.store.connect() as db:db.execute("CREATE TRIGGER reject_asset_receipt BEFORE INSERT ON asset_save_requests BEGIN SELECT RAISE(ABORT,'receipt failed'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.save()
        self.assertEqual(self.counts(),{'asset_versions':0,'asset_search':0,'asset_events':0,'asset_save_requests':0})
        with self.library.store.connect() as db:db.execute('DROP TRIGGER reject_asset_receipt')
        self.assertEqual(self.save()['version'],1)

    def test_same_key_is_independent_for_tenant_principal_and_project(self):
        first=self.save();scope=self.access
        for access in [Access('tenant-other',scope.principal,scope.project,roles=scope.roles),Access(scope.tenant,'person-other',scope.project,roles=scope.roles),Access(scope.tenant,scope.principal,'project-other',roles=scope.roles)]:
            with self.subTest(access=access):
                with self.assertRaises(KeyError):self.library.save_request(access,'asset-save-test')
                other=self.save(access=access);self.assertNotEqual(other['ref'],first['ref'])
        self.assertEqual(self.counts()['asset_versions'],4)

    def test_other_project_member_cannot_read_a_receipt_for_a_shared_asset(self):
        first=self.save();other=Access(self.access.tenant,'other-member',self.access.project,roles=self.access.roles)
        self.assertEqual(self.library.get(other,first['ref'])['ref'],first['ref'])
        with self.assertRaises(KeyError):self.library.save_request(other,'asset-save-test')

    def test_receipt_lookup_is_read_only_and_missing_does_not_create_a_record(self):
        before=self.counts()
        with self.assertRaises(KeyError):self.library.save_request(self.access,'not-accepted')
        self.assertEqual(self.counts(),before)

    def test_new_requests_still_check_roles_and_current_revision(self):
        first=self.save();reader=Access(self.access.tenant,self.access.principal,self.access.project)
        with self.assertRaises(PolicyDenied):self.save(payload(title='未授权'),'other',access=reader)
        data=payload(id=first['id'],supersedes=first['ref']);self.save(data,'revision-two')
        with self.assertRaises(ValueError):self.save(data,'revision-three')
        self.assertEqual(self.counts()['asset_versions'],2)

    def test_keys_are_validated_without_writing(self):
        before=self.counts()
        for key in ['',True,'x'*101,'request/other']:
            with self.subTest(key=key),self.assertRaises(ValueError):self.save(key=key)
        self.assertEqual(self.counts(),before)

    def test_legacy_calls_without_request_keys_keep_their_existing_return_shape(self):
        saved=self.library.create(self.access,payload());self.assertNotIn('save_receipt',saved);self.assertEqual(saved['status'],'DRAFT')

    def test_deleted_workspace_blocks_new_save_and_replay_until_restored(self):
        space=self.app.workspaces.save({'name':'保存恢复空间','business':'合成','scenario':'保存','description':'','revision':0});access=self.app.scoped(space['id']).library_access();first=self.save(access=access)
        self.app.workspaces.lifecycle(space['id'],1,True);before=self.counts()
        with self.assertRaises(KeyError):self.save(access=access)
        with self.assertRaises(KeyError):self.library.save_request(access,'asset-save-test')
        self.assertEqual(self.counts(),before);self.app.workspaces.lifecycle(space['id'],2,False);self.assertEqual(self.save(access=access)['ref'],first['ref'])

    def test_http_lookup_has_a_specific_missing_code_and_scoped_receipt(self):
        with patch.object(Application,'start_scheduler'),patch.object(Application,'start_conversation_dispatcher'):server=WebServer(('127.0.0.1',0),self.app)
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start()
        def call(path,data=None,space=None):
            connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            try:
                headers={'Content-Type':'application/json','X-Agent-Token':self.app.token,'X-Agent-Workspace':space or self.app.workspace['id']}
                connection.request('GET' if data is None else 'POST',path,None if data is None else json.dumps(data),headers);response=connection.getresponse();return response.status,json.loads(response.read())
            finally:connection.close()
        try:
            data={**payload(),'request_id':'http-save'};code,first=call('/api/knowledge/assets',data);self.assertEqual(code,201)
            code,retry=call('/api/knowledge/assets',data);self.assertEqual(code,201);self.assertEqual(retry['ref'],first['ref'])
            code,receipt=call('/api/asset-saves/http-save');self.assertEqual(code,200);self.assertEqual(receipt['ref'],first['ref'])
            code,missing=call('/api/asset-saves/missing');self.assertEqual(code,404);self.assertEqual(missing['code'],'asset_save_not_found')
            self.assertEqual(call('/api/knowledge/assets',{**data,'title':'不同内容'})[0],409)
            space=self.app.workspaces.save({'name':'其他保存空间','business':'测试','scenario':'隔离','description':'','revision':0});self.assertEqual(call('/api/asset-saves/http-save',space=space['id'])[0],404)
        finally:server.shutdown();server.server_close();thread.join(2)
