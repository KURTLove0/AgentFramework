"""Agent saves retain a scoped receipt and reject stale or archived writes."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.agents import AgentRegistry
from agent_framework.backups import create_backup,restore_backup
from agent_framework.definitions import default_definition
from agent_framework.runtime_config import ConfigConflict
from agent_framework.web import Application
from tests import test_web as web_tests


def payload(revision=0):
    return {'name':'保存恢复助手','description':'处理任务','runtime':'mock','model':'builtin','options':{},'prompt':'按目标完成任务。',
            'skills':[],'mcp_servers':[],'revision':revision,'definition':default_definition('保存恢复助手','general-assistant@1.0.0')}


class AgentSaveRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='agent-save-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)

    def save(self,data,identity=None,request='save-first',app=None):
        app=app or self.app
        return app.agents.save(data,identity,request_id=request,principal=app.principal)

    def test_repeated_create_returns_the_same_agent_and_durable_receipt(self):
        first=self.save(payload());second=self.save(payload())
        self.assertEqual(first['id'],second['id']);self.assertEqual(len(self.app.agents.list()),1)
        self.assertEqual(second['save_receipt']['revision'],1);self.assertTrue(second['save_receipt']['replayed'])

    def test_matching_archived_revision_does_not_allow_configuration_updates(self):
        agent=self.app.agents.save(payload());archived=self.app.agents.archive(agent['id'],1)
        with self.assertRaisesRegex(ConfigConflict,'归档'):self.app.agents.save(payload(archived['revision']),agent['id'])
        self.assertEqual(self.app.agents.get(agent['id']),archived)

    def test_old_workspace_view_cannot_create_or_update_after_deletion(self):
        space=self.app.workspaces.save({'name':'过期配置空间','description':'','business':'测试','scenario':'编辑','revision':0});scoped=self.app.scoped(space['id'])
        agent=scoped.agents.save(payload());self.app.workspaces.lifecycle(space['id'],1,True)
        for action in (lambda:scoped.agents.save(payload()),lambda:scoped.agents.save(payload(1),agent['id']),lambda:scoped.agents.archive(agent['id'],1),lambda:scoped.agents.compile(agent['id'])):
            with self.assertRaises(KeyError):action()

    def test_replayed_edit_does_not_consume_another_revision(self):
        original=self.app.agents.save(payload());edited=self.save(payload(1),original['id'],request='edit')
        replay=self.save(payload(1),original['id'],request='edit');self.assertEqual(edited['revision'],2);self.assertEqual(replay['revision'],2)
        with self.assertRaises(ConfigConflict):self.save(payload(1),original['id'],request='new-stale-edit')
        with self.assertRaises(KeyError):self.app.agents.save_request('new-stale-edit',principal=self.app.principal)

    def test_receipt_replay_precedes_validation_and_returns_current_archived_state(self):
        first=self.save(payload());archived=self.app.agents.archive(first['id'],1)
        with patch.object(self.app.agents,'prepare',side_effect=AssertionError('accepted request was revalidated')):
            replay=self.save(payload())
        self.assertTrue(replay['archived']);self.assertEqual(replay['revision'],archived['revision']);self.assertEqual(replay['save_receipt']['revision'],1)

    def test_same_identifier_cannot_apply_a_different_payload_or_agent(self):
        first=self.save(payload());different=payload();different['prompt']='不同的工作指令'
        with self.assertRaises(ConfigConflict):self.save(different)
        with self.assertRaises(ConfigConflict):self.save(payload(1),first['id'])
        self.assertEqual(len(self.app.agents.list()),1);self.assertEqual(self.app.agents.get(first['id'])['revision'],1)

    def test_simultaneous_application_views_create_one_agent(self):
        other=Application(self.tmp.name);self.addCleanup(other.close);barrier=threading.Barrier(2);prepare=AgentRegistry.prepare
        def simultaneous(registry,*args,**kwargs):
            result=prepare(registry,*args,**kwargs);barrier.wait(timeout=10);return result
        with patch.object(AgentRegistry,'prepare',simultaneous),ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(self.save,payload(),app=app) for app in (self.app,other)]
            replies=[future.result(timeout=15) for future in futures]
        self.assertEqual(replies[0]['id'],replies[1]['id']);self.assertEqual(len(self.app.agents.list()),1)
        self.assertEqual(sum(bool(reply['save_receipt']['replayed']) for reply in replies),1)

    def test_receipt_survives_restart_and_backup_restore(self):
        first=self.save(payload());restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(self.save(payload(),app=restarted)['id'],first['id'])
        root=Path(self.tmp.name);archive=root/'backup.zip';target=root/'restored';create_backup(root,archive);restore_backup(archive,target)
        restored=Application(target);self.addCleanup(restored.close)
        self.assertEqual(self.save(payload(),app=restored)['id'],first['id']);self.assertEqual(len(restored.agents.list()),1)

    def test_request_keys_are_scoped_to_actor_workspace_and_tenant(self):
        first=self.save(payload());other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close)
        with self.assertRaises(KeyError):other.agents.save_request('save-first',principal=other.principal)
        second=self.save(payload(),app=other);self.assertNotEqual(first['id'],second['id'])
        space=self.app.workspaces.save({'name':'另一空间','description':'','business':'测试','scenario':'保存','revision':0});scoped=self.app.scoped(space['id'])
        third=self.save(payload(),app=scoped)
        tenant=Application(self.tmp.name,tenant='other-tenant');self.addCleanup(tenant.close);fourth=self.save(payload(),app=tenant)
        self.assertEqual(len({first['id'],second['id'],third['id'],fourth['id']}),4)

    def test_failed_receipt_insert_rolls_back_agent_and_can_retry_same_request(self):
        with self.app.control_store.connect() as db:db.execute("CREATE TRIGGER reject_save_receipt BEFORE INSERT ON agent_save_requests BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.save(payload())
        self.assertEqual(self.app.agents.list(),[])
        with self.assertRaises(KeyError):self.app.agents.save_request('save-first',principal=self.app.principal)
        with self.app.control_store.connect() as db:db.execute('DROP TRIGGER reject_save_receipt')
        self.assertEqual(self.save(payload())['revision'],1)

    def test_save_receipt_does_not_depend_on_a_followup_profile_read(self):
        with patch.object(self.app.agents,'get',side_effect=AssertionError('saved receipt depends on GET')):saved=self.app.agents.save(payload())
        self.assertEqual(self.app.agents.get(saved['id']),saved)

    def test_workspace_deleted_during_validation_cannot_commit_a_new_agent(self):
        space=self.app.workspaces.save({'name':'校验期间删除','description':'','business':'测试','scenario':'保存','revision':0});scoped=self.app.scoped(space['id']);prepare=scoped.agents.prepare
        def delete_after_validation(*args,**kwargs):
            result=prepare(*args,**kwargs);self.app.workspaces.lifecycle(space['id'],1,True);return result
        with patch.object(scoped.agents,'prepare',side_effect=delete_after_validation),self.assertRaises(KeyError):self.save(payload(),app=scoped)
        self.assertEqual(scoped.agents.list(),[])


class AgentSaveHTTPTests(unittest.TestCase):
    setUp=web_tests.HTTPTests.setUp
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_http_retry_returns_same_profile_and_receipt_is_private(self):
        data={**payload(),'request_id':'http-save'};status,_,raw=self.request('/api/agents','POST',json.dumps(data));self.assertEqual(status,201);first=json.loads(raw)
        status,_,raw=self.request('/api/agents','POST',json.dumps(data));self.assertEqual(status,201);self.assertEqual(json.loads(raw)['id'],first['id'])
        self.assertEqual(self.request('/api/agents/save-requests/http-save')[0],200)
        other=Application(self.tmp.name,principal='other-user');self.addCleanup(other.close);self.server.application=other
        self.assertEqual(self.request('/api/agents/save-requests/http-save')[0],404)

    def test_untrusted_actor_and_invalid_request_id_are_rejected(self):
        for changes in ({'principal':'other-user','request_id':'request'},{'request_id':None},{'request_id':True},{'request_id':'bad/key'}):
            with self.subTest(changes=changes):self.assertEqual(self.request('/api/agents','POST',json.dumps({**payload(),**changes}))[0],400)
        self.assertEqual(self.app.agents.list(),[])
