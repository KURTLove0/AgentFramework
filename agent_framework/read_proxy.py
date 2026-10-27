"""Scoped native MCP read proxy. Only published READ capabilities cross this port.

A short-lived random session binds the run, fencing epoch, scope and frozen
registry. The model cannot select paths, credentials, tenant or an upstream URL.
Calls and evidence survive cognition/process failure independently of summaries.
"""
from contextlib import contextmanager
import json
from pathlib import Path
import secrets
import sys
import time
from uuid import uuid4

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    __package__ = 'agent_framework'

from .contracts import ActionProposal, PolicyDenied, TERMINAL, canonical, digest
from .definitions import NATIVE_NAMES, domain_for, resolve_capability
from .gateway import Gateway
from .store import Store


class ReadCapabilityProxy:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.store = Store(self.data_dir / 'runtime.sqlite3')
        self.gateway = Gateway(self.store, self.data_dir / 'mock-business.sqlite3')
        with self.store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS read_sessions (token_hash TEXT PRIMARY KEY, data TEXT, revoked INTEGER)')

    @contextmanager
    def session(self, state, lease):
        refs = state['snapshot'].get('compiled_agent', {}).get('definition', {}).get('native_read_refs', [])
        token = secrets.token_urlsafe(32)
        data = {'tenant_id': state['tenant_id'], 'run_id': state['run_id'], 'lease': list(lease),
                'expires_at': min(state['deadline'], time.time() + 600), 'refs': refs,
                'snapshot_hash': state['snapshot']['hash']}
        with self.store.transaction() as db:
            self.store.fence(db, state, lease)
            db.execute('INSERT INTO read_sessions VALUES(?,?,0)', (digest(token), canonical(data)))
        try:
            yield {'mcp_servers': [{'name': 'governed', 'transport': 'stdio', 'command': sys.executable,
                    'args': [str(Path(__file__).resolve()), str(self.data_dir), token],
                    'env_vars': [], 'url': '', 'bearer_env': '',
                    'tools': [NATIVE_NAMES[ref] for ref in refs], 'enabled': bool(refs)}]}
        finally:
            with self.store.transaction() as db:
                db.execute('UPDATE read_sessions SET revoked=1 WHERE token_hash=?', (digest(token),))

    def scope(self, db, token):
        row = db.execute('SELECT * FROM read_sessions WHERE token_hash=?', (digest(token),)).fetchone()
        if not row or row['revoked']:
            raise PolicyDenied('native read session absent or revoked')
        scope = json.loads(row['data'])
        run = db.execute('SELECT * FROM runs WHERE tenant_id=? AND id=?', (scope['tenant_id'], scope['run_id'])).fetchone()
        if (not run or scope['expires_at'] <= time.time() or run['owner'] != scope['lease'][0]
                or run['epoch'] != scope['lease'][1] or run['lease_until'] <= time.time()):
            raise PolicyDenied('native read session lease expired or replaced')
        state = json.loads(run['state'])
        if state['status'] in TERMINAL or state['deadline'] <= time.time() or state['snapshot']['hash'] != scope['snapshot_hash']:
            raise PolicyDenied('native read session no longer applies')
        return scope, state

    def tools(self, token):
        with self.store.transaction() as db:
            scope, state = self.scope(db, token)
        tools = []
        for ref in scope['refs']:
            cap = self.gateway.capability(state, ref)
            if cap['effect'] != 'READ':
                raise PolicyDenied('native write forbidden')
            tools.append({'name': NATIVE_NAMES[ref], 'description': 'Task-scoped simulated read; audited by ActionGateway.',
                          'inputSchema': cap['input_schema'], 'annotations': {'readOnlyHint': True}})
        return tools

    def call(self, token, name, args):
        call_id = 'native-' + uuid4().hex
        action = None
        # Reserve budget durably before any external call. No checkpoint version bump:
        # the parent heartbeat owns that stream; this separate table has epoch fencing.
        with self.store.transaction() as db:
            scope, state = self.scope(db, token)
            ref = next((ref for ref in scope['refs'] if NATIVE_NAMES.get(ref) == name), None)
            if ref is None:
                self.store.event(db, state['tenant_id'], state['run_id'], 'native.read_rejected', {'tool': str(name)[:120]})
                error = 'unregistered native tool or WRITE effect'
            else:
                count = db.execute('SELECT COUNT(*) FROM native_reads WHERE tenant_id=? AND run_id=?',
                                   (state['tenant_id'], state['run_id'])).fetchone()[0]
                error = 'native read budget exhausted' if count + state['steps'] >= state['task']['budget']['max_steps'] else None
                if not error:
                    db.execute('INSERT INTO native_reads VALUES(?,?,?,?)', (state['tenant_id'], state['run_id'], call_id,
                               canonical({'id': call_id, 'ref': ref, 'status': 'PREPARED', 'epoch': scope['lease'][1]})))
                    self.store.event(db, state['tenant_id'], state['run_id'], 'native.read_prepared', {'id': call_id, 'ref': ref})
        if error:
            raise PolicyDenied(error)
        try:
            cap = self.gateway.capability(state, ref)
            if cap['effect'] != 'READ':
                raise PolicyDenied('native write forbidden')
            if state['task'].get('execution_mode') in ('direct','conversation') and ref=='knowledge.read@1.0.0':
                # A normal model turn can read versions already supplied in its
                # context or discovered by a native search, without a host plan.
                # Keep this derived observation local: the parent owns checkpoints.
                discovered=set()
                for manifest in self.store.contexts(state['tenant_id'],state['run_id']):
                    if (manifest['phase']=='execute' and manifest['scope']['project_id']==state['task']['project_id']
                        and digest({k:v for k,v in manifest.items() if k!='hash'})==manifest['hash']):
                        discovered.update(a['ref'] for a in manifest['selected'] if a['kind']=='KNOWLEDGE')
                for item in self.store.evidence(state).values():
                    if (item['source']=='knowledge.search@1.0.0' and item['tenant_id']==state['tenant_id']
                        and item['run_id']==state['run_id'] and item['content_hash']==digest(item['data'])
                        and item['data'].get('project_id')==state['task']['project_id']):
                        discovered.update(a['ref'] for a in item['data'].get('hits',[]))
                state={**state,'observations':{**state['observations'],'knowledge_hits':{'data':{'hits':[{'ref':r} for r in discovered]}}}}
            action = self.gateway.prepare(state, ActionProposal(ref, args, [], ['schema-and-scope'], 'native governed read'), self.store.evidence(state))
            action['logical_id'] = call_id
            action['authorization'] = self.gateway.authorize(state, action)
            # Recheck epoch and current policy at the last boundary before dispatch.
            with self.store.transaction() as db:
                self.scope(db, token)
            result = self.gateway.invoke(state, action)
            if not domain_for(state['snapshot']).validate_observation(ref, result, state['task']):
                raise ValueError('native read output rejected')
            evidence = {'id': 'evidence-' + digest([call_id, result])[:20], 'source': ref,
                        'observed_at': time.time(), 'data': result, 'content_hash': digest(result),
                        'tenant_id': state['tenant_id'], 'run_id': state['run_id']}
            record = {'id': call_id, 'ref': ref, 'status': 'VERIFIED', 'action': action, 'evidence_ref': evidence['id']}
            with self.store.transaction() as db:
                self.scope(db, token)  # Stale worker output cannot become trusted evidence.
                db.execute('INSERT INTO evidence VALUES(?,?,?,?)', (state['tenant_id'], state['run_id'], evidence['id'], canonical(evidence)))
                db.execute('UPDATE native_reads SET data=? WHERE tenant_id=? AND run_id=? AND id=?',
                           (canonical(record), state['tenant_id'], state['run_id'], call_id))
                self.store.event(db, state['tenant_id'], state['run_id'], 'native.read_verified', record)
            return {'evidence_ref': evidence['id'], 'data': result}
        except Exception as exc:
            with self.store.transaction() as db:
                record = {'id': call_id, 'ref': ref, 'status': 'REJECTED', 'reason': type(exc).__name__}
                db.execute('UPDATE native_reads SET data=? WHERE tenant_id=? AND run_id=? AND id=?',
                           (canonical(record), state['tenant_id'], state['run_id'], call_id))
                self.store.event(db, state['tenant_id'], state['run_id'], 'native.read_rejected', record)
            raise


def main():
    proxy, token = ReadCapabilityProxy(sys.argv[1]), sys.argv[2]
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            method = request['method']
            if 'id' not in request:
                continue
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'governed-reads', 'version': '1.0.0'}}
            elif method == 'tools/list':
                result = {'tools': proxy.tools(token)}
            elif method == 'tools/call':
                params = request['params']
                output = proxy.call(token, params['name'], params.get('arguments', {}))
                result = {'content': [{'type': 'text', 'text': canonical(output)}], 'isError': False}
            elif method == 'ping':
                result = {}
            else:
                raise ValueError('unsupported method')
            response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except Exception as exc:
            response = {'jsonrpc': '2.0', 'id': (request or {}).get('id'),
                        'error': {'code': -32602, 'message': 'governed read rejected: ' + type(exc).__name__}}
        print(canonical(response), flush=True)


if __name__ == '__main__':
    main()
