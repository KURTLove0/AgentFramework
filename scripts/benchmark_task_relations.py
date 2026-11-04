"""Measure relation reads using temporary synthetic history, never live data."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import median
import sys
import tempfile
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from agent_framework import store as store_module,task_relations
from agent_framework.web import Application
from tests.test_run_catalog import seed_history


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tasks',type=int,default=600)
    parser.add_argument('--turns',type=int,default=1)
    parser.add_argument('--body-bytes',type=int,default=32768)
    parser.add_argument('--repeats',type=int,default=5)
    args=parser.parse_args()
    if not 5<=args.tasks<=2000 or not 1<=args.turns<=5 or not 1<=args.body_bytes<=65536 or not 1<=args.repeats<=10:
        parser.error('tasks: 5–2000; turns: 1–5; body-bytes: 1–65536; repeats: 1–10')
    with tempfile.TemporaryDirectory(prefix='agent-relations-benchmark-') as temporary:
        app=Application(temporary)
        try:
            roots=seed_history(app,count=args.tasks,turns=args.turns,body_bytes=args.body_bytes)
            with app.control_store.transaction() as db:
                for child in roots[1:5]:
                    db.execute("UPDATE runs SET state=json_set(state,'$.task.source_run_id',?) WHERE tenant_id=? AND id=?",(roots[0],app.tenant,child))
            measurements=[]
            for _ in range(args.repeats):
                started=time.perf_counter();result=task_relations.relations(app,roots[0])
                measurements.append(time.perf_counter()-started)
                assert [item['id'] for item in result['items']]==roots[4:0:-1]
            instructions=[0,0];store=app.control_store;original=store.connect;statements=[];candidate_query=[False]
            def progress():
                instructions[0]+=100
                if candidate_query[0]:instructions[1]+=100
                return 0
            class TracedConnection:
                def __init__(self):
                    self.db=original();self.db.set_progress_handler(progress,100)
                    self.db.set_trace_callback(lambda sql:candidate_query.__setitem__(0,'linked AS (' in sql))
                def __enter__(self):self.db.__enter__();return self
                def __exit__(self,*args):return self.db.__exit__(*args)
                def __getattr__(self,name):return getattr(self.db,name)
                def execute(self,sql,params=()):
                    if sql.lstrip().startswith('WITH '):statements.append((sql,params))
                    return self.db.execute(sql,params)
            with patch.object(store,'connect',new=TracedConnection):task_relations.relations(app,roots[0])
            with app.control_store.connect() as db:
                plans=[{'sql':sql,'params':params,'plan':[row['detail'] for row in db.execute('EXPLAIN QUERY PLAN '+sql,params)]} for sql,params in statements]
            report={'tasks':args.tasks,'turns':args.turns,'related_tasks':4,'body_bytes':args.body_bytes,'seconds':measurements,
                'median_seconds':median(measurements),'sqlite_instructions_approx':instructions[0],
                'candidate_instructions_approx':instructions[1],'query_plans':plans,
                'source_sha256':{name:hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest() for name,module in
                    [('agent_framework/task_relations.py',task_relations),('agent_framework/store.py',store_module)]}}
        finally:app.close()
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
