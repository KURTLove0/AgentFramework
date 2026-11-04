"""Synthetic mutable histories; test controls never ship with the application."""
import os
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, Handler, WebServer
from tests.test_workflow_catalog import seed_flows
from tests.test_evaluation_catalog import seed_evaluations
from tests.test_run_catalog import seed_history


class DynamicHandler(Handler):
    def dispatch(self, mutation=False):
        path=urlsplit(self.path).path
        if path not in ('/__test/advance-workflow','/__test/advance-evaluation'):return super().dispatch(mutation)
        if not mutation:return self.reply(405,{'error':'POST required'})
        self.guard(True)
        if int(self.headers.get('Content-Length','0'))!=2 or self.rfile.read(2)!=b'{}':return self.reply(400,{'error':'empty object required'})
        app=self.server.application
        with app.runtime().store.transaction() as db:
            if path.endswith('workflow'):
                db.execute("UPDATE workflow_runs SET data=json_set(data,'$.status','SUCCEEDED') WHERE id='catalog-flow-0000'")
            else:
                db.execute("UPDATE agent_evaluations SET data=json_set(data,'$.verdict','FAIL','$.score',40) WHERE id='catalog-evaluation-0000'")
        return self.reply(200,{'changed':True})


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='dynamic-pages-') as root,patch.object(ModelCatalog,'list',return_value={'models':[],'source':'isolated fixture'}):
        app=Application(root)
        seed_history(app,count=51,turns=1,body_bytes=64);seed_flows(app,count=51);seed_evaluations(app,count=51)
        with app.runtime().store.transaction() as db:
            db.execute("UPDATE workflow_runs SET data=json_set(data,'$.status','WAITING_INPUT')")
            db.execute("UPDATE agent_evaluations SET data=json_set(data,'$.verdict','PASS','$.score',100)")
        server=WebServer(('127.0.0.1',int(os.environ['PROJECT_REVIEW_PORT'])),app);server.RequestHandlerClass=DynamicHandler
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
