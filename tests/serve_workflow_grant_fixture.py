"""Synthetic approval changes; these controls are not application endpoints."""
import json
import os
import tempfile
import threading
from urllib.parse import urlsplit

from agent_framework.contracts import canonical,digest
from agent_framework.web import Application,WebServer
from tests.serve_workflow_queue_fixture import QueueFixtureHandler
from tests.test_workflows import role


class GrantFixtureHandler(QueueFixtureHandler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/replace-proposal':return super().dispatch(mutation)
        if not mutation:return self.reply(405,{'error':'POST required'})
        self.guard(True)
        length=int(self.headers.get('Content-Length','0'))
        if not 1<=length<=1000:return self.reply(400,{'error':'invalid fixture payload'})
        data=json.loads(self.rfile.read(length));app=self.server.application;flows=app.workflows()
        state=flows.run(data['run_id']);child=flows.current_child(state['nodes'][data['node_id']]['run_id'])
        pending=next(a for a in child['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0')
        logical=pending['logical_id'];pending['logical_id']+='-reviewed-again'
        pending['args']['report']['summary']='隔离测试：更新后的写入提案，需要重新审查。';pending['args_hash']=digest(pending['args'])
        with flows.store.transaction() as db:
            db.execute('UPDATE actions SET logical_id=?,data=? WHERE tenant_id=? AND run_id=? AND logical_id=?',
                       (pending['logical_id'],canonical(pending),app.tenant,child['run_id'],logical))
        return self.reply(200,app.flow_detail(state['id']))


if __name__=='__main__':
    root=tempfile.mkdtemp(prefix='workflow-grant-browser-',dir='/private/tmp')
    app=Application(root);role(app,'提案核对审核员')
    app.jobs.update({'fixture-capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
    server=WebServer(('127.0.0.1',int(os.environ.get('WORKFLOW_GRANT_PORT','8799'))),app);server.RequestHandlerClass=GrantFixtureHandler
    print('Isolated data: '+root,flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close();app.close()
