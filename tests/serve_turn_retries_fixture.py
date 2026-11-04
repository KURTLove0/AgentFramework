"""Real task failures and retry execution, with an isolated synthetic model."""
import json
import os
import tempfile
from unittest.mock import patch
from urllib.parse import urlsplit

from agent_framework.definitions import default_definition
from agent_framework.llm import CodexTransport, ModelError
from agent_framework.model_catalog import ModelCatalog
from agent_framework.web import Application, Handler, WebServer

calls = {}


def generate(transport, prompt, *args):
    request = json.loads(prompt[prompt.index('\n{')+1:])
    task = request['context']['task'];history = task['conversation_context']
    root = history['task_id'];calls[root] = calls.get(root, 0)+1
    if history['turn'] == 1 or history['goal'] == '连续失败后恢复' and history['turn'] == 2:
        transport.progress({'kind': 'answer_text', 'text': '已保存的本轮片段。', 'attempt': 1})
        raise ModelError('model_timeout')
    value = {'kind': 'result', 'summary': '本轮已完成。', 'result': {'title': '重试结果',
             'content': '本轮要求：'+task['goal']+'\n原任务：'+history['goal'], 'citations': [], 'limitations': []}}
    return json.dumps(value, ensure_ascii=False), {'usage': {'input_tokens': 5, 'output_tokens': 5}}


class RetryHandler(Handler):
    def dispatch(self, mutation=False):
        if urlsplit(self.path).path != '/__test/turn-retries':return super().dispatch(mutation)
        self.guard(mutation)
        if mutation:return self.reply(405, {'error': 'GET required'})
        return self.reply(200, {'agent': agent['id'], 'calls': calls})


if __name__ == '__main__':
    root = tempfile.mkdtemp(prefix='turn-retries-browser-', dir='/private/tmp')
    catalog = {'models': [{'id': 'retry-fixture', 'name': 'Retry fixture', 'efforts': ['low']}], 'source': 'isolated fixture'}
    with patch.object(ModelCatalog, 'list', return_value=catalog), patch.object(CodexTransport, 'generate', generate):
        app = Application(root)
        agent = app.agents.save({'name': '失败恢复助手', 'description': '隔离重试验证', 'runtime': 'codex', 'model': 'retry-fixture',
                'options': {'timeout': 30, 'max_attempts': 2, 'reasoning_effort': 'low'}, 'prompt': '按用户要求继续处理。',
                'skills': [], 'mcp_servers': [], 'revision': 0, 'definition': default_definition('失败恢复助手', 'general-assistant@1.0.0')})
        server = WebServer(('127.0.0.1', int(os.environ.get('TURN_RETRIES_PORT', '8799'))), app)
        server.RequestHandlerClass = RetryHandler
        print('Isolated data: '+root, flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close();app.close()
