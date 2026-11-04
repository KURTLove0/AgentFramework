"""Task acceptance is atomic and idempotent across independent application views."""
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import digest
from agent_framework.definitions import default_definition
from agent_framework.runtime import Runtime
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application


class TaskSubmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='task-submission-',dir='/private/tmp')
        self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2)
        self.addCleanup(self.app.close)
        self.agent=self.app.agents.save({'name':'提交验收助手','description':'验证提交持久化','runtime':'mock','model':'builtin','options':{},
            'prompt':'按目标交付。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('提交验收助手','general-assistant@1.0.0')})
        self.payload={'goal':'整理本周工作','agent_id':self.agent['id'],'agent_revision':1,'request_id':'submission-first'}

    def run_id(self):
        return 'task-'+digest([self.app.tenant,self.app.workspace['id'],self.app.principal,self.payload['request_id']])[:32]

    def wait_for_success(self,identity):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            state=self.app.control_store.load(self.app.tenant,identity)
            if state['status']=='SUCCEEDED':return state
            time.sleep(.02)
        self.fail('Task did not finish: '+state['status'])

    def test_creator_exit_after_commit_before_receipt_still_recovers_original_task(self):
        program='''import json,os,sys
from agent_framework.runtime import Runtime
from agent_framework.web import Application
app=Application(sys.argv[1],lease_seconds=.5,tool_timeout=.2)
submit=Runtime.submit
def exit_after_commit(self,*args,**kwargs):
    submit(self,*args,**kwargs)
    os._exit(73)
Runtime.submit=exit_after_commit
app.start_task(json.loads(sys.argv[2]))
'''
        result=subprocess.run([sys.executable,'-c',program,self.tmp.name,json.dumps(self.payload)],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,73,result.stderr)
        restored=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(restored.close)
        with patch.object(restored,'schedule') as schedule:
            TaskConversations.tick(restored)
        schedule.assert_called_once_with(self.run_id(),automatic=True)
        run=restored.control_store.load(restored.tenant,self.run_id())
        self.assertEqual(run['task']['goal'],self.payload['goal'])
        self.assertEqual(run['snapshot']['agent_profile']['revision'],1)
        kinds=[event['kind'] for event in restored.control_store.events(restored.tenant,self.run_id())]
        self.assertEqual(kinds.count('task.created'),1)
        self.assertEqual(kinds.count('agent.selected'),1)
        self.app.agents.archive(self.agent['id'],1)
        TaskConversations.tick(restored)
        self.assertEqual(self.wait_for_success(self.run_id())['snapshot']['agent_profile'],run['snapshot']['agent_profile'])

    def test_acceptance_failure_rolls_back_task_registration_audit_and_draft_clear(self):
        draft=self.app.save_task_draft({'revision':0,'draft':{'goal':'尚未提交的草稿'}})
        register=TaskConversations.register
        def fail_after_registration(service,*args,**kwargs):
            register(service,*args,**kwargs)
            if kwargs.get('db') is not None:raise RuntimeError('atomic acceptance failed')
        with patch.object(TaskConversations,'register',fail_after_registration),patch.object(self.app,'schedule') as schedule:
            with self.assertRaisesRegex(RuntimeError,'atomic acceptance failed'):
                self.app.start_task({**self.payload,'clear_draft':True,'draft_revision':draft['revision']})
        schedule.assert_not_called()
        self.assertEqual(self.app.task_draft(),draft)
        with self.app.control_store.connect() as db:
            for table,field in (('runs','id'),('events','run_id'),('task_conversations','id'),('task_conversation_turns','task_id')):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table+' WHERE '+field+'=?',(self.run_id(),)).fetchone()[0],0)
        with patch.object(self.app,'schedule'):self.app.start_task({**self.payload,'clear_draft':True,'draft_revision':draft['revision']})
        self.assertIsNone(self.app.task_draft()['draft'])

    def test_replayed_receipt_does_not_delete_a_later_draft(self):
        draft=self.app.save_task_draft({'revision':0,'draft':{'goal':'第一次草稿'}})
        data={**self.payload,'clear_draft':True,'draft_revision':draft['revision']}
        self.app.start_task(data,start=False)
        self.assertIsNone(self.app.task_draft()['draft'])
        later=self.app.save_task_draft({'revision':self.app.task_draft()['revision'],'draft':{'goal':'另一个页面的新草稿'}})
        self.app.start_task(data,start=False)
        self.assertEqual(self.app.task_draft(),later)

    def test_manual_task_does_not_get_automatic_start_intent(self):
        self.app.start_task(self.payload,start=False)
        with patch.object(self.app,'schedule') as schedule:TaskConversations.tick(self.app)
        schedule.assert_not_called()
        self.assertEqual(self.app.control_store.load(self.app.tenant,self.run_id())['status'],'CREATED')

    def test_two_independent_views_retry_the_same_submission_without_duplicate_error(self):
        other=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        barrier=threading.Barrier(2);submit=Runtime.submit
        def simultaneous(runtime,*args,**kwargs):
            barrier.wait(timeout=10)
            return submit(runtime,*args,**kwargs)
        with patch.object(Runtime,'submit',simultaneous),ThreadPoolExecutor(max_workers=2) as pool:
            attempts=[pool.submit(app.start_task,self.payload,start=False) for app in (self.app,other)]
            replies=[attempt.result(timeout=15) for attempt in attempts]
        self.assertEqual([reply['run']['run_id'] for reply in replies],[self.run_id()]*2)
        self.assertEqual(self.app.runs()['counts']['total'],1)
        self.assertEqual(sum(e['kind']=='task.created' for e in self.app.control_store.events(self.app.tenant,self.run_id())),1)

    def test_simultaneous_start_requests_execute_only_once(self):
        other=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        barrier=threading.Barrier(2);submit=Runtime.submit
        def simultaneous(runtime,*args,**kwargs):
            barrier.wait(timeout=10)
            return submit(runtime,*args,**kwargs)
        with patch.object(Runtime,'submit',simultaneous),ThreadPoolExecutor(max_workers=2) as pool:
            replies=[pool.submit(app.start_task,self.payload) for app in (self.app,other)]
            self.assertEqual([reply.result(timeout=15)['run']['run_id'] for reply in replies],[self.run_id()]*2)
        self.wait_for_success(self.run_id())
        kinds=[e['kind'] for e in self.app.control_store.events(self.app.tenant,self.run_id())]
        self.assertEqual(kinds.count('task.created'),1)
        self.assertEqual(kinds.count('execution.started'),1)

    def test_conflicting_simultaneous_payload_cannot_reuse_another_tasks_receipt(self):
        other=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        barrier=threading.Barrier(2);submit=Runtime.submit
        def simultaneous(runtime,*args,**kwargs):
            barrier.wait(timeout=10)
            return submit(runtime,*args,**kwargs)
        data=[self.payload,{**self.payload,'goal':'不同目标'}]
        with patch.object(Runtime,'submit',simultaneous),ThreadPoolExecutor(max_workers=2) as pool:
            attempts=[pool.submit(app.start_task,payload,start=False) for app,payload in zip((self.app,other),data)]
            results=[]
            for attempt in attempts:
                try:results.append(attempt.result(timeout=15))
                except ConfigConflict:results.append(None)
        self.assertEqual(sum(result is not None for result in results),1)
        winner=next(result for result in results if result is not None)
        self.assertEqual(self.app.control_store.load(self.app.tenant,self.run_id())['task']['goal'],winner['run']['task']['goal'])

    def completed_thread(self):
        root=self.app.start_task(self.payload,start=False)['run']
        self.app.runtime().run(root['run_id'])
        service=TaskConversations(self.app)
        with patch.object(service,'dispatch',return_value=False):
            detail=service.append(root['run_id'],{'content':'补充下一轮要求','request_id':'followup','revision':1})
        return service,detail

    def test_followup_creation_and_turn_audit_commit_together_before_receipt(self):
        service,detail=self.completed_thread();submit=Runtime.submit
        def exit_after_commit(runtime,*args,**kwargs):
            submit(runtime,*args,**kwargs)
            raise RuntimeError('creator exited after commit')
        with patch.object(Runtime,'submit',exit_after_commit),self.assertRaisesRegex(RuntimeError,'creator exited'):
            service.dispatch(detail['conversation']['id'])
        turn=service.rows(detail['run'])[1]
        self.assertEqual(turn['state'],'RUNNING')
        events=self.app.control_store.events(self.app.tenant,turn['run_id'])
        self.assertEqual(sum(e['kind']=='conversation.turn_created' for e in events),1)

    def test_materialized_turn_wins_against_a_stale_cancel_queue_read(self):
        service,detail=self.completed_thread();root=detail['conversation']['id']
        other=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        loaded=service.loaded
        def start_after_read(row):
            result=loaded(row)
            if row['number']==2:
                with patch.object(other,'schedule'):TaskConversations(other).dispatch(root)
            return result
        with patch.object(service,'loaded',side_effect=start_after_read),self.assertRaises(ConfigConflict):
            service.cancel_queued(root,2,{'revision':detail['conversation']['revision']})
        self.assertEqual(service.rows(detail['run'])[1]['state'],'RUNNING')

    def test_cancelled_queue_wins_before_materialization_transaction(self):
        service,detail=self.completed_thread();root=detail['conversation']['id'];submit=Runtime.submit
        other=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        def cancel_before_commit(runtime,*args,**kwargs):
            TaskConversations(other).cancel_queued(root,2,{'revision':detail['conversation']['revision']})
            return submit(runtime,*args,**kwargs)
        with patch.object(Runtime,'submit',cancel_before_commit),patch.object(self.app,'schedule') as schedule:
            service.dispatch(root)
        turn=service.rows(detail['run'])[1]
        self.assertEqual(turn['state'],'CANCELLED')
        with self.assertRaises(KeyError):self.app.control_store.load(self.app.tenant,turn['run_id'])
        schedule.assert_not_called()

    def test_late_preparation_error_does_not_overwrite_cancelled_queue(self):
        service,detail=self.completed_thread();root=detail['conversation']['id']
        other=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(other.close)
        def fail_after_cancellation(*args,**kwargs):
            TaskConversations(other).cancel_queued(root,2,{'revision':detail['conversation']['revision']})
            raise ValueError('preparation failed')
        with patch.object(Runtime,'submit',side_effect=fail_after_cancellation):service.dispatch(root)
        self.assertEqual(service.rows(detail['run'])[1]['state'],'CANCELLED')


if __name__=='__main__':unittest.main()
