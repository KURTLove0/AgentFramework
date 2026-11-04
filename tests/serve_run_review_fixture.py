"""Real simulated write failures for read-only review presentation."""
import os
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application, Handler, WebServer


class ReviewHandler(Handler):
    def dispatch(self, mutation=False):
        if urlsplit(self.path).path != '/__test/run-review':
            return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:
            return self.reply(405, {'error': 'GET required'})
        return self.reply(200, {'cases': self.server.application.review_cases})


if __name__ == '__main__':
    directory = tempfile.mkdtemp(prefix='run-review-browser-', dir='/private/tmp')
    app = Application(directory)
    app.review_cases = []
    service = TaskConversations(app)
    for scenario, queued in [('unverifiable', True), ('tampered-draft', False), ('unverifiable', False)]:
        root = app.create({'runtime': 'mock', 'scenario': scenario, 'goal': '核对草稿的实际结果',
                           'grant': True, 'consent': True, 'start': False})['run']
        if queued:
            with patch.object(service, 'dispatch', return_value=False):
                service.append(root['run_id'], {'content': '核对后继续整理', 'request_id': 'queued', 'revision': 1})
        result = app.runtime().run(root['run_id'])
        assert result['status'] == 'NEEDS_REVIEW'
        app.review_cases.append({'id': root['run_id'], 'scenario': scenario, 'queued': queued,
                                 'conversation': queued or scenario == 'tampered-draft'})
    server = WebServer(('127.0.0.1', int(os.environ.get('RUN_REVIEW_PORT', '8799'))), app)
    server.RequestHandlerClass = ReviewHandler
    print('Isolated data: ' + directory, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()
