"""Disposable worker exception after a saved public fragment; no real model."""
import os
import tempfile
import threading
from urllib.parse import urlsplit

from agent_framework.web import Application,Handler,WebServer
from agent_framework.task_conversations import TaskConversations


class WorkerFixtureApplication(Application):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.fixture_failure=threading.Event();self.fixture_failure.set();self.fixture_attempts=[]

    def runtime(self,*args,**kwargs):
        runtime=super().runtime(*args,**kwargs);run=runtime.run
        def execute(run_id,tenant='tenant-demo',pause_after=None):
            self.fixture_attempts.append(run_id)
            if self.fixture_failure.is_set():
                self.fixture_failure.clear()
                lease=runtime.store.acquire(tenant,run_id,runtime.lease_seconds,expected_epoch=runtime.execution_epoch)
                runtime.execution_epoch=lease[1];state=runtime.store.load(tenant,run_id)
                try:
                    state['status']='RUNNING'
                    runtime.checkpoint(state,lease,'model.progress',{'kind':'answer_text','text':'已保存的公开片段：已核对第一项资料。','attempt':1})
                finally:runtime.store.release(state,lease)
                raise RuntimeError('PRIVATE_EXCEPTION_DETAIL_MUST_NOT_LEAK')
            return run(run_id,tenant,pause_after)
        runtime.run=execute
        return runtime


class WorkerFixtureHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/worker-root':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:return self.reply(405,{'error':'GET required'})
        app=self.server.application
        return self.reply(200,{'task_id':app.fixture_root,'attempts':len(app.fixture_attempts)})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='worker-recovery-browser-',dir='/private/tmp')
    app=WorkerFixtureApplication(root)
    run=app.create({'runtime':'mock','start':False,'goal':'保留中断前内容并恢复同一任务'})['run']
    TaskConversations(app).register(run);app.fixture_root=run['run_id']
    server=WebServer(('127.0.0.1',int(os.environ.get('WORKER_RECOVERY_PORT','8799'))),app)
    server.RequestHandlerClass=WorkerFixtureHandler
    print('Isolated data: '+root,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();app.close()
