"""Durable design requests. Reads never generate; retries retain their original input."""
from contextlib import ExitStack
import json
import time
from uuid import uuid4

from .agents import text
from .contracts import canonical, digest, identifier
from .runtime_config import ConfigConflict
from .workspaces import assert_workspace_active


class WorkflowChatRequestNotFound(KeyError):
    pass


class WorkflowChatRequests:
    # A design round (including Skill selection) has a shared timeout <= 180s.
    # After process loss, only an explicit retry can replace the expired owner.
    lease_seconds = 240

    def __init__(self, app):
        self.app = app
        self.store = app.runtime().store
        self.scope = (app.tenant, app.workspace['id'], app.principal)

    def row(self, db, request_id):
        return db.execute('SELECT * FROM workflow_chat_requests WHERE tenant=? AND workspace=? AND principal=? AND request_id=?', (*self.scope, request_id)).fetchone()

    @staticmethod
    def normalize(data):
        required = {'request_id', 'agent_id', 'agent_revision', 'message', 'consent'}
        if not isinstance(data, dict) or not required <= set(data) or set(data) - (required | {'id', 'revision'}):
            raise ValueError('设计请求需要提交编号、智能体版本、消息和许可')
        for key in ('request_id', 'agent_id'):
            identifier(data[key])
        if type(data['agent_revision']) is not int or data['agent_revision'] < 1:
            raise ValueError('设计智能体版本无效')
        if type(data['consent']) is not bool:
            raise ValueError('对话发送许可必须为布尔值')
        result = {**data, 'message': text(data['message'], '消息', 2000)}
        if 'id' in data:
            identifier(data['id'])
            if type(data.get('revision')) is not int or data['revision'] < 1:
                raise ValueError('继续对话需要当前整数版本')
        elif 'revision' in data:
            raise ValueError('新设计请求不应包含对话版本')
        return result

    def get(self, request_id):
        identifier(request_id)
        with self.store.read_snapshot() as db:
            row = self.row(db, request_id)
            if not row:
                raise WorkflowChatRequestNotFound(request_id)
            state = row['state']
            if state == 'RUNNING' and row['lease_until'] <= time.time():
                state = 'INTERRUPTED'
            response = json.loads(row['response']) if row['response'] else None
            current = None
            if response:
                chat = db.execute('SELECT * FROM workflow_chats WHERE tenant=? AND workspace=? AND principal=? AND id=?', (*self.scope, row['chat_id'])).fetchone()
                if not chat:
                    raise ValueError('已完成设计请求缺少对应对话')
                current = {**json.loads(chat['data']), 'id': chat['id'], 'revision': chat['revision']}
            return {'request_id': request_id, 'payload': json.loads(row['payload']), 'state': state,
                    'attempt': row['attempt'], 'retryable': state in ('ERROR', 'INTERRUPTED'),
                    'error': row['error'], 'updated_at': row['updated'],
                    'response': response, 'current': current}

    def reply(self, data):
        payload = self.normalize(data)
        request_id = payload['request_id']
        serialized = canonical(payload)
        now = time.time()
        owner = uuid4().hex
        with ExitStack() as generation:
            with self.store.transaction() as db:
                assert_workspace_active(db, *self.scope[:2])
                prior = self.row(db, request_id)
                if prior and prior['payload'] != serialized:
                    raise ConfigConflict('此设计提交编号已用于不同内容，请先核对原请求')
                if prior and prior['state'] == 'COMPLETE':
                    return json.loads(prior['response'])
                if prior and prior['state'] == 'RUNNING' and prior['lease_until'] > now:
                    raise ConfigConflict('原设计请求仍在处理中，请核对原请求状态')
                generation.enter_context(self.app.proposal_capacity.reserve())
                chat_id = payload.get('id') or 'chat-' + digest([*self.scope, request_id])[:32]
                db.execute('INSERT OR REPLACE INTO workflow_chat_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (*self.scope, request_id, serialized, 'RUNNING', owner, now + self.lease_seconds,
                            prior['attempt'] + 1 if prior else 1, chat_id, None, None,
                            prior['created'] if prior else now, now))
            attempt = {'service': self, 'request_id': request_id, 'owner': owner,
                       'chat_id': chat_id, 'agent_id': payload['agent_id'], 'agent_revision': payload['agent_revision']}
            try:
                from .workflow_chat import WorkflowChat
                return WorkflowChat(self.app).reply({k: v for k, v in payload.items() if k not in ('request_id', 'agent_revision')}, attempt=attempt)
            except Exception:
                # Provider failures may contain paths or credentials; the durable
                # recovery record only retains a generic error, not raw exceptions.
                with self.store.transaction() as db:
                    db.execute("UPDATE workflow_chat_requests SET state='ERROR',lease_until=0,error=?,updated=? WHERE tenant=? AND workspace=? AND principal=? AND request_id=? AND owner=? AND state='RUNNING'",
                               ('本次设计未保存结果。可使用原内容重试，或重新准备设计。', time.time(), *self.scope, request_id, owner))
                raise

    def complete(self, db, attempt, response):
        row = self.row(db, attempt['request_id'])
        if not row or row['state'] != 'RUNNING' or row['owner'] != attempt['owner'] or row['lease_until'] <= time.time():
            raise ConfigConflict('原设计处理权已失效，请核对原请求结果')
        profile = db.execute('SELECT revision,archived FROM agent_profiles WHERE tenant=? AND workspace_id=? AND id=?',
                             (self.scope[0], self.scope[1], attempt['agent_id'])).fetchone()
        if not profile or profile['archived'] or profile['revision'] != attempt['agent_revision']:
            raise ConfigConflict('设计智能体在处理期间已更新，请重新准备设计')
        db.execute("UPDATE workflow_chat_requests SET state='COMPLETE',lease_until=0,response=?,updated=?,error=NULL WHERE tenant=? AND workspace=? AND principal=? AND request_id=?",
                   (canonical(response), time.time(), *self.scope, attempt['request_id']))
