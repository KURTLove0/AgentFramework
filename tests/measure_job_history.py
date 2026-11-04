"""Synthetic executor-rejection churn with real durable task/stop records."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent_framework.web import Application


def measure(count):
    with tempfile.TemporaryDirectory(prefix='job-history-load-') as directory:
        app = Application(directory)
        samples = []
        first = None
        started = time.monotonic()
        try:
            with patch.object(app.pool, 'submit', side_effect=RuntimeError('synthetic rejection')):
                with patch.object(app.cancellation_pool, 'submit', side_effect=RuntimeError('synthetic rejection')):
                    for number in range(1, count + 1):
                        identity = app.create({'runtime': 'mock', 'start': False})['run']['run_id']
                        first = first or identity
                        try:
                            app.schedule(identity)
                        except RuntimeError as exc:
                            if str(exc) != 'synthetic rejection':
                                raise
                        app.control_store.request_cancellation(app.tenant, identity)
                        app.schedule_cancellation(identity)
                        assert len(app.jobs) <= app.JOB_HISTORY_LIMIT
                        assert len(app.cancel_jobs) <= app.JOB_HISTORY_LIMIT
                        if number % app.JOB_HISTORY_LIMIT == 0 or number == count:
                            before = time.perf_counter()
                            for _ in range(100):
                                observed = app.observe_jobs()
                            samples.append({'tasks': number, 'execution_hints': len(app.jobs),
                                            'stop_hints': len(app.cancel_jobs), 'snapshot_hints': len(observed),
                                            'snapshot_mean_ms': (time.perf_counter() - before) * 10})
            with app.control_store.connect() as db:
                worker_errors = db.execute("SELECT COUNT(*) FROM runs WHERE json_extract(state,'$.interruption.code')='executor_rejected'").fetchone()[0]
                stop_errors = db.execute('SELECT COUNT(*) FROM run_cancellations WHERE error IS NOT NULL AND completed_at IS NULL').fetchone()[0]
            assert worker_errors == stop_errors == count
            assert count <= app.JOB_HISTORY_LIMIT or app.job(first) is None
            detail = app.detail(first)
            assert detail['run']['interruption']['code'] == 'executor_rejected'
            assert detail['cancellation']['error']
            return {'tasks': count, 'worker_errors_saved': worker_errors, 'stop_errors_saved': stop_errors,
                    'history_limit_per_executor': app.JOB_HISTORY_LIMIT, 'samples': samples,
                    'oldest_detail_readable': True, 'seconds': time.monotonic() - started,
                    'workload': 'real temporary task records; executor submissions deliberately rejected; no model calls'}
        finally:
            app.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=384)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.count < 1:
        parser.error('--count must be positive')
    result = measure(args.count)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(result, ensure_ascii=False))
