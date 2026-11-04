"""Runtime settings commits keep durable, scoped and immutable save receipts."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.runtime_config import RuntimeConfiguration,ConfigConflict
from agent_framework.web import Application
from tests import test_web as http_fixture

SETTINGS={'default_runtime':'mock','profiles':{'codex':{'model':'test-codex','reasoning_effort':'medium','timeout':60,'max_attempts':2},'cursor':{'model':'test-cursor','timeout':60,'max_attempts':2},'qoder':{'model':'test-qoder','timeout':60,'max_attempts':2}}}


class RuntimeSettingsRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.defaults=patch.object(RuntimeConfiguration,'defaults',lambda _:deepcopy(SETTINGS));self.defaults.start();self.addCleanup(self.defaults.stop)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.service=self.app.configuration

    def payload(self,**changes):return deepcopy(SETTINGS)|{'revision':self.service.get()['revision'],'request_id':'save-runtime'}|changes
    def save(self,data):return self.service.accept(data,self.app.principal)

    def test_replayed_save_returns_original_version_after_later_changes(self):
        data=self.payload();first=self.save(data);later=self.payload(request_id='second-save');later['profiles']['codex']['timeout']=90;second=self.save(later)
        replay=self.save(data);self.assertEqual(replay['receipt'],first['receipt']);self.assertEqual(replay['settings'],second['settings']);self.assertEqual(self.service.get()['revision'],2)
        self.assertEqual(self.service.inspect_request('save-runtime',self.app.principal)['receipt']['settings']['profiles']['codex']['timeout'],60)

    def test_same_id_with_different_payload_is_rejected_without_new_version(self):
        data=self.payload();self.save(data)
        for changes in [{'default_runtime':'codex'},{'revision':1}]:
            with self.assertRaises(ConfigConflict):self.save(data|changes)
        self.assertEqual(self.service.get()['revision'],1)

    def test_same_request_across_instances_commits_once(self):
        other=RuntimeConfiguration(self.tmp.name,self.app.tenant);data=self.payload()
        with ThreadPoolExecutor(max_workers=2) as pool:packets=list(pool.map(lambda service:service.accept(data,self.app.principal),[self.service,other]))
        self.assertEqual(packets[0]['receipt'],packets[1]['receipt']);self.assertEqual(self.service.get()['revision'],1)

    def test_two_different_requests_with_same_base_cannot_overwrite(self):
        other=RuntimeConfiguration(self.tmp.name,self.app.tenant);a=self.payload();b=self.payload(request_id='other-save');b['profiles']['cursor']['timeout']=100
        def attempt(args):
            service,data=args
            try:return service.accept(data,self.app.principal)
            except ConfigConflict:return None
        with ThreadPoolExecutor(max_workers=2) as pool:packets=list(pool.map(attempt,[(self.service,a),(other,b)]))
        self.assertEqual(sum(p is not None for p in packets),1);self.assertEqual(self.service.get()['revision'],1)

    def test_settings_and_receipt_rollback_together(self):
        with self.service.store.connect() as db:db.execute("CREATE TRIGGER reject_runtime_receipt BEFORE INSERT ON runtime_configuration_requests BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END")
        with self.assertRaisesRegex(Exception,'injected receipt failure'):self.save(self.payload())
        self.assertEqual(self.service.get()['revision'],0);self.assertFalse(self.service.inspect_request('save-runtime',self.app.principal)['found'])

    def test_lookup_is_readonly_and_scoped_to_tenant_and_principal(self):
        self.save(self.payload());other=RuntimeConfiguration(self.tmp.name,'other-tenant')
        with patch.object(self.service.store,'transaction',side_effect=AssertionError('lookup wrote data')):
            missing=self.service.inspect_request('missing',self.app.principal);self.assertFalse(missing['found']);self.assertIsNone(missing['receipt']);self.assertEqual(missing['settings']['revision'],1)
            self.assertFalse(self.service.inspect_request('save-runtime','other-person')['found'])
            self.assertFalse(other.inspect_request('save-runtime',self.app.principal)['found'])
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_saved_receipts_survive_application_restart_and_default_changes(self):
        data=self.payload();first=self.save(data);self.app.close()
        changed=deepcopy(SETTINGS);changed['profiles']['qoder']['model']='changed-default'
        with patch.object(RuntimeConfiguration,'defaults',lambda _:changed):
            service=RuntimeConfiguration(self.tmp.name,self.app.tenant);self.assertEqual(service.accept(data,self.app.principal)['receipt'],first['receipt'])

    def test_legacy_saves_keep_qoder_and_frozen_task_profiles(self):
        self.save(self.payload());data=self.payload();data.pop('request_id');data['profiles'].pop('qoder');data['profiles']['cursor']['timeout']=90
        saved=self.service.save(data);self.assertEqual(saved['profiles']['qoder'],SETTINGS['profiles']['qoder']);self.assertEqual(saved['revision'],2)
        with self.assertRaises(ConfigConflict):self.service.save(data)
        self.assertEqual(self.service.inspect_request('save-runtime',self.app.principal)['receipt']['settings']['profiles']['cursor']['timeout'],60)

    def test_invalid_requests_leave_no_config_or_receipt(self):
        for changes in [{'request_id':'../bad'},{'revision':True},{'revision':-1},{'extra':1},{'profiles':{}},{'default_runtime':'unknown'}]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.save(self.payload(**changes))
        self.assertEqual(self.service.get()['revision'],0)
        with self.service.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_configuration_requests').fetchone()[0],0)

    def test_workspace_changes_share_config_and_receipt_for_same_user(self):
        first=self.save(self.payload());space=self.app.workspaces.save({'name':'另一空间','business':'测试','scenario':'测试','description':'','revision':0})
        other=self.app.scoped(space['id']);self.assertEqual(other.configuration.inspect_request('save-runtime',other.principal)['receipt'],first['receipt'])


class RuntimeSettingsRecoveryHTTPTests(unittest.TestCase):
    setUp=http_fixture.HTTPTests.setUp
    tearDown=http_fixture.HTTPTests.tearDown
    request=http_fixture.HTTPTests.request

    def test_new_receipt_lookup_and_legacy_payload_remain_supported(self):
        payload=deepcopy(SETTINGS)|{'revision':0,'request_id':'http-runtime'}
        status,_,body=self.request('/api/runtime-config','POST',json.dumps(payload));self.assertEqual(status,200);saved=json.loads(body);self.assertTrue(saved['found']);self.assertEqual(saved['receipt']['base_revision'],0)
        status,_,body=self.request('/api/runtime-config/requests/http-runtime');self.assertEqual(status,200);self.assertEqual(json.loads(body)['receipt'],saved['receipt'])
        payload.pop('request_id');payload['revision']=1
        status,_,body=self.request('/api/runtime-config','POST',json.dumps(payload));self.assertEqual(status,200);self.assertEqual(json.loads(body)['settings']['revision'],2)
        self.assertFalse(json.loads(self.request('/api/runtime-config/requests/not-found')[2])['found'])

    def test_conflict_and_invalid_request_do_not_return_false_receipts(self):
        data=deepcopy(SETTINGS)|{'revision':0,'request_id':'one'};self.assertEqual(self.request('/api/runtime-config','POST',json.dumps(data))[0],200)
        data['request_id']='two';status,_,body=self.request('/api/runtime-config','POST',json.dumps(data));self.assertEqual(status,409);self.assertNotIn('receipt',json.loads(body))
        self.assertFalse(json.loads(self.request('/api/runtime-config/requests/two')[2])['found'])


if __name__=='__main__':unittest.main()
