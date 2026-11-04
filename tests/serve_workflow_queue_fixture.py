"""Disposable saturated queue; test-only controls are absent from the application."""
import os
import tempfile
import threading
from urllib.parse import urlsplit

from agent_framework.web import Application, Handler, WebServer
from tests.test_workflows import role


class QueueFixtureHandler(Handler):
    def dispatch(self, mutation=False):
        path = urlsplit(self.path).path
        if path not in ('/__test/fill-queue', '/__test/release-queue'):
            return super().dispatch(mutation)
        if not mutation:
            return self.reply(405, {'error': 'POST required'})
        self.guard(True)
        if int(self.headers.get('Content-Length', '0')) != 2 or self.rfile.read(2) != b'{}':
            return self.reply(400, {'error': 'empty object required'})
        app = self.server.application
        with app.lock:
            for key in list(app.jobs):
                if key.startswith('fixture-capacity-'):
                    del app.jobs[key]
            if path.endswith('fill-queue'):
                app.jobs.update({'fixture-capacity-' + str(i): {'active': True, 'cancel': threading.Event()} for i in range(16)})
        return self.reply(200, {'saturated': path.endswith('fill-queue')})


if __name__ == '__main__':
    root = tempfile.mkdtemp(prefix='workflow-queue-browser-', dir='/private/tmp')
    app = Application(root)
    role(app, '队列验收审核员')
    app.jobs.update({'fixture-capacity-' + str(i): {'active': True, 'cancel': threading.Event()} for i in range(16)})
    server = WebServer(('127.0.0.1', int(os.environ.get('WORKFLOW_QUEUE_PORT', '8799'))), app)
    server.RequestHandlerClass = QueueFixtureHandler
    print('Isolated data: ' + root, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()
