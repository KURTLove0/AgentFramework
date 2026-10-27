"""Verify partial text arrives before completion, persists, and replays over SSE."""
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.model_output_stream import ReplyStream,public_fields
from agent_framework.model_stream import PublicProgress
from agent_framework.web import Application,WebServer


class OutputStreamTests(unittest.TestCase):
    def test_incomplete_nested_json_streams_only_public_fields(self):
        text='{"private":{"summary":"HIDDEN"},"summary":"公开摘要","result":{"content":"第一段\\n第二段\\uD83D\\uDE00","private":"SECRET"}}'
        self.assertEqual(public_fields(text[:text.index('第二段')+2]),{'summary':'公开摘要','answer':'第一段\n第二'})
        result=public_fields(text);self.assertEqual(result,{'summary':'公开摘要','answer':'第一段\n第二段😀'})
        self.assertNotIn('HIDDEN',str(result));self.assertNotIn('SECRET',str(result))
        for n in range(6):
            self.assertNotIn('\ud83d',str(public_fields(text[:text.index('\\uD83D')+n])))

    def test_fenced_json_unicode_and_duplicate_snapshots_have_no_protocol_leak(self):
        updates=[];clock=[1.]
        stream=ReplyStream(updates.append,'answer',clock=lambda:clock[0])
        text='```json\n'+json.dumps({'kind':'result','summary':'公开摘要','result':{'content':'第一段\n第二段😀'}},ensure_ascii=True)+'\n```'
        for char in text:clock[0]+=.05;stream.append(char)
        stream.flush(force=True);count=len(updates);stream.snapshot(text)
        self.assertEqual(len(updates),count)
        self.assertEqual([u for u in updates if u['kind']=='answer_text'][-1]['text'],'第一段\n第二段😀')
        self.assertTrue(any(u['text']=='第' for u in updates));self.assertNotIn('"kind"',str(updates))

    def test_native_partial_events_never_promote_thinking_or_tool_arguments(self):
        updates=[];p=PublicProgress('qoder',updates.append)
        p.feed({'type':'stream_event','event':{'type':'message_start','message':{'id':'m'}}})
        for delta in ({'type':'thinking_delta','thinking':'PRIVATE_THOUGHT'}, {'type':'input_json_delta','partial_json':'PRIVATE_TOOL'}, {'type':'text_delta','text':'正在写第一段'}):
            p.feed({'type':'stream_event','event':{'type':'content_block_delta','index':1,'delta':delta}})
        p.flush();self.assertEqual([e for e in updates if e['kind']=='answer_text'][-1]['text'],'正在写第一段')
        self.assertNotIn('PRIVATE',json.dumps(updates))
        p.feed({'type':'reasoning_summary_delta','item_id':'s','delta':'正在整理'})
        p.feed({'type':'reasoning_summary_delta','item_id':'s','delta':'段落。'})
        self.assertEqual(updates[-1]['text'],'正在整理段落。')

    def test_flush_publishes_last_token_inside_throttle_window(self):
        updates=[];stream=ReplyStream(updates.append,'a',clock=lambda:1)
        stream.append('第一');stream.append('段');self.assertEqual(updates[-1]['text'],'第一')
        stream.flush(force=True);self.assertEqual(updates[-1]['text'],'第一段')

    def test_cursor_partial_and_both_duplicate_flush_forms_do_not_repeat_text(self):
        updates=[];p=PublicProgress('cursor',updates.append)
        def event(text,**metadata):return {'type':'assistant','message':{'content':[{'type':'text','text':text}]},**metadata}
        p.feed(event('第一段',timestamp_ms=1));p.feed(event('，继续。',timestamp_ms=2));p.flush()
        before=[u for u in updates if u['kind']=='answer_text'][-1]['text']
        p.feed(event('第一段，继续。',timestamp_ms=3,model_call_id='call-1'))
        p.feed(event('第一段，继续。'));p.flush()
        self.assertEqual(before,'第一段，继续。')
        self.assertEqual([u for u in updates if u['kind']=='answer_text'][-1]['text'],before)


class StreamingTaskTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='task-stream-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.release=threading.Event();self.addCleanup(self.release.set);self.partial=threading.Event();self.fail_model=False
        self.catalog=patch.object(ModelCatalog,'list',return_value={'models':[{'id':'stream-fixture','name':'Fixture','efforts':['low']}],'source':'fixture'});self.catalog.start();self.addCleanup(self.catalog.stop)
        self.transport=patch.object(CodexTransport,'generate',lambda transport,*args:self.generate(transport,*args));self.transport.start();self.addCleanup(self.transport.stop)
        self.agent=self.app.agents.save({'name':'流式助手','description':'隔离验证','runtime':'codex','model':'stream-fixture','options':{'timeout':5,'max_attempts':1,'reasoning_effort':'low'},'prompt':'直接交付结果。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('流式助手','general-assistant@1.0.0')})
    def generate(self,transport,prompt,schema,config,timeout):
        p=PublicProgress('qoder',transport.progress);p.feed({'type':'turn.started'})
        p.feed({'type':'reasoning_summary_delta','item_id':'summary','delta':'正在整理'})
        p.feed({'type':'reasoning_summary_delta','item_id':'summary','delta':'段落。'})
        p.feed({'type':'agent_message_delta','item_id':'answer','delta':'{"kind":"result","summary":"已整理","result":{"title":"建议","content":"第一段'});p.flush();self.partial.set()
        deadline=time.monotonic()+4
        while not self.release.wait(.02):
            if callable(transport.should_cancel) and transport.should_cancel():raise ModelError('task_cancelled')
            if time.monotonic()>deadline:raise RuntimeError('test release timed out')
        if self.fail_model:raise ModelError('model_timeout')
        p.feed({'type':'agent_message_delta','item_id':'answer','delta':'，继续完善。\\n第二段。","citations":[],"limitations":[]}}'});p.flush()
        return p.streams['answer'].raw,{'usage':{'input_tokens':10,'output_tokens':20}}
    def start(self):
        identity=self.app.start_task({'goal':'写两段建议','agent_id':self.agent['id'],'agent_revision':1,'request_id':'stream'})['run']['run_id'];self.assertTrue(self.partial.wait(2));return identity
    def wait(self,identity):
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            d=self.app.detail(identity)
            if d['run']['status'] not in ('CREATED','RUNNING') and not (self.app.job(identity) or {}).get('active'):return d
            time.sleep(.02)
        self.fail('did not finish')
    def test_answer_and_summary_exist_before_final_report_and_survive_reload(self):
        task=self.start();d=self.app.detail(task);turn=d['conversation']['turns'][0]
        self.assertEqual(turn['status'],'RUNNING');self.assertIsNone(turn['reply']);self.assertEqual(turn['preview']['content'],'第一段')
        self.assertTrue(any(p['text']=='正在整理段落。' for p in turn['progress']))
        restored=Application(self.tmp.name)
        try:self.assertEqual(restored.detail(task)['conversation']['turns'][0]['preview']['content'],'第一段')
        finally:restored.close()
        self.release.set();final=self.wait(task)['conversation']['turns'][0]
        self.assertEqual(final['status'],'SUCCEEDED');self.assertIsNone(final['preview']);self.assertEqual(final['reply']['content'],'第一段，继续完善。\n第二段。')
    def test_cancel_keeps_generated_fragments_marked_incomplete(self):
        task=self.start();self.app.mutate(task,'cancel');turn=self.wait(task)['conversation']['turns'][0]
        self.assertEqual(turn['status'],'CANCELLED');self.assertEqual(turn['preview']['content'],'第一段');self.assertIsNone(turn['reply'])

    def test_completion_between_detail_reads_refreshes_the_conversation(self):
        from agent_framework.task_conversations import TaskConversations
        task=self.start();stale=self.app.detail(task)['conversation']
        self.release.set();self.wait(task)
        original=TaskConversations.view;reads=[]
        def view(service,identity):
            reads.append(identity)
            return stale if len(reads)==1 else original(service,identity)
        with patch.object(TaskConversations,'view',view):detail=self.app.detail(task)
        self.assertEqual(detail['run']['status'],'SUCCEEDED')
        self.assertEqual(detail['conversation']['turns'][0]['status'],'SUCCEEDED')
        self.assertEqual(detail['conversation']['turns'][0]['reply'],detail['run']['report'])
    def test_failure_keeps_generated_fragments_marked_incomplete(self):
        self.fail_model=True;task=self.start();self.release.set();turn=self.wait(task)['conversation']['turns'][0]
        self.assertEqual(turn['status'],'FAILED');self.assertEqual(turn['preview']['content'],'第一段');self.assertIsNone(turn['reply'])
    def test_format_retry_replaces_rejected_preview_instead_of_appending_to_it(self):
        fields=('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')
        profile={k:self.agent[k] for k in fields};profile.update(name='格式重试助手',revision=0,options={'timeout':5,'max_attempts':2,'reasoning_effort':'low'})
        self.agent=self.app.agents.save(profile);attempts=[]
        def retry(transport,prompt,schema,config,timeout):
            attempts.append(1);p=PublicProgress('qoder',transport.progress)
            if len(attempts)==1:
                p.text('{"result":{"content":"旧的损坏片段','answer');p.flush();return '{"broken":',{'usage':{'input_tokens':1,'output_tokens':1}}
            p.text('{"kind":"result","summary":"已修复","result":{"title":"建议","content":"新的片段','answer');p.flush();self.partial.set()
            self.release.wait(3)
            raw='{"kind":"result","summary":"已修复","result":{"title":"建议","content":"新的片段，完整结果。","citations":[],"limitations":[]}}'
            return raw,{'usage':{'input_tokens':2,'output_tokens':2}}
        self.generate=retry;task=self.start();detail=self.app.detail(task)
        self.assertEqual(detail['conversation']['turns'][0]['preview']['content'],'新的片段')
        self.assertEqual(detail['run']['model_calls'],2)
        self.release.set();self.assertEqual(self.wait(task)['run']['report']['content'],'新的片段，完整结果。')
    def test_sse_delivers_partial_while_worker_is_blocked_then_final_without_new_request(self):
        server=WebServer(('127.0.0.1',0),self.app);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join()))
        task=self.start();conn=http.client.HTTPConnection('127.0.0.1',server.server_address[1],timeout=3);self.addCleanup(conn.close)
        conn.request('GET','/api/tasks/'+task+'/stream');response=conn.getresponse();self.assertEqual(response.status,200);self.assertIn('text/event-stream',response.getheader('Content-Type'))
        def read():
            while True:
                line=response.fp.readline().decode()
                if line.startswith('data: '):return json.loads(line[6:])
                if not line:self.fail('SSE ended without a snapshot')
        first=read();self.assertEqual(first['turns'][0]['preview']['content'],'第一段');self.assertEqual(first['status'],'RUNNING')
        self.release.set()
        while True:
            final=read()
            if final.get('status')=='SUCCEEDED':break
        self.assertEqual(final['turns'][0]['reply']['content'],'第一段，继续完善。\n第二段。')
        conn.close()


if __name__=='__main__':unittest.main()
