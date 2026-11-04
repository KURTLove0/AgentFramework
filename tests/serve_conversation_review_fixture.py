"""Hold an initial task until the browser has queued a followup and saved a draft."""
import os
import tempfile
from urllib.parse import urlsplit
from unittest.mock import patch

from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application, Handler, WebServer


class ReviewApplication(Application):
    def schedule(self, run_id, **kwargs):
        if run_id == self.fixture_root and self.control_store.load(self.tenant, run_id)['status'] == 'CREATED':
            return
        return super().schedule(run_id, **kwargs)


class ReviewHandler(Handler):
    def dispatch(self, mutation=False):
        path = urlsplit(self.path).path
        if path not in ('/__test/review', '/__test/settle-review'):
            return super().dispatch(mutation)
        self.guard(mutation)
        app = self.server.application
        if path == '/__test/review' and not mutation:
            return self.reply(200, {'root': app.fixture_root, 'authorization': app.fixture_auth})
        if path != '/__test/settle-review' or not mutation:
            return self.reply(405, {'error': 'method not allowed'})
        if int(self.headers.get('Content-Length', '0')) != 2 or self.rfile.read(2) != b'{}':
            return self.reply(400, {'error': 'empty object required'})
        result = app.runtime().run(app.fixture_root)
        assert result['status'] == 'NEEDS_REVIEW'
        app._advance_conversation(app.fixture_root)
        return self.reply(200, app.detail(app.fixture_root))


if __name__ == '__main__':
    root = tempfile.mkdtemp(prefix='conversation-review-browser-', dir='/private/tmp')
    app = ReviewApplication(root)
    service = TaskConversations(app)
    task = app.create({'runtime': 'mock', 'scenario': 'unverifiable', 'goal': '核对无法确认的业务草稿',
                       'consent': True, 'grant': True, 'start': False})['run']
    app.fixture_root = task['run_id']
    service.register(task)
    auth = app.create({'runtime': 'mock', 'goal': '确认业务操作授权', 'grant': False, 'start': False})['run']
    app.fixture_auth = auth['run_id']
    with patch.object(service, 'dispatch', return_value=False):
        service.append(app.fixture_auth, {'content': '授权完成后继续解释', 'request_id': 'auth-queued', 'revision': 1})
    assert app.runtime().run(app.fixture_auth)['status'] == 'WAITING_AUTH'
    server = WebServer(('127.0.0.1', int(os.environ.get('CONVERSATION_REVIEW_PORT', '8799'))), app)
    server.RequestHandlerClass = ReviewHandler
    print('Isolated data: ' + root, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()
