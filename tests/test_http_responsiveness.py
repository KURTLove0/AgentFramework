"""Slow network/configuration work must not hold task-control locks."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import http.client
import json
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.agents import AgentRegistry
from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport, ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application, Handler, WebServer
from tests.test_workflows import definition, role


def profile():
    return dict(name='并发保存助手',description='离线验收',runtime='mock',model='builtin',options={},
                prompt='按目标交付',skills=[],mcp_servers=[],revision=0,
                definition=default_definition('并发保存助手','general-assistant@1.0.0'))


class HTTPResponsivenessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='http-controls-',dir='/private/tmp')
        self.app=Application(self.tmp.name,lease_seconds=.6,tool_timeout=.1)
        # Recovery behavior has its own tests; these requests run without a ticker
        # completing an operation on the handler's behalf.
        with patch.object(Application,'start_scheduler'),patch.object(Application,'start_conversation_dispatcher'):
            self.server=WebServer(('127.0.0.1',0),self.app)
        self.port=self.server.server_address[1]
        self.thread=threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.01},daemon=True)
        self.thread.start()
        self.clients=ThreadPoolExecutor(max_workers=3)

    def tearDown(self):
        self.clients.shutdown(wait=True)
        self.server.shutdown();self.server.server_close();self.app.close()
        self.thread.join(2);self.tmp.cleanup()

    def request(self,path,method='GET',data=None,headers=None,timeout=3):
        connection=http.client.HTTPConnection('127.0.0.1',self.port,timeout=timeout)
        fields={'Content-Type':'application/json','X-Agent-Token':self.app.token,**(headers or {})}
        try:
            connection.request(method,path,json.dumps(data) if data is not None else None,fields)
            response=connection.getresponse()
            return response.status,json.loads(response.read())
        finally:connection.close()

    def raw(self,path='/api/runs',*,lengths=('100',),body=b'{',extra=''):
        connection=socket.create_connection(('127.0.0.1',self.port),timeout=2)
        self.addCleanup(connection.close)
        headers=(f'POST {path} HTTP/1.0\r\nHost: 127.0.0.1:{self.port}\r\n'
                 f'Content-Type: application/json\r\nX-Agent-Token: {self.app.token}\r\n')
        headers+=''.join('Content-Length: '+value+'\r\n' for value in lengths)
        connection.sendall((headers+extra+'\r\n').encode()+body)
        return connection

    def raw_result(self,connection):
        response=http.client.HTTPResponse(connection);response.begin()
        return response.status,json.loads(response.read())

    @contextmanager
    def blocked_save(self):
        entered=threading.Event();release=threading.Event();prepare=AgentRegistry.prepare
        def slow(registry,*args,**kwargs):
            entered.set()
            if not release.wait(6):raise RuntimeError('test preflight was not released')
            return prepare(registry,*args,**kwargs)
        with patch.object(AgentRegistry,'prepare',slow):
            future=self.clients.submit(self.request,'/api/agents','POST',{**profile(),'request_id':'slow-save'})
            try:
                self.assertTrue(entered.wait(2),'save never reached configuration validation')
                yield future
            finally:
                release.set();future.result(4)

    @contextmanager
    def active_model(self):
        entered=threading.Event()
        def generate(transport,*args,**kwargs):
            entered.set();deadline=time.monotonic()+6
            while time.monotonic()<deadline:
                if transport.should_cancel and transport.should_cancel():raise ModelError('task_cancelled')
                time.sleep(.01)
            raise RuntimeError('test model was not stopped')
        with patch.object(ModelCatalog,'list',return_value={'models':[{'id':'fixture','efforts':['low']}]}),patch.object(CodexTransport,'generate',generate):
            data=profile();data.update(runtime='codex',model='fixture',options={'timeout':6,'max_attempts':1,'reasoning_effort':'low'})
            agent=self.app.agents.save(data)
            root=self.app.start_task({'goal':'等待本轮停止','agent_id':agent['id'],'agent_revision':1,'request_id':'active-model'})['run']['run_id']
            self.assertTrue(entered.wait(2))
            try:yield root
            finally:self.app.mutate(root,'cancel')

    def test_partial_upload_does_not_block_other_commands_or_stop(self):
        root=self.app.create({'start':False})['run']['run_id']
        entered=threading.Event();read=Handler.read_json_body
        def observed(handler,path):
            if path=='/api/runs':entered.set()
            return read(handler,path)
        with patch.object(Handler,'read_json_body',observed):
            connection=self.raw();self.assertTrue(entered.wait(2))
            try:
                status,_=self.request('/api/task-draft','POST',{'revision':0,'draft':{'goal':'接收未完成时保存草稿'}},timeout=1)
                self.assertEqual(status,200)
                status,result=self.request('/api/runs/'+root+'/cancel','POST',{},timeout=1)
                self.assertEqual(status,202);self.assertEqual(result['run']['status'],'CANCELLED')
            finally:connection.shutdown(socket.SHUT_WR)
            self.assertEqual(self.raw_result(connection)[0],400)
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_body_timeout_returns_408_without_creating_a_task(self):
        self.server.request_timeout=.2
        status,result=self.raw_result(self.raw())
        self.assertEqual(status,408);self.assertIn('超时',result['error'])
        self.assertEqual(self.app.runs()['counts']['total'],0)
        self.assertEqual(self.request('/api/runs','POST',{'start':False})[0],202)

    def test_trickling_upload_has_a_total_body_deadline(self):
        self.server.request_timeout=.25
        connection=self.raw();stop=threading.Event()
        def trickle():
            while not stop.wait(.04):
                try:connection.sendall(b' ')
                except OSError:return
        thread=threading.Thread(target=trickle,daemon=True);thread.start();started=time.monotonic()
        try:
            self.assertEqual(self.raw_result(connection)[0],408)
            self.assertLess(time.monotonic()-started,.8)
        finally:stop.set();thread.join(1)
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_truncated_or_ambiguous_bodies_cannot_mutate(self):
        connection=self.raw(lengths=('3',),body=b'{}');connection.shutdown(socket.SHUT_WR)
        self.assertEqual(self.raw_result(connection)[0],400)
        for lengths,extra in ((('2','2'),''),(('2','3'),''),(('2',),'Transfer-Encoding: chunked\r\n')):
            with self.subTest(lengths=lengths,extra=extra):
                self.assertEqual(self.raw_result(self.raw(lengths=lengths,body=b'{}',extra=extra))[0],400)
        self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_invalid_origin_is_rejected_without_waiting_for_body(self):
        status,_=self.raw_result(self.raw(extra='Origin: https://outside.example\r\n'))
        self.assertEqual(status,403);self.assertEqual(self.app.runs()['counts']['total'],0)

    def test_slow_agent_validation_does_not_block_active_worker_read_or_stop(self):
        with self.active_model() as root:
            with self.blocked_save():
                status,result=self.request('/api/runs/'+root,timeout=1)
                self.assertEqual(status,200);self.assertTrue(result['job']['active'])
                self.assertEqual(self.request('/api/runs',timeout=1)[0],200)
                status,result=self.request('/api/runs/'+root+'/cancel','POST',{},timeout=1)
                self.assertEqual(status,202);self.assertIsNotNone(result['cancellation'])
                deadline=time.monotonic()+2
                while time.monotonic()<deadline:
                    if not self.app.job(root)['active']:break
                    time.sleep(.01)
                self.assertFalse(self.app.job(root)['active'])
                self.assertEqual(self.app.control_store.load(self.app.tenant,root)['status'],'CANCELLED')

    def test_cancel_queued_message_during_slow_save_never_executes_it(self):
        with self.active_model() as root:
            service=TaskConversations(self.app)
            detail=service.append(root,{'content':'取消这条排队消息','request_id':'queued','revision':1})
            with self.blocked_save():
                status,result=self.request('/api/tasks/'+root+'/messages/2/cancel','POST',{'revision':detail['conversation']['revision']},timeout=1)
                self.assertEqual(status,200);self.assertEqual(result['conversation']['turns'][1]['status'],'CANCELLED')
                with self.app.control_store.connect() as db:
                    self.assertIsNone(db.execute('SELECT 1 FROM runs WHERE id=?',(result['conversation']['turns'][1]['run_id'],)).fetchone())

    def test_workflow_stop_is_persisted_while_configuration_validation_waits(self):
        agent=role(self.app);flows=self.app.workflows();saved=flows.save(definition([agent]))
        flow=flows.start(saved['id'],{'revision':1,'grant':False})
        with self.blocked_save():
            status,_=self.request('/api/workflow-runs/'+flow['id']+'/cancel','POST',{},timeout=1)
            self.assertEqual(status,202);self.assertTrue(flows.run(flow['id'])['cancel_requested'])

    def test_stop_still_checks_token_origin_workspace_and_body(self):
        root=self.app.create({'start':False})['run']['run_id']
        other=self.app.workspaces.save(dict(name='另一空间',description='',business='测试',scenario='隔离',revision=0))
        with self.blocked_save():
            path='/api/runs/'+root+'/cancel'
            for headers in ({'X-Agent-Token':''},{'Origin':'https://outside.example'},{'X-Agent-Workspace':other['id']}):
                self.assertEqual(self.request(path,'POST',{},headers,timeout=1)[0],403)
            self.assertEqual(self.request(path,'POST',{'unexpected':True},timeout=1)[0],400)
            self.assertIsNone(self.app.control_store.cancellation(self.app.tenant,root))

    def test_other_mutations_keep_their_order_while_stops_can_overtake(self):
        root=self.app.create({'start':False})['run']['run_id']
        with self.blocked_save():
            future=self.clients.submit(self.request,'/api/task-draft','POST',{'revision':0,'draft':{'goal':'顺序保存'}})
            self.assertEqual(self.request('/api/runs/'+root+'/cancel','POST',{},timeout=1)[0],202)
            self.assertFalse(future.done(),'ordinary writes must retain request serialization')
        self.assertEqual(future.result(2)[0],200)

    def test_waiting_response_does_not_hold_the_command_lock(self):
        entered=threading.Event();release=threading.Event();end=Handler.end_headers
        def slow(handler):
            if handler.command=='POST' and handler.path=='/api/agents':
                entered.set()
                if not release.wait(5):raise RuntimeError('test response not released')
            return end(handler)
        with patch.object(Handler,'end_headers',slow):
            future=self.clients.submit(self.request,'/api/agents','POST',profile())
            try:
                self.assertTrue(entered.wait(2))
                status,receipt=self.request('/api/task-draft','POST',{'revision':0,'draft':{'goal':'回复等待时保存'}},timeout=1)
                self.assertEqual(status,200);self.assertEqual(receipt['revision'],1)
            finally:release.set();future.result(4)

    def test_scheduler_external_work_uses_command_lock_without_blocking_stop(self):
        root=self.app.create({'start':False})['run']['run_id']
        entered=threading.Event();release=threading.Event()
        def tick(app):
            entered.set()
            if not release.wait(5):raise RuntimeError('test tick not released')
        with patch('agent_framework.workspace_scheduler.tick',tick):
            self.app.start_scheduler()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.request('/api/runs/'+root,timeout=1)[0],200)
                self.assertEqual(self.request('/api/runs/'+root+'/cancel','POST',{},timeout=1)[0],202)
            finally:release.set();self.app.scheduler_stop.set();self.app.scheduler_thread.join(2)

    def test_processing_error_is_not_mislabeled_as_upload_timeout_and_unlocks(self):
        with patch.object(self.app.configuration,'detect',side_effect=TimeoutError('synthetic operation timeout')):
            with self.assertLogs(level='ERROR'):
                status,result=self.request('/api/runtime-config/detect','POST',{'provider':'mock'})
        self.assertEqual(status,500);self.assertNotIn('正文',result['error'])
        self.assertEqual(self.request('/api/task-draft','POST',{'revision':0,'draft':{'goal':'异常后继续保存'}})[0],200)
