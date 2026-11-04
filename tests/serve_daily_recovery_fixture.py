"""Disposable daily queue with one injectable executor rejection, never production."""
import os
import tempfile
import threading
from urllib.parse import urlsplit

from agent_framework.web import Application, WebServer
from tests.serve_workflow_queue_fixture import QueueFixtureHandler
from tests.test_workflows import role


class DailyFixtureApplication(Application):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.fail_next_start=threading.Event()

    def schedule(self,run_id,*,automatic=False):
        if self.fail_next_start.is_set():
            self.fail_next_start.clear()
            raise RuntimeError('模拟执行器暂时不可用')
        return super().schedule(run_id,automatic=automatic)


class DailyFixtureHandler(QueueFixtureHandler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/fail-next-start':return super().dispatch(mutation)
        if not mutation:return self.reply(405,{'error':'POST required'})
        self.guard(True)
        if int(self.headers.get('Content-Length','0'))!=2 or self.rfile.read(2)!=b'{}':return self.reply(400,{'error':'empty object required'})
        with self.server.application.lock:self.server.application.fail_next_start.set()
        return self.reply(200,{'fail_next_start':True})


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='daily-recovery-browser-',dir='/private/tmp')
    app=DailyFixtureApplication(root);role(app,'每日任务验收员')
    app.jobs.update({'fixture-capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
    server=WebServer(('127.0.0.1',int(os.environ.get('DAILY_RECOVERY_PORT','8799'))),app)
    server.RequestHandlerClass=DailyFixtureHandler
    print('Isolated data: '+root,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();app.close()
