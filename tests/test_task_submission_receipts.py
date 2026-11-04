"""Submission lookup is durable, scoped and never starts work."""
import json
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.backups import create_backup,restore_backup
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests import test_web as web_tests
from tests.test_task_acceptance import agent_data


class SubmissionReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='submission-receipts-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=self.app.agents.save(agent_data())
        self.data={'goal':'核对已受理的目标','agent_id':self.agent['id'],'agent_revision':1,'request_id':'lookup-original'}

    def accept(self):return self.app.start_task(self.data,start=False)

    def test_initial_and_replayed_post_carry_the_same_identity_as_lookup(self):
        first=self.accept();second=self.accept();lookup=self.app.task_submission(self.data['request_id'])
        expected={'request_id':self.data['request_id'],'run_id':first['run']['run_id']}
        for result in (first,second,lookup):
            self.assertEqual(result['submission'],expected)
            self.assertEqual(result['run']['task']['goal'],self.data['goal'])
            self.assertEqual(result['run']['snapshot']['agent_profile']['id'],self.agent['id'])
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_internal_explicit_run_id_is_preserved_in_post_receipt(self):
        for _ in range(2):
            result=self.app.start_task(self.data,run_id='internal-task-receipt',start=False)
            self.assertEqual(result['submission'],{'request_id':self.data['request_id'],'run_id':'internal-task-receipt'})
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_lookup_reads_original_receipt_without_scheduling_or_audit_changes(self):
        first=self.accept();events=first['events']
        draft=self.app.save_task_draft({'revision':0,'draft':{'goal':'后来保存的草稿'}})
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('read dispatched work')),patch.object(TaskConversations,'register',side_effect=AssertionError('read registered work')),patch.object(self.app,'schedule',side_effect=AssertionError('read started work')):
            result=self.app.task_submission(self.data['request_id'])
        self.assertEqual(result['submission'],{'request_id':self.data['request_id'],'run_id':first['run']['run_id']})
        self.assertEqual(result['events'],events);self.assertEqual(result['task_draft'],draft)
        self.assertEqual(result['run']['status'],'CREATED')

    def test_completed_task_and_archived_agent_remain_queryable(self):
        first=self.accept();self.app.runtime().run(first['run']['run_id']);self.app.agents.archive(self.agent['id'],1)
        result=self.app.task_submission(self.data['request_id'])
        self.assertEqual(result['run']['status'],'SUCCEEDED');self.assertEqual(result['run']['snapshot']['agent_profile']['revision'],1)

    def test_changed_payload_with_original_request_cannot_create_a_second_task(self):
        first=self.accept()
        with self.assertRaises(ConfigConflict):self.app.start_task(self.data|{'goal':'回执未知时改过的目标'},start=False)
        result=self.app.task_submission(self.data['request_id'])
        self.assertEqual(result['run']['run_id'],first['run']['run_id']);self.assertEqual(result['run']['task']['goal'],self.data['goal'])
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_lookup_is_isolated_by_workspace_tenant_and_principal(self):
        self.accept();other=Application(self.tmp.name,principal='another-user');self.addCleanup(other.close)
        tenant=Application(self.tmp.name,tenant='another-tenant');self.addCleanup(tenant.close)
        space=self.app.workspaces.save({'name':'另一空间','description':'','business':'隔离','scenario':'核对','revision':0})
        for app in (other,tenant,self.app.scoped(space['id'])):
            with self.subTest(actor=app.principal,tenant=app.tenant,workspace=app.workspace['id']),self.assertRaises(KeyError):app.task_submission(self.data['request_id'])

    def test_unknown_or_invalid_request_does_not_create_records(self):
        with self.assertRaises(KeyError):self.app.task_submission('not-accepted')
        for value in ('../escape','',None,True):
            with self.assertRaises((ValueError,TypeError)):self.app.task_submission(value)
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_lookup_survives_service_restart_and_paired_backup_restore(self):
        first=self.accept();self.app.close();restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(restarted.task_submission(self.data['request_id'])['run']['run_id'],first['run']['run_id'])
        restored=tempfile.TemporaryDirectory(prefix='submission-restored-',dir='/private/tmp');self.addCleanup(restored.cleanup)
        from pathlib import Path
        backup=create_backup(self.tmp.name,Path(restored.name)/'backup')
        destination=Path(restored.name)/'restored';restore_backup(backup['backup'],destination)
        app=Application(destination);self.addCleanup(app.close)
        self.assertEqual(app.task_submission(self.data['request_id'])['run']['run_id'],first['run']['run_id'])


class SubmissionReceiptHTTPTests(unittest.TestCase):
    setUp=web_tests.HTTPTests.setUp
    tearDown=web_tests.HTTPTests.tearDown
    request=web_tests.HTTPTests.request

    def test_post_and_replayed_post_return_submission_identity(self):
        agent=self.app.agents.save(agent_data())
        data={'goal':'HTTP 提交回执','agent_id':agent['id'],'agent_revision':1,'request_id':'http-post-receipt'}
        with patch.object(TaskConversations,'dispatch'):
            for _ in range(2):
                status,_,body=self.request('/api/tasks','POST',json.dumps(data))
                self.assertEqual(status,202,body)
                result=json.loads(body)
                self.assertEqual(result['submission'],{'request_id':data['request_id'],'run_id':result['run']['run_id']})
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_receipt_route_and_session_trusted_identity(self):
        agent=self.app.agents.save(agent_data())
        first=self.app.start_task({'goal':'查回提交','agent_id':agent['id'],'agent_revision':1,'request_id':'http-receipt'},start=False)
        status,_,body=self.request('/api/task-submissions/http-receipt')
        self.assertEqual(status,200);self.assertEqual(json.loads(body)['run']['run_id'],first['run']['run_id'])
        status,_,body=self.request('/api/session');self.assertEqual(json.loads(body)['principal'],self.app.principal)
        self.assertEqual(self.request('/api/task-submissions/not-accepted')[0],404)
        self.assertEqual(self.request('/api/task-submissions/http-receipt','GET',headers={'Origin':'https://outside.example'})[0],403)
        self.assertEqual(self.request('/api/task-submissions/http-receipt','POST','{}')[0],404)
