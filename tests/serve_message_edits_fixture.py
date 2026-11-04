"""Hold only synthetic task dispatch until the browser explicitly releases it."""
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from unittest.mock import patch

from agent_framework.definitions import default_definition
from agent_framework.model_catalog import ModelCatalog
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,Handler,WebServer


class QueueApp(Application):
    held=True
    def has_job_capacity(self,**kwargs):return not self.held and super().has_job_capacity(**kwargs)


class QueueHandler(Handler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/release-queue':return super().dispatch(mutation)
        self.guard(mutation)
        if not mutation:return self.reply(405,{'error':'POST required'})
        self.read_json_body('/__test/release-queue');app=self.server.application
        app.held=False;TaskConversations.tick(app)
        return self.reply(200,{'held':False})


if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='message-edits-browser-') as root,patch.object(ModelCatalog,'list',return_value={'models':[],'source':'fixture'}):
        app=QueueApp(root);agent=app.agents.save({'name':'排队编辑助手','description':'隔离验证','runtime':'mock','model':'builtin','options':{},'prompt':'按目标交付。','skills':[],'mcp_servers':[],'revision':0,'definition':default_definition('排队编辑助手','general-assistant@1.0.0')})
        roots=[];service=TaskConversations(app)
        for n in range(3):
            identity=app.start_task({'goal':'排队修改场景 '+str(n+1),'agent_id':agent['id'],'agent_revision':1,'request_id':'initial-'+str(n)},start=False)['run']['run_id']
            app.runtime().run(identity)
            service.append(identity,{'content':'周五 15 点开会','request_id':'queued-first','revision':1})
            service.append(identity,{'content':'随后整理会议记录','request_id':'queued-second','revision':2});roots.append(identity)
        output=Path(os.environ['MESSAGE_EDITS_OUTPUT']);output.mkdir(parents=True,exist_ok=True)
        (output/'fixture.json').write_text(json.dumps({'workspace':app.workspace['id'],'roots':roots}))
        server=WebServer(('127.0.0.1',int(os.environ['MESSAGE_EDITS_PORT'])),app);server.RequestHandlerClass=QueueHandler
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
