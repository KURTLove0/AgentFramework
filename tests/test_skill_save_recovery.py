"""Skill saves retain private, durable receipts for immutable package versions."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from agent_framework import skills as skill_module
from agent_framework.backups import create_backup,restore_backup
from agent_framework.contracts import canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.skills import SkillRegistry
from agent_framework.web import Application
from tests import test_web as web_tests


def payload(name='receipt-method',revision=0,body='原工作方法'):
    return {'folder':name,'revision':revision,'files':{
        'SKILL.md':{'encoding':'utf-8','content':'---\nname: '+name+'\ndescription: 保存回执测试方法\n---\n\n'+body+'\n'},
        'references/source.md':{'encoding':'utf-8','content':'保留参考资料'},
        'assets/sample.bin':{'encoding':'base64','content':'/wCB'}}}


class SkillSaveRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close);self.registry=self.app.skills()

    def save(self,data,identity=None,key='skill-save-first',principal=None,registry=None):
        return (registry or self.registry).save(data,identity,request_id=key,principal=principal or self.app.principal)

    def test_create_retry_returns_the_same_version_and_one_audit(self):
        first=self.save(payload());again=self.save(payload())
        self.assertEqual(again['id'],first['id']);self.assertEqual(again['package'],first['package']);self.assertEqual(again['version'],1)
        self.assertTrue(again['save_receipt']['replayed']);self.assertFalse(first['save_receipt']['replayed'])
        self.assertEqual(len(self.registry.get(first['id'])['versions']),1)
        self.assertEqual(sum(e['kind']=='saved' for e in self.registry.events(first['id'])),1)

    def test_edit_retry_keeps_the_accepted_version_after_later_changes(self):
        first=self.save(payload());data=payload(revision=1,body='第二版方法')
        second=self.save(data,first['id'],'skill-save-edit')
        third=self.registry.save(payload(revision=2,body='其他页面的第三版'),first['id'])
        again=self.save(data,first['id'],'skill-save-edit')
        self.assertEqual(again['version'],2);self.assertEqual(again['package'],second['package']);self.assertEqual(again['revision'],third['revision'])
        self.assertEqual(again['save_receipt']['revision'],2);self.assertEqual(again['save_receipt']['version'],2)
        self.assertEqual(len(again['versions']),3)

    def test_changed_content_or_target_cannot_reuse_an_accepted_request(self):
        first=self.save(payload())
        for data,target in ((payload(body='修改后的输入'),None),(payload(),first['id']),(payload('another-method'),None)):
            with self.subTest(target=target),self.assertRaises(ConfigConflict):self.save(data,target)
        self.assertEqual(len(self.registry.get(first['id'])['versions']),1)

    def test_receipt_is_scoped_to_principal_tenant_and_workspace(self):
        first=self.save(payload())
        with self.assertRaises(KeyError):self.registry.save_request('skill-save-first',principal='another-user')
        other=self.save(payload('another-method'),principal='another-user');self.assertNotEqual(first['id'],other['id'])
        space=self.app.workspaces.save({'name':'回执其他空间','description':'','business':'测试','scenario':'保存','revision':0})
        registry=self.app.scoped(space['id']).skills()
        with self.assertRaises(KeyError):registry.save_request('skill-save-first',principal=self.app.principal)
        saved=self.save(payload(),registry=registry);self.assertNotEqual(saved['id'],first['id'])
        other_app=Application(self.tmp.name,tenant='tenant-other');self.addCleanup(other_app.close)
        with self.assertRaises(KeyError):other_app.skills().save_request('skill-save-first',principal=self.app.principal)

    def test_concurrent_retries_commit_one_version_and_one_receipt(self):
        other=self.app.skills()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda registry:self.save(payload(),registry=registry),(self.registry,other)))
        self.assertEqual(results[0]['id'],results[1]['id']);self.assertEqual(len(self.registry.get(results[0]['id'])['versions']),1)
        self.assertEqual(sum(e['kind']=='saved' for e in self.registry.events(results[0]['id'])),1)

    def test_receipt_failure_rolls_back_the_head_version_and_audit(self):
        with self.registry.store.connect() as db:
            db.execute("CREATE TRIGGER reject_skill_receipt BEFORE INSERT ON skill_save_requests BEGIN SELECT RAISE(ABORT,'receipt failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.save(payload())
        self.assertEqual(len(self.registry.list()),2)
        with self.assertRaises(KeyError):self.registry.save_request('skill-save-first',principal=self.app.principal)
        with self.registry.store.connect() as db:db.execute('DROP TRIGGER reject_skill_receipt')
        self.assertEqual(self.save(payload())['version'],1)

    def test_published_or_archived_saved_version_is_returned_without_a_new_write(self):
        first=self.save(payload());published=self.registry.lifecycle(first['id'],1,'publish',1)
        archived=self.registry.lifecycle(first['id'],published['revision'],'archive',1)
        again=self.save(payload());self.assertTrue(again['archived']);self.assertEqual(again['status'],'PUBLISHED')
        self.assertEqual(again['revision'],archived['revision']);self.assertEqual(again['save_receipt']['revision'],1)
        with self.assertRaises((ValueError,ConfigConflict)):self.save(payload(revision=archived['revision']),first['id'],'fresh-key')
        self.assertEqual(len(again['versions']),1)

    def test_receipt_survives_restart_and_backup_restore(self):
        first=self.save(payload());root=Path(self.tmp.name);archive=root/'backup.zip';target=root/'restored'
        create_backup(root,archive);restore_backup(archive,target)
        restored=Application(target);self.addCleanup(restored.close)
        again=self.save(payload(),registry=restored.skills());self.assertEqual(again['id'],first['id']);self.assertEqual(again['package'],first['package'])

    def test_workspace_deleted_during_package_validation_blocks_the_commit(self):
        space=self.app.workspaces.save({'name':'保存时删除','description':'','business':'测试','scenario':'保存','revision':0})
        registry=self.app.scoped(space['id']).skills();original=skill_module.normalize_package;deleted=False
        def remove(*args,**kwargs):
            nonlocal deleted
            result=original(*args,**kwargs)
            if not deleted:deleted=True;self.app.workspaces.lifecycle(space['id'],1,True)
            return result
        with patch.object(skill_module,'normalize_package',side_effect=remove),self.assertRaises(KeyError):self.save(payload(),registry=registry)
        self.assertEqual(len(registry.list()),2)

    def test_corrupt_accepted_package_cannot_be_hidden_by_a_receipt(self):
        first=self.save(payload());corrupt=deepcopy(first['package']);corrupt['body']='tampered'
        with self.registry.store.transaction() as db:db.execute('UPDATE skill_versions SET data=? WHERE tenant=? AND workspace=? AND id=?',(canonical(corrupt),*self.registry.scope,first['id']))
        with self.assertRaises(ValueError):self.registry.save_request('skill-save-first',principal=self.app.principal)

    def test_receipt_cannot_reopen_a_deleted_workspace_and_survives_restoration(self):
        space=self.app.workspaces.save({'name':'保存后删除','description':'','business':'测试','scenario':'保存','revision':0})
        registry=self.app.scoped(space['id']).skills();first=self.save(payload(),registry=registry)
        self.app.workspaces.lifecycle(space['id'],1,True)
        with self.assertRaises(KeyError):self.save(payload(),registry=registry)
        with self.assertRaises(KeyError):registry.save_request('skill-save-first',principal=self.app.principal)
        self.app.workspaces.lifecycle(space['id'],2,False)
        again=self.save(payload(),registry=registry);self.assertEqual(again['id'],first['id']);self.assertEqual(len(again['versions']),1)

    def test_publication_after_a_workspace_deletion_cannot_commit(self):
        space=self.app.workspaces.save({'name':'发布时删除','description':'','business':'测试','scenario':'保存','revision':0})
        registry=self.app.scoped(space['id']).skills();first=self.save(payload(),registry=registry);get=registry.get
        def deleted_after_read(*args,**kwargs):
            record=get(*args,**kwargs);self.app.workspaces.lifecycle(space['id'],1,True);return record
        with patch.object(registry,'get',side_effect=deleted_after_read),self.assertRaises(KeyError):registry.lifecycle(first['id'],1,'publish',1)
        self.assertEqual(get(first['id'])['status'],'DRAFT')

    def test_legacy_saves_without_a_request_keep_the_existing_response(self):
        first=self.registry.save(payload());self.assertNotIn('save_receipt',first)
        self.assertEqual(first['version'],1);self.assertEqual(first['warnings'],[])


class SkillSaveHTTPTests(unittest.TestCase):
    setUp=web_tests.HTTPTests.setUp
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_http_retry_and_readonly_private_receipt_lookup(self):
        data={**payload(),'request_id':'http-skill-save'}
        status,_,raw=self.request('/api/skills','POST',json.dumps(data));self.assertEqual(status,201);first=json.loads(raw)
        status,_,raw=self.request('/api/skills','POST',json.dumps(data));self.assertEqual(status,201);self.assertEqual(json.loads(raw)['id'],first['id'])
        status,_,raw=self.request('/api/skill-saves/http-skill-save');self.assertEqual(status,200);self.assertEqual(json.loads(raw)['version'],1)
        other=Application(self.tmp.name,principal='another-user');self.addCleanup(other.close);self.server.application=other
        self.assertEqual(self.request('/api/skill-saves/http-skill-save')[0],404)

    def test_request_identifier_and_session_guards_remain_required(self):
        for key in ('',True,'../unsafe'):
            self.assertEqual(self.request('/api/skills','POST',json.dumps({**payload(),'request_id':key}))[0],400)
        status,_,raw=self.request('/api/skill-saves/unknown-request');self.assertEqual(status,404);self.assertEqual(json.loads(raw)['code'],'skill_save_not_found')

    def test_unavailable_workspace_is_not_reported_as_a_confirmed_missing_receipt(self):
        status,_,raw=self.request('/api/skill-saves/unknown-request',headers={'X-Agent-Workspace':'workspace-unavailable'})
        self.assertEqual(status,404);self.assertNotEqual(json.loads(raw).get('code'),'skill_save_not_found')


if __name__=='__main__':unittest.main()
