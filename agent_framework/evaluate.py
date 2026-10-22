"""Reproducible fault matrix. Run: python3 -m agent_framework.evaluate"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from .cli import export_result
from .mock_tools import SCENARIOS
from .runtime import Runtime
from .contracts import Budget, TaskContract
from .llm import CodexConfig, LLMPlanner


EXPECTED = {
    "normal": "SUCCEEDED", "read-transient": "SUCCEEDED", "read-fails": "FAILED",
    "response-lost": "SUCCEEDED", "crash-after-write": "SUCCEEDED", "unverifiable": "NEEDS_REVIEW",
    "tampered-draft": "NEEDS_REVIEW", "invalid-report": "SUCCEEDED", "denied": "WAITING_AUTH",
    "source-changed": "SUCCEEDED", "missing-evidence": "WAITING_INPUT",
}


def main(argv=None):
    parser = argparse.ArgumentParser(description="运行完整模拟故障矩阵并导出证据")
    parser.add_argument("--output", type=Path, default=Path(".agent-data/evaluation"))
    parser.add_argument("--planner", choices=("mock", "codex"), default="mock")
    parser.add_argument("--model")
    parser.add_argument("--reasoning-effort")
    parser.add_argument("--scenario", action="append", choices=SCENARIOS, help="repeat to select live-model cases")
    args = parser.parse_args(argv)
    root = args.output.resolve() / ("evaluation-" + uuid.uuid4().hex[:10])
    root.mkdir(parents=True)
    rows = []
    config = CodexConfig.local(model=args.model, reasoning_effort=args.reasoning_effort) if args.planner == "codex" else None
    for scenario in (args.scenario or SCENARIOS):
        directory = root / scenario
        runtime = Runtime(directory, planner=LLMPlanner(config) if config else None)
        task = TaskContract(principal="demo-user", budget=Budget(max_wall_seconds=600 if config else 120))
        task_file = directory / "task.json"
        task_file.write_text(json.dumps(task.to_dict(), ensure_ascii=False, indent=2) + "\n")
        crash_exit = None
        if scenario == "crash-after-write":
            base = [sys.executable, "-m", "agent_framework", "--data-dir", str(directory),
                    "--lease-seconds", "0.8", "--tool-timeout", "0.3"]
            if config:
                base.extend(["--planner", "codex", "--model", config.model, "--reasoning-effort", config.reasoning_effort])
            crashed = subprocess.run([*base, "demo", "--scenario", scenario, "--task", str(task_file)], capture_output=True, text=True, timeout=610 if config else 20)
            crash_exit = crashed.returncode
            match = re.search(r"run_id=(run-\w+)", crashed.stdout)
            if crash_exit != 75 or not match:
                raise RuntimeError("crash injection failed: " + crashed.stderr + crashed.stdout)
            run_id = match[1]
            time.sleep(0.85)
            result = runtime.run(run_id)
        else:
            state = runtime.submit(scenario=scenario, task=task)
            result = runtime.run(state["run_id"])
        stats = runtime.external.stats(result["tenant_id"], result["run_id"])
        expected_drafts = 0 if scenario in ("read-fails", "denied", "missing-evidence") else 1
        row = {"scenario": scenario, "run_id": result["run_id"], "expected_status": EXPECTED[scenario],
               "status": result["status"], "draft_count": len(stats["drafts"]),
               "write_calls": stats["calls"].get("report.draft.create@1.0.0", 0),
               "replans": result["replans"], "steps": result["steps"], "crash_exit": crash_exit}
        expected_calls = 2 if scenario == "source-changed" else expected_drafts
        row["passed"] = (row["status"] == row["expected_status"] and row["draft_count"] == expected_drafts
                         and row["write_calls"] == expected_calls)
        export_result(runtime, result, directory / "export")
        rows.append(row)
        print(f"{'PASS' if row['passed'] else 'FAIL'} {scenario}: {row['status']}, drafts={row['draft_count']}, write_calls={row['write_calls']}", flush=True)
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "scope": "mock-tools + " + ("live-codex-planner" if config else "deterministic-planner"),
              "model": config.model if config else None,
              "passed": sum(r["passed"] for r in rows), "total": len(rows), "cases": rows}
    (root / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("summary=" + str(root / "summary.json"))
    return 0 if all(r["passed"] for r in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
