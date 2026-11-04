"""A real model child fails cleanup; its worker exits before the terminal save."""
import json
import os
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport
from agent_framework.model_catalog import ModelCatalog
from agent_framework.runtime import Runtime
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application,APIError,WebServer
from tests import serve_cleanup_failures_fixture as fixture


class RecoveryApp(Application):
    def schedule(self,identity,*,automatic=False):
        if automatic and identity==getattr(self,'fixture_root',None) and not self.fixture_started:
            raise APIError(409,'Fixture waits for explicit start')
        return super().schedule(identity,automatic=automatic)


class RecoveryHandler(fixture.CleanupHandler):
    def dispatch(self,mutation=False):
        if urlsplit(self.path).path!='/__test/cleanup-recovery':return super().dispatch(mutation)
        self.guard(mutation);app=self.server.application
        if mutation:
            with app.lock:
                if not app.fixture_started:app.fixture_started=True;app.schedule(app.fixture_root)
        return self.reply(200,{'root':app.fixture_root,'model_calls':len(fixture.calls),'crashes':len(crashes),
            'children':[{'running':p.poll() is None,'pipes_closed':all(pipe.closed for pipe in (p.stdin,p.stdout,p.stderr))} for p in fixture.children]})


if __name__=='__main__':
    crashes=[];original_checkpoint=Runtime.checkpoint
    def checkpoint(runtime,state,lease,kind,data=None,**kwargs):
        original_checkpoint(runtime,state,lease,kind,data,**kwargs)
        if kind=='model.cleanup_unconfirmed' and not crashes:
            crashes.append(state['run_id']);raise RuntimeError('PRIVATE_WORKER_EXIT_AFTER_CLEANUP')
    with tempfile.TemporaryDirectory(prefix='cleanup-recovery-browser-',dir='/private/tmp') as root:
        fixture.root=root;catalog={'models':[{'id':'cleanup-fixture','name':'Cleanup fixture','efforts':['low']}],'source':'isolated fixture'}
        with patch.object(ModelCatalog,'list',return_value=catalog),patch('agent_framework.codex_stream.subprocess.Popen',fixture.launch),patch.object(CodexTransport,'generate',fixture.generate),patch('agent_framework.codex_stream.stop_process_group',fixture.denied),patch.object(Runtime,'checkpoint',checkpoint):
            app=RecoveryApp(root);app.fixture_started=False
            fixture.agent=app.agents.save({'name':'中断收尾验收助手','description':'隔离进程中断恢复','runtime':'codex','model':'cleanup-fixture',
                'options':{'timeout':1,'max_attempts':2,'reasoning_effort':'low'},'prompt':'按目标整理材料。','skills':[],'mcp_servers':[],
                'revision':0,'definition':default_definition('中断收尾验收助手','general-assistant@1.0.0')})
            run=app.start_task({'goal':'保留清理中断前的错误和片段','agent_id':fixture.agent['id'],'agent_revision':1,'request_id':'cleanup-recovery-root'},start=False)['run'];app.fixture_root=run['run_id']
            with patch.object(TaskConversations,'dispatch',return_value=False):
                TaskConversations(app).append(run['run_id'],{'content':'环境检查后继续整理','request_id':'followup-after-cleanup','revision':1})
            server=WebServer(('127.0.0.1',int(os.environ.get('CLEANUP_RECOVERY_PORT','8799'))),app);server.RequestHandlerClass=RecoveryHandler
            try:server.serve_forever()
            except KeyboardInterrupt:pass
            finally:
                server.server_close();app.close()
                for child in fixture.children:fixture.stop_process_group(child)
