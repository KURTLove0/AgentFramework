"""Persistent contextual task conversations, FIFO execution, scope and recovery."""
from copy import deepcopy
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import TaskContract,PolicyDenied,canonical
from agent_framework.definitions import default_definition
from agent_framework.knowledge import Library
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime_config import ConfigConflict
from agent_framework.task_conversations import TaskConversations,HISTORY_BYTES
from agent_framework.web import Application,APIError

class ConversationFixture:
    def __init__(self):self.requests=[];self.entered=threading.Event();self.release=threading.Event();self.release.set();self.reply=None;self.failed_once=False
    def generate(self,transport,prompt,schema,config,timeout):
        request=json.loads(prompt[prompt.index('\n{')+1:]);self.requests.append(deepcopy(request));self.entered.set()
        if transport.progress:transport.progress({'kind':'summary','text':'PUBLIC_PROGRESS_NOT_MODEL_HISTORY','source':'fixture'})
        deadline=time.monotonic()+4
        while not self.release.wait(.02):
            if transport.should_cancel and transport.should_cancel():raise ModelError('task_cancelled')
            if time.monotonic()>deadline:raise RuntimeError('test barrier timed out')
        goal=request['context']['task']['goal'];context=request['context']['task'].get('conversation_context',{})
        if goal=='先追问时间' and not context.get('messages'):
            value={'kind':'request_input','summary':'会议安排在什么时候？','result':None}
        else:
            if goal=='失败一次' and not self.failed_once:self.failed_once=True;raise ModelError('model_timeout')
            value={'kind':'result','summary':'已按本轮消息继续完成。','result':{'title':'本轮回复','content':'本轮：'+goal+'\n原目标：'+context.get('goal',goal)+'\n前文消息数：'+str(len(context.get('messages',[]))),'citations':[],'limitations':[]}}
        if self.reply:value=self.reply(request,value)
        return json.dumps(value,ensure_ascii=False),{'usage':{'input_tokens':10,'output_tokens':5}}

class TaskConversationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='task-conversation-',dir='/private/tmp');self.addCleanup(self.temp.cleanup)
        self.app=Application(self.temp.name,lease_seconds=3,tool_timeout=.2);self.addCleanup(lambda:self.app.close())
        self.fixture=ConversationFixture();fixture=self.fixture
        self.catalog=patch.object(ModelCatalog,'list',return_value={'models':[{'id':'fixture','name':'Fixture','efforts':['low']}],'source':'fixture'})
        self.catalog.start();self.addCleanup(self.catalog.stop)
        self.transport=patch.object(CodexTransport,'generate',lambda transport,*args:fixture.generate(transport,*args))
        self.transport.start();self.addCleanup(self.transport.stop)
        self.agent=self.app.agents.save({'name':'对话助手','description':'持续交付任务结果','runtime':'codex','model':'fixture','options':{'timeout':5,'max_attempts':2,'reasoning_effort':'low'},
            'prompt':'使用自然中文，按用户最新要求修改已有结果。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('对话助手','general-assistant@1.0.0')})
        self.service=TaskConversations(self.app)
    def start(self,goal='会议定在周五下午三点'):
        return self.app.start_task({'goal':goal,'agent_id':self.agent['id'],'agent_revision':1,'request_id':'initial'})['run']['run_id']
    def wait(self,root,turn=1,status=None):
        deadline=time.monotonic()+6
        while time.monotonic()<deadline:
            detail=self.app.detail(root);turns=detail['conversation']['turns']
            if len(turns)>=turn:
                t=turns[turn-1];job=self.app.job(t['run_id'])
                if (not job or not job['active']) and t['status'] not in ('CREATED','RUNNING','QUEUED') and (not status or t['status']==status):return detail
            time.sleep(.02)
        self.fail('conversation did not settle: '+str([(t['number'],t['status'],t['error']) for t in self.app.detail(root)['conversation']['turns']]))
    def send(self,root,text='请根据前文继续修改',request='followup',revision=None):
        revision=revision or self.app.detail(root)['conversation']['revision']
        return self.service.append(root,{'content':text,'request_id':request,'revision':revision})
    def test_three_turns_share_task_and_pass_actual_history_to_model(self):
        root=self.start();first=self.wait(root);original=deepcopy(first['run']['snapshot'])
        self.assertEqual(json.loads(json.dumps(first))['conversation']['current']['run']['run_id'],root)
        self.send(root,'会议安排在几点？');second=self.wait(root,2)
        self.send(root,'把上面的安排写成一句话','third');third=self.wait(root,3)
        self.assertEqual(third['conversation']['id'],root);self.assertEqual(third['run']['run_id'],root)
        self.assertEqual(self.app.runs()['counts']['total'],1)
        context=self.fixture.requests[-1]['context']['task']['conversation_context']
        self.assertEqual(context['task_id'],root);self.assertEqual(context['turn'],3)
        self.assertEqual([m['role'] for m in context['messages']],['user','assistant','user','assistant'])
        self.assertEqual(context['messages'][0]['content'],'会议定在周五下午三点')
        self.assertEqual(context['messages'][1]['content'],first['run']['report']['content'])
        self.assertEqual(context['messages'][3]['content'],second['conversation']['turns'][1]['reply']['content'])
        self.assertNotIn('PUBLIC_PROGRESS_NOT_MODEL_HISTORY',canonical(context))
        self.assertEqual(self.app.runtime().store.load(self.app.tenant,root)['snapshot'],original)
        self.assertEqual(third['conversation']['model_calls'],3);self.assertEqual(third['conversation']['model_tokens'],45)
    def test_model_followup_question_is_answered_in_same_task(self):
        root=self.start('先追问时间');self.wait(root,status='WAITING_INPUT')
        self.send(root,'周五下午三点');detail=self.wait(root,2,'SUCCEEDED')
        history=self.fixture.requests[-1]['context']['task']['conversation_context']['messages']
        self.assertEqual(history[-1]['content'],'会议安排在什么时候？')
        self.assertIn('周五下午三点',detail['conversation']['turns'][1]['reply']['content'])
        self.assertEqual(self.app.runs()['counts']['total'],1)
    def test_pending_messages_are_ordered_and_cancellation_never_sends_them(self):
        self.fixture.release.clear();root=self.start();self.assertTrue(self.fixture.entered.wait(2))
        self.send(root,'第二轮要求','queued-second');third=self.send(root,'不应发送给模型','queued-third')
        self.assertEqual([t['status'] for t in third['conversation']['turns']][1:],['QUEUED','QUEUED'])
        self.assertEqual(len(self.fixture.requests),1)
        self.service.cancel_queued(root,3,{'revision':third['conversation']['revision']})
        self.fixture.release.set();detail=self.wait(root,2,'SUCCEEDED')
        self.assertEqual(len(self.fixture.requests),2)
        self.assertEqual(detail['conversation']['turns'][2]['status'],'CANCELLED')
        self.assertNotIn('不应发送给模型',canonical(self.fixture.requests[-1]))
        self.assertEqual(detail['conversation']['turns'][0]['reply']['content'],self.fixture.requests[-1]['context']['task']['conversation_context']['messages'][1]['content'])
    def test_message_idempotency_and_revision_conflicts_do_not_duplicate_turns(self):
        root=self.start();self.wait(root)
        self.send(root,'修改语气','stable',1);self.wait(root,2)
        duplicate=self.send(root,'修改语气','stable',1)
        self.assertEqual(len(duplicate['conversation']['turns']),2)
        with self.assertRaises(ConfigConflict):self.send(root,'不同消息','stable',2)
        with self.assertRaises(ConfigConflict):self.send(root,'其他消息','stale',1)
        self.assertEqual(len(self.app.detail(root)['conversation']['turns']),2)
    def test_scope_and_principal_cannot_read_or_append_other_conversations(self):
        root=self.start();self.wait(root)
        workspace=self.app.workspaces.save({'name':'另一空间','business':'服务','scenario':'日常','description':'','revision':0})
        with self.assertRaises(PolicyDenied):TaskConversations(self.app.scoped(workspace['id'])).append(root,{'content':'跨空间','request_id':'scope','revision':1})
        other=Application(self.temp.name,principal='another-user');self.addCleanup(other.close)
        with self.assertRaises(PolicyDenied):TaskConversations(other).view(root)
        with self.assertRaises(PolicyDenied):TaskConversations(other).append(root,{'content':'跨用户','request_id':'actor','revision':1})
    def test_frozen_agent_survives_edit_and_archive_for_existing_conversation(self):
        root=self.start();self.wait(root)
        data={k:deepcopy(self.agent[k]) for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')};data['revision']=1;data['prompt']='后来修改的另一套指令'
        changed=self.app.agents.save(data,self.agent['id']);self.app.agents.archive(self.agent['id'],changed['revision'])
        self.send(root);detail=self.wait(root,2)
        self.assertEqual(self.fixture.requests[-1]['context']['configured_agent']['prompt'],self.agent['prompt'])
        self.assertEqual(detail['conversation']['agent']['revision'],1)
    def test_failure_and_explicit_retry_keep_original_message_and_error(self):
        root=self.start('失败一次');self.wait(root,status='FAILED')
        self.send(root,'失败一次','retry');detail=self.wait(root,2,'SUCCEEDED')
        self.assertEqual(detail['conversation']['turns'][0]['status'],'FAILED')
        self.assertIn('model_timeout',detail['conversation']['turns'][0]['error'])
        self.assertEqual(detail['conversation']['turns'][1]['status'],'SUCCEEDED')
    def test_stop_current_turn_preserves_queued_followup(self):
        self.fixture.release.clear();root=self.start();self.assertTrue(self.fixture.entered.wait(2));self.send(root,'已明确排队的后续要求')
        self.app.mutate(root,'cancel');self.wait(root,1,'CANCELLED');self.fixture.release.set()
        detail=self.wait(root,2,'SUCCEEDED');self.assertEqual(detail['conversation']['turns'][0]['status'],'CANCELLED')
    def test_validates_messages_before_persisting_or_starting(self):
        root=self.start();self.wait(root)
        for data in ({'content':'','request_id':'bad','revision':1},{'content':' '*10,'request_id':'bad','revision':1},
                     {'content':'x'*16001,'request_id':'bad','revision':1},{'content':'hello','request_id':'','revision':1},
                     {'content':'hello','request_id':'bad','revision':True},{'content':'hello','request_id':'bad','revision':1,'grant':True}):
            with self.subTest(keys=list(data)),self.assertRaises((ValueError,TypeError)):self.service.append(root,data)
        self.assertEqual(len(self.app.detail(root)['conversation']['turns']),1)
    def test_queued_turn_and_history_resume_after_application_restart(self):
        root=self.start();self.wait(root)
        with patch.object(self.app,'schedule',side_effect=APIError(429,'queue full')):pending=self.send(root,'重启后继续处理')
        self.assertEqual(pending['conversation']['turns'][1]['status'],'CREATED')
        self.app.close();self.app=Application(self.temp.name,lease_seconds=3,tool_timeout=.2);self.service=TaskConversations(self.app)
        self.app.start_conversation_dispatcher();detail=self.wait(root,2,'SUCCEEDED')
        self.assertEqual(len(detail['conversation']['turns']),2)
        self.assertIn('会议定在周五下午三点',canonical(self.fixture.requests[-1]))
    def test_revoked_source_is_redacted_even_after_turn_context_has_been_frozen(self):
        library=Library(self.app.runtime().store);owner=self.app.library_access()
        source=library.create(owner,{'kind':'KNOWLEDGE','title':'会议规则','content':{'text':'HISTORY_PRIVATE_SOURCE_SENTINEL：周五下午三点。'}})
        library.transition(owner,source['ref'],'REVIEW');library.transition(owner,source['ref'],'PUBLISHED')
        def reply(request,result):
            if not request['context']['task'].get('conversation_context',{}).get('messages'):
                doc=next(d for d in request['context']['knowledge'] if d['ref']==source['ref'])
                result['result']['content']=doc['content']['text'];result['result']['citations']=[{'asset_ref':doc['ref'],'content_hash':doc['content_hash'],'quote':doc['content']['text'],'evidence_ref':request['context']['context_manifest']['id']}]
            return result
        self.fixture.reply=reply;root=self.start('会议规则');first=self.wait(root)
        self.assertEqual(first['run']['status'],'SUCCEEDED',first['run']['last_error']);self.assertIn('HISTORY_PRIVATE_SOURCE_SENTINEL',first['run']['report']['content'])
        with patch.object(self.app,'schedule'):pending=self.send(root,'继续解释前文')
        child=pending['conversation']['active_run_id'];frozen=self.app.runtime().store.load(self.app.tenant,child)
        self.assertIn('HISTORY_PRIVATE_SOURCE_SENTINEL',canonical(frozen['task']['conversation_context']))
        library.transition(owner,source['ref'],'WITHDRAWN');self.app.runtime().run(child)
        self.assertNotIn('HISTORY_PRIVATE_SOURCE_SENTINEL',canonical(self.fixture.requests[-1]))
        self.assertIn('来源已失效',canonical(self.fixture.requests[-1]))
        self.assertIn('HISTORY_PRIVATE_SOURCE_SENTINEL',self.app.detail(root)['conversation']['turns'][0]['reply']['content'])
    def test_plain_text_cli_replies_are_valid_conversation_messages(self):
        def plain(transport,prompt,schema,config,timeout):
            request=json.loads(prompt[prompt.index('\n{')+1:]);self.fixture.requests.append(request)
            if request['context']['task']['conversation_context']['turn']==1:text='已记住会议时间。'
            else:
                self.assertEqual(request['context']['task']['conversation_context']['messages'][1]['content'],'已记住会议时间。')
                text='会议定在周五下午三点。'
            return text,{'usage':{'input_tokens':10,'output_tokens':5}}
        with patch.object(CodexTransport,'generate',plain):
            root=self.start();first=self.wait(root,status='SUCCEEDED')
            self.assertEqual(first['run']['report']['content'],'已记住会议时间。')
            self.send(root,'会议安排在什么时候？');second=self.wait(root,2,'SUCCEEDED')
            self.assertEqual(second['conversation']['turns'][1]['reply']['content'],'会议定在周五下午三点。')

    def test_only_valid_fenced_protocol_is_normalized(self):
        from agent_framework.conversation_execution import normalize_reply
        value={'kind':'result','summary':'已确认。','result':{'title':'确认','content':'会议时间为 15:00。','citations':[],'limitations':[]}}
        for tag in ('json','JSON',''):
            self.assertEqual(normalize_reply('```'+tag+'\n'+json.dumps(value)+'\n```','确认会议'),value)
        for text in ('{broken','[broken','```json\n{broken\n```','```json\n{}\n```','```json\n'+json.dumps(value)):
            self.assertIsNone(normalize_reply(text,'确认会议'))
        self.assertIsNone(normalize_reply('```json\n{"kind":"result","kind":"result"}\n```','确认会议'))

    def test_history_budget_marks_omissions_and_preserves_original_goal(self):
        root=self.start();self.wait(root);state=self.service.root(root)
        rows=[{'number':n,'content':'历史消息 '+str(n),'run_id':root,'state':'RUNNING'} for n in range(1,130)]
        history=self.service.history(state,rows,130)
        self.assertLessEqual(len(history['messages']),200);self.assertGreater(history['omitted_messages'],0)
        self.assertEqual(history['goal'],state['task']['goal']);self.assertLessEqual(len(canonical(history['messages']).encode()),HISTORY_BYTES)
        TaskContract(domain_pack_ref=state['task']['domain_pack_ref'],execution_mode='conversation',conversation_context=history)

if __name__=='__main__':unittest.main()
