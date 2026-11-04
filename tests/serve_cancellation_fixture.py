"""Disposable, controllable stop drain and one cleanup failure; never production."""
import json
import os
import tempfile
import threading
import time
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,Handler,WebServer


class CancellationFixtureApplication(Application):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.stop_release=threading.Event();self.stop_observed=threading.Event();self.fail_cleanup=threading.Event();self.calls=[]

    def runtime(self,*args,**kwargs):
        runtime=super().runtime(*args,**kwargs);cancel=runtime.cancel
        def stop(*args,**kwargs):
            if getattr(self,'fail_cleanup',None) and self.fail_cleanup.is_set() and threading.current_thread().name.startswith('agent-stop'):
                self.fail_cleanup.clear();raise RuntimeError('PRIVATE_CANCELLATION_DETAIL')
            return cancel(*args,**kwargs)
        runtime.cancel=stop
        return runtime


class CancellationFixtureHandler(Handler):
    def dispatch(self,mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/stop-status','/__test/release-stop','/__test/drop-job','/__test/failing-root'):return super().dispatch(mutation)
        self.guard(mutation);app=self.server.application
        if path=='/__test/stop-status' and not mutation:
            return self.reply(200,{'task_id':app.fixture_root,'observed':app.stop_observed.is_set(),'calls':len(app.calls)})
        if not mutation:return self.reply(405,{'error':'POST required'})
        if int(self.headers.get('Content-Length','0'))!=2 or self.rfile.read(2)!=b'{}':return self.reply(400,{'error':'empty object required'})
        if path.endswith('release-stop'):app.stop_release.set()
        elif path.endswith('drop-job'):
            with app.lock:app.jobs.pop(app.fixture_root,None)
        elif path.endswith('failing-root'):
            state=app.create({'runtime':'mock','start':False,'goal':'停止处理失败后显式重试'})['run']
            app.runtime().run(state['run_id'],pause_after=1);app.fail_cleanup.set()
            return self.reply(200,{'task_id':state['run_id']})
        return self.reply(200,{'ok':True})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='cancellation-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'stop-fixture','name':'Stop fixture','efforts':['low']}],'source':'isolated fixture'}
    with patch.object(ModelCatalog,'list',return_value=catalog):
        app=CancellationFixtureApplication(root)
        def generate(transport,prompt,*args,**kwargs):
            request=json.loads(prompt[prompt.index('\n{')+1:]);task=request['context']['task'];app.calls.append(task['goal'])
            if task.get('conversation_context',{}).get('turn',1)>1:
                return json.dumps({'kind':'result','summary':'已处理明确排队的补充','result':{'title':'后续回复','content':'已继续处理：'+task['goal'],'citations':[],'limitations':[]}},ensure_ascii=False),{'usage':{'input_tokens':5,'output_tokens':5}}
            if transport.progress:transport.progress({'kind':'answer_text','text':'已保存的公开片段：正在整理第一项内容。','attempt':1})
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                if transport.should_cancel and transport.should_cancel():
                    app.stop_observed.set()
                    while not app.stop_release.wait(.02) and time.monotonic()<deadline:pass
                    raise ModelError('task_cancelled')
                time.sleep(.02)
            raise ModelError('model_timeout')
        with patch.object(CodexTransport,'generate',generate):
            agent=app.agents.save(dict(name='停止验收助手',description='合成模型',runtime='codex',model='stop-fixture',options={'timeout':60,'max_attempts':1,'reasoning_effort':'low'},prompt='按目标完成任务',skills=[],mcp_servers=[],revision=0,definition=default_definition('停止验收助手','general-assistant@1.0.0')))
            state=app.start_task({'goal':'验证停止意图与已保存片段','agent_id':agent['id'],'agent_revision':1,'request_id':'stop-fixture'},start=False)['run']
            TaskConversations(app).register(state);app.fixture_root=state['run_id']
            server=WebServer(('127.0.0.1',int(os.environ.get('CANCELLATION_PORT','8799'))),app);server.RequestHandlerClass=CancellationFixtureHandler
            print('Isolated data: '+root,flush=True)
            try:server.serve_forever()
            except KeyboardInterrupt:pass
            finally:app.stop_release.set();server.server_close();app.close()
