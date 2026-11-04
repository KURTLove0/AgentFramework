"""Measure conversation reads on a reusable, synthetic long-history fixture."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import time
import tracemalloc
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_framework.contracts import canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application


def seed(app, turns, chunks):
    root = app.create({'runtime': 'mock', 'start': False})['run']
    service = TaskConversations(app)
    service.register(root)
    with app.control_store.transaction() as db:
        for n in range(turns):
            state = deepcopy(root)
            identity = root['run_id'] if n == 0 else 'turn-measure-' + str(n)
            state.update(run_id=identity, status='SUCCEEDED' if n < turns - 1 else 'RUNNING',
                         created_at=1000+n, updated_at=2000+n, deadline=4000000000,
                         version=3, model_calls=1, model_tokens=500)
            state['task']['goal'] = '第 ' + str(n + 1) + ' 轮合成要求'
            state['report'] = {'content': '已完成的合成结果 ' + str(n)} if n < turns - 1 else None
            db.execute('INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?,?,?)',
                       (app.tenant, identity, 3, canonical(state), 'fixture' if n == turns - 1 else None, 1, 4000000000))
            if n:
                db.execute('INSERT INTO task_conversation_turns VALUES(?,?,?,?,?,?,?,?,?)',
                           (app.tenant, root['run_id'], n+1, identity, 'measure-'+str(n), state['task']['goal'], 'RUNNING', None, 1000+n))
            Store.event(db, app.tenant, identity, 'model.requested', {'phase': 'execute', 'private_payload': 'P' * 12000})
            Store.event(db, app.tenant, identity, 'private.audit', {'private_payload': 'Q' * 24000})
            for chunk in range(1, chunks+1):
                Store.event(db, app.tenant, identity, 'model.progress', {'kind': 'answer_text', 'text': '公开回答片段。' * (chunk * 12), 'attempt': 1})
                if chunk % 10 == 0:
                    Store.event(db, app.tenant, identity, 'model.progress', {'kind': 'summary_text', 'text': '公开摘要。' * chunk, 'attempt': 1, 'stream_id': 'summary'})
            Store.event(db, app.tenant, identity, 'model.progress', {'kind': 'status', 'text': '正在核对结果'})
        db.execute('UPDATE task_conversations SET revision=?,updated=? WHERE tenant=? AND id=?', (turns, 3000, app.tenant, root['run_id']))
    return root['run_id']


def measure(directory, turns=60, chunks=80):
    marker = directory / 'conversation-measure.json'
    if directory.exists() and any(directory.iterdir()) and not marker.exists():
        raise ValueError('Refusing an existing directory without the synthetic fixture marker')
    app = Application(directory)
    try:
        if marker.exists():
            fixture = json.loads(marker.read_text())
            if (fixture['turns'], fixture['chunks']) != (turns, chunks):
                raise ValueError('Fixture size differs; choose a new directory')
        else:
            fixture = {'identity': seed(app, turns, chunks), 'turns': turns, 'chunks': chunks}
            marker.write_text(json.dumps(fixture) + '\n')
        service = TaskConversations(app, app.control_store)
        samples = []
        original_loads, original_connect = json.loads, Store.connect
        for _ in range(3):
            counts = {'decoded_bytes': 0, 'decodes': 0, 'queries': 0}
            def loads(value, *args, **kwargs):
                counts['decoded_bytes'] += len(value.encode() if isinstance(value, str) else value)
                counts['decodes'] += 1
                return original_loads(value, *args, **kwargs)
            def connect(store):
                connection = original_connect(store)
                def trace(sql):
                    if sql.lstrip().upper().startswith(('SELECT', 'WITH')):
                        counts['queries'] += 1
                connection.set_trace_callback(trace)
                return connection
            tracemalloc.start()
            started = time.perf_counter()
            with patch('json.loads', loads), patch.object(Store, 'connect', connect):
                view = service.view(fixture['identity'])
            elapsed = time.perf_counter() - started
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            samples.append({**counts, 'seconds': elapsed, 'peak_bytes': peak})
        return {'turns': turns, 'chunks_per_turn': chunks, 'samples': samples,
                'view_sha256': hashlib.sha256(canonical(view).encode()).hexdigest(),
                'view_bytes': len(canonical(view).encode()), 'database': str(directory),
                'model_calls_made_by_measurement': 0}
    finally:
        app.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = measure(args.data_dir)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
