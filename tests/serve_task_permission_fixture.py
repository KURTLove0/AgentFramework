"""Disposable task permission fixture, including a real service reopen."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import urlsplit

from agent_framework.contracts import canonical,digest
from agent_framework.web import Application,WebServer
from tests.serve_workflow_queue_fixture import QueueFixtureHandler


class PermissionFixtureHandler(QueueFixtureHandler):
    def dispatch(self,mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/create-waiting','/__test/change-task-proposal','/__test/fail-next-executor'):return super().dispatch(mutation)
        if not mutation:return self.reply(405,{'error':'POST required'})
        self.guard(True);length=int(self.headers.get('Content-Length','0'))
        if not 1<=length<=1000:return self.reply(400,{'error':'invalid fixture payload'})
        data=json.loads(self.rfile.read(length));app=self.server.application
        if path.endswith('create-waiting'):
            identity=app.create({'start':False,'grant':False,'goal':'核对普通任务的写入提案'})['run']['run_id'];app.runtime().run(identity)
            return self.reply(200,app.detail(identity))
        if path.endswith('fail-next-executor'):
            app.fixture_reject_next=True;return self.reply(200,{'ready':True})
        state=app.control_store.result(app.tenant,data['run_id']);pending=next(a for a in state['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0')
        pending['args']['report']['summary']='隔离测试：新的提案内容，需要重新审查';pending['args_hash']=digest(pending['args'])
        with app.control_store.transaction() as db:db.execute('UPDATE actions SET data=? WHERE tenant_id=? AND run_id=? AND logical_id=?',(canonical(pending),app.tenant,state['run_id'],pending['logical_id']))
        return self.reply(200,app.detail(state['run_id']))


def prepare(root,port):
    app=Application(root);app.jobs.update({'fixture-capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
    app.fixture_reject_next=False;submit=app.pool.submit
    def executor(*args,**kwargs):
        if app.fixture_reject_next:app.fixture_reject_next=False;raise RuntimeError('synthetic executor failure')
        return submit(*args,**kwargs)
    app.pool.submit=executor
    server=WebServer(('127.0.0.1',port),app);server.RequestHandlerClass=PermissionFixtureHandler
    thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.02},daemon=True);thread.start();return app,server,thread


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='task-permission-browser-',dir='/private/tmp');port=int(os.environ['TASK_PERMISSION_PORT'])
    state=Path(os.environ['AUDIT_FIX_SEED']);state.parent.mkdir(parents=True,exist_ok=True);restart=state.parent/'restart-request';count=0
    app=server=thread=None
    try:
        while True:
            if server is None:
                app,server,thread=prepare(root,port);tmp=state.with_suffix('.tmp');tmp.write_text(json.dumps({'restarts':count,'data_dir':root}));tmp.replace(state)
            if restart.exists():
                restart.unlink();server.shutdown();server.server_close();thread.join(2);app.close();server=app=None;count+=1
            time.sleep(.05)
    except KeyboardInterrupt:pass
    finally:
        if server:server.shutdown();server.server_close();thread.join(2)
        if app:app.close()
