"""Controllable offline generators for multi-page responsiveness checks."""
from contextlib import contextmanager
import os
import tempfile
import threading
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.learning import agent_generate
from agent_framework.web import Application, Handler, WebServer
from agent_framework.workflow_chat import WorkflowChat


class Gates:
    def __init__(self):
        self.lock = threading.Lock()
        self.events = {name: threading.Event() for name in ('design', 'learning')}
        self.calls = []
        self.active = 0
        self.maximum = 0

    @contextmanager
    def model(self, name):
        with self.lock:
            self.calls.append(name)
            self.active += 1
            self.maximum = max(self.maximum, self.active)
        try:
            if name in self.events and not self.events[name].wait(120):
                raise RuntimeError('fixture generation gate was not released')
            yield
        finally:
            with self.lock: self.active -= 1

    def snapshot(self):
        with self.lock: return {'calls': list(self.calls), 'active': self.active, 'maximum': self.maximum}


gates = Gates()
original_design = WorkflowChat.mock


def design(message, prior, catalog):
    with gates.model('design' if message.startswith('fixture-hold-design') else 'other-design'):
        return original_design(message, prior, catalog)


def learning(app, profile, purpose, context, shape, consent, offline):
    if profile['runtime'] != 'mock': raise ValueError('This fixture only permits offline models')
    with gates.model('learning' if context.get('instruction') == 'fixture-hold-learning' else 'other-learning'):
        return agent_generate(app, profile, purpose, context, shape, consent, offline)


class FixtureHandler(Handler):
    def dispatch(self, mutation=False):
        if urlsplit(self.path).path != '/__test/proposal-gates': return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:
            data = self.read_json_body('/__test/proposal-gates')
            if set(data) != {'release'} or data['release'] not in gates.events:
                return self.reply(400, {'error': 'invalid fixture gate'})
            gates.events[data['release']].set()
        return self.reply(200, gates.snapshot())


if __name__ == '__main__':
    root = tempfile.mkdtemp(prefix='proposal-capacity-browser-', dir='/private/tmp')
    with patch.object(WorkflowChat, 'mock', side_effect=design), patch('agent_framework.learning.agent_generate', side_effect=learning):
        app = Application(root)
        server = WebServer(('127.0.0.1', int(os.environ['PROPOSAL_CAPACITY_PORT'])), app)
        server.RequestHandlerClass = FixtureHandler
        print('Isolated data: ' + root, flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass
        finally:
            for event in gates.events.values(): event.set()
            server.server_close()
            app.close()
