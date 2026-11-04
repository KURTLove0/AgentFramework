"""Disposable native-event streaming fixture; never points at everyday data."""
import json
import os
import tempfile
import threading
import time
from unittest.mock import patch
from urllib.parse import urlsplit
from agent_framework.llm import CodexTransport,CursorTransport,QoderTransport,ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.model_stream import PublicProgress
from agent_framework.web import Application,Handler,WebServer

stream_hold=threading.Event()
stream_held=threading.Event()
stream_fault=False
stream_generation=0


class StreamFixtureHandler(Handler):
    def stream_task(self,app,identity):
        self.stream_generation=stream_generation
        if stream_fault:return self.reply(503,{'error':'Synthetic stream outage','code':'stream_capacity_full'})
        return super().stream_task(app,identity)

    def _stream_peer_closed(self):
        return self.stream_generation!=stream_generation or super()._stream_peer_closed()

    def dispatch(self,mutation=False):
        global stream_fault,stream_generation
        path=urlsplit(self.path).path
        if path not in ('/__test/stream-hold','/__test/stream-release','/__test/stream-note','/__test/stream-state','/__test/stream-fault'):return super().dispatch(mutation)
        self.guard(mutation)
        if path.endswith('stream-state') and not mutation:return self.reply(200,{'held':stream_held.is_set(),'streams':self.server.application.stream_capacity.active,'stream_limit':self.server.application.stream_capacity.limit,'rejecting':stream_fault})
        if not mutation:return self.reply(405,{'error':'POST required'})
        data=self.read_json_body(path);app=self.server.application
        if path.endswith('stream-hold'):stream_hold.set()
        elif path.endswith('stream-release'):stream_hold.clear()
        elif path.endswith('stream-fault'):stream_fault=bool(data['enabled']);stream_generation+=1
        elif path.endswith('stream-note'):
            state=app.control_store.load(app.tenant,data['run_id']);app.assert_run_access(state)
            with app.control_store.transaction() as db:app.control_store.event(db,app.tenant,state['run_id'],'model.progress',{'kind':'status','text':data.get('text','已完成额外的公开校验')})
        return self.reply(200,{'ok':True})


def generate(transport,prompt,schema,config,timeout):
    request=json.loads(prompt[prompt.index('\n{')+1:]);goal=request['context']['task']['goal']
    p=PublicProgress('qoder',getattr(transport,'progress',None) or (lambda data:None))
    def wait(seconds):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            if callable(getattr(transport,'should_cancel',None)) and transport.should_cancel():raise ModelError('task_cancelled')
            while stream_hold.is_set():
                stream_held.set()
                if callable(getattr(transport,'should_cancel',None)) and transport.should_cancel():raise ModelError('task_cancelled')
                time.sleep(.02)
            stream_held.clear()
            time.sleep(.02)
    p.feed({'type':'turn.started'})
    p.feed({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'thinking_delta','thinking':'PRIVATE_STREAM_SENTINEL'}}})
    for chunk in ('正在核对','已提供的要求，','随后逐段整理','可使用的内容。'):
        p.feed({'type':'reasoning_summary_delta','item_id':'public-summary','delta':chunk});wait(.25)
    body='第一段：入口种植低矮植物，保留清晰的视线。\n\n第二段：沿步道安排休息座椅，方便停留。\n\n第三段：采用柔和照明，并预留维护通道。\n\n**结语**：让花园易用、舒适且便于照料。😀\n\n<img src=x onerror="window.__streamXss=1">'
    value={'kind':'result','summary':'已整理花园设计建议。','result':{'title':'花园建议','content':body,'citations':[],'limitations':[]}}
    raw=json.dumps(value,ensure_ascii=True)
    for n in range(0,len(raw),12):
        p.feed({'type':'stream_event','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':raw[n:n+12]}}})
        if '失败' in goal and n>len(raw)//2:raise ModelError('model_timeout')
        wait(.1 if '慢速' in goal else .05)
    p.flush();wait(.8);p.feed({'type':'result','result':raw,'is_error':False})
    return raw,{'usage':{'input_tokens':20,'output_tokens':60}}


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='task-stream-browser-',dir='/private/tmp')
    catalog={'models':[{'id':'stream-fixture','name':'Stream fixture','efforts':['low'],'default_effort':'low'}],'source':'isolated fixture','cached':False}
    with patch.object(ModelCatalog,'list',return_value=catalog),patch.object(CodexTransport,'generate',generate),patch.object(CursorTransport,'generate',generate),patch.object(QoderTransport,'generate',generate):
        app=Application(root);server=WebServer(('127.0.0.1',int(os.environ.get('TASK_STREAM_PORT','8799'))),app);server.RequestHandlerClass=StreamFixtureHandler;print('Fixture data: '+root,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:stream_hold.clear();server.server_close();app.close()
