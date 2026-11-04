"""Measure header-list reads against disposable, fully synthetic task history."""
import argparse
import json
from pathlib import Path
from statistics import median
import sys
import tempfile
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from agent_framework.store import Store
from agent_framework.web import Application
from tests.test_run_catalog import seed_history


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tasks',type=int,default=120)
    parser.add_argument('--turns',type=int,default=3)
    parser.add_argument('--repeats',type=int,default=3)
    args=parser.parse_args()
    if not 1<=args.tasks<=2000 or not 1<=args.turns<=10 or not 1<=args.repeats<=10:
        parser.error('tasks: 1–2000; turns/repeats: 1–10')
    measurements=[]
    with tempfile.TemporaryDirectory(prefix='agent-history-benchmark-') as temporary:
        app=Application(temporary)
        try:
            seed_history(app,count=args.tasks,turns=args.turns,body_bytes=4096)
            original=Store.connect
            for _ in range(args.repeats):
                statements=[]
                def traced(store):
                    db=original(store);db.set_trace_callback(statements.append);return db
                started=time.perf_counter()
                with patch.object(Store,'connect',new=traced):result=app.runs({'limit':50})
                measurements.append({'seconds':round(time.perf_counter()-started,6),
                    'selects':sum(sql.lstrip().upper().startswith('SELECT') for sql in statements),
                    'audit_reads':sum('FROM events ' in sql for sql in statements),
                    'action_reads':sum('FROM actions ' in sql for sql in statements),
                    'returned':len(result['runs']),'total':result['counts']['total']})
        finally:
            app.close()
    print(json.dumps({'tasks':args.tasks,'turns_per_task':args.turns,'body_bytes_per_turn':4096,
                      'audit_entries_per_turn':3,'median_seconds':median(item['seconds'] for item in measurements),
                      'measurements':measurements},indent=2))


if __name__=='__main__':
    main()
