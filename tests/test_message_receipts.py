"""Message lookup preserves accepted identity without advancing conversations."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.backups import create_backup,restore_backup
from agent_framework.contracts import PolicyDenied
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application
from tests.test_task_acceptance import agent_data
from tests import test_web as fixtures


class MessageReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.agent=self.app.agents.save(agent_data())
        self.identity=self.app.start_task({'goal':'原任务','agent_id':self.agent['id'],'agent_revision':1,'request_id':'original'},start=False)['run']['run_id']
        self.service=TaskConversations(self.app);self.payload={'content':'原补充消息','request_id':'message-original','revision':1}

    def accept(self):
        with patch.object(TaskConversations,'dispatch',return_value=False):return self.service.append(self.identity,self.payload)

    def test_lookup_is_read_only_and_returns_exact_accepted_message(self):
        before=self.accept();events=before['events'];revision=before['conversation']['revision']
        with patch.object(TaskConversations,'dispatch',side_effect=AssertionError('read dispatched')),patch.object(TaskConversations,'register',side_effect=AssertionError('read registered')),patch.object(self.app,'schedule',side_effect=AssertionError('read scheduled')):
            result=self.service.message_submission(self.identity,self.payload['request_id'])
        self.assertEqual(result['submission']['content'],self.payload['content']);self.assertEqual(result['submission']['turn'],2)
        self.assertEqual(result['detail']['conversation']['revision'],revision);self.assertEqual(result['detail']['events'],events)
        self.assertIsNone(self.app.job(result['submission']['run_id']))

    def test_missing_lookup_does_not_register_or_create_message(self):
        before=self.app.detail(self.identity)
        for request in ('missing','initial-'+self.identity):
            with self.assertRaises(KeyError):self.service.message_submission(self.identity,request)
        for value in ('../escape','',None,True):
            with self.assertRaises((ValueError,TypeError)):self.service.message_submission(self.identity,value)
        self.assertEqual(self.app.detail(self.identity)['events'],before['events']);self.assertEqual(len(self.service.rows(self.service.root(self.identity))),1)

    def test_receipt_remains_available_when_post_commit_dispatch_fails(self):
        with patch.object(TaskConversations,'dispatch',side_effect=RuntimeError('synthetic handoff failure')):
            with self.assertRaises(RuntimeError):self.service.append(self.identity,self.payload)
        found=self.service.message_submission(self.identity,self.payload['request_id'])
        self.assertEqual(found['submission']['turn'],2);self.assertEqual(found['detail']['conversation']['queued_count'],1)
        self.accept();self.assertEqual(len(self.service.rows(self.service.root(self.identity))),2)

    def test_receipt_survives_cancelled_queue_and_cannot_revive_message(self):
        accepted=self.accept();self.service.cancel_queued(self.identity,2,{'revision':accepted['conversation']['revision']})
        receipt=self.service.message_submission(self.identity,self.payload['request_id'])
        self.assertTrue(receipt['detail']['conversation']['turns'][1]['cancelled_queue'])
        self.accept();self.assertEqual(len(self.service.rows(self.service.root(self.identity))),2)
        self.assertTrue(self.app.detail(self.identity)['conversation']['turns'][1]['cancelled_queue'])

    def test_late_acceptance_uses_same_identity_after_missing_lookup(self):
        with self.assertRaises(KeyError):self.service.message_submission(self.identity,self.payload['request_id'])
        first=self.accept();second=self.accept()
        self.assertEqual(first['conversation']['revision'],second['conversation']['revision'])
        with self.assertRaises(ConfigConflict),patch.object(TaskConversations,'dispatch',return_value=False):
            self.service.append(self.identity,self.payload|{'content':'改过的文字','revision':2})
        self.assertEqual(len(self.service.rows(self.service.root(self.identity))),2)

    def test_lookup_is_scoped_to_owner_tenant_and_workspace(self):
        self.accept();other=Application(self.tmp.name,principal='someone-else');self.addCleanup(other.close)
        tenant=Application(self.tmp.name,tenant='other-tenant');self.addCleanup(tenant.close)
        space=self.app.workspaces.save({'name':'其他空间','description':'','business':'测试','scenario':'核对','revision':0})
        for app in (other,tenant,self.app.scoped(space['id'])):
            with self.subTest(principal=app.principal,tenant=app.tenant),self.assertRaises((PolicyDenied,KeyError)):
                TaskConversations(app).message_submission(self.identity,self.payload['request_id'])

    def test_receipt_survives_restart_and_backup_restore(self):
        self.accept();expected=self.service.message_submission(self.identity,self.payload['request_id'])['submission'];self.app.close()
        restarted=Application(self.tmp.name);self.addCleanup(restarted.close)
        self.assertEqual(TaskConversations(restarted).message_submission(self.identity,self.payload['request_id'])['submission'],expected)
        output=Path(self.tmp.name)/'backup';backup=create_backup(self.tmp.name,output);destination=Path(self.tmp.name)/'restored'
        restore_backup(backup['backup'],destination);restored=Application(destination);self.addCleanup(restored.close)
        self.assertEqual(TaskConversations(restored).message_submission(self.identity,self.payload['request_id'])['submission'],expected)


class MessageReceiptHTTPTests(unittest.TestCase):
    setUp=fixtures.HTTPTests.setUp
    tearDown=fixtures.HTTPTests.tearDown
    request=fixtures.HTTPTests.request

    def test_http_lookup_and_static_recovery_module(self):
        agent=self.app.agents.save(agent_data());root=self.app.start_task({'goal':'HTTP 核对','agent_id':agent['id'],'agent_revision':1,'request_id':'http-root'},start=False)['run']['run_id']
        endpoint='/api/tasks/'+root+'/message-submissions/http-message'
        self.assertEqual(self.request(endpoint)[0],404)
        with patch.object(TaskConversations,'dispatch',return_value=False):
            self.assertEqual(self.request('/api/tasks/'+root+'/messages','POST',json.dumps({'content':'HTTP 原消息','request_id':'http-message','revision':1}))[0],202)
        status,_,body=self.request(endpoint);self.assertEqual(status,200);self.assertEqual(json.loads(body)['submission']['content'],'HTTP 原消息')
        self.assertEqual(self.request('/task_message.js')[0],200)


if __name__=='__main__':unittest.main()
