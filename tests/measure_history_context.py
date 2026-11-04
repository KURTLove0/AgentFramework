"""Measure model-history assembly on a marked synthetic conversation fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import tracemalloc
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from agent_framework.contracts import canonical
from agent_framework.store import Store
from agent_framework.task_conversations import TaskConversations
from agent_framework.web import Application


def measure(directory):
    marker=directory/'conversation-measure.json'
    if not marker.exists():raise ValueError('Use the marked synthetic fixture from measure_conversation_reads.py')
    fixture=json.loads(marker.read_text());app=Application(directory)
    try:
        service=TaskConversations(app,app.control_store);root=service.root(fixture['identity']);rows=service.rows(root)
        original_loads=json.loads;original_connect=Store.connect;samples=[]
        for _ in range(3):
            counts={'queries':0,'decodes':0,'decoded_bytes':0}
            def loads(value,*args,**kwargs):
                counts['decodes']+=1;counts['decoded_bytes']+=len(value.encode() if isinstance(value,str) else value)
                return original_loads(value,*args,**kwargs)
            def connect(store):
                db=original_connect(store)
                def trace(sql):
                    if sql.lstrip().upper().startswith(('SELECT','WITH')):counts['queries']+=1
                db.set_trace_callback(trace);return db
            tracemalloc.start();started=time.perf_counter()
            with patch('json.loads',loads),patch.object(Store,'connect',connect):history=service.history(root,rows,fixture['turns']+1)
            elapsed=time.perf_counter()-started;_,peak=tracemalloc.get_traced_memory();tracemalloc.stop()
            samples.append({**counts,'seconds':elapsed,'peak_bytes':peak})
        return {'turns':fixture['turns'],'samples':samples,'context_sha256':hashlib.sha256(canonical(history).encode()).hexdigest(),
                'context_bytes':len(canonical(history).encode()),'messages':len(history['messages']),'model_calls':0,'database':str(directory)}
    finally:app.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--data-dir',required=True,type=Path);parser.add_argument('--output',required=True,type=Path);args=parser.parse_args()
    result=measure(args.data_dir);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
