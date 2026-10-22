import argparse
import json
from pathlib import Path
import sys

from .contracts import Budget, LeaseBusy, LeaseLost, TaskContract
from .llm import CodexConfig, CursorConfig, LLMPlanner
from .planner import MockPlanner
from .mock_tools import SCENARIOS
from .runtime import CrashInjected, Runtime


def dump(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def summary(result):
    return {"run_id": result["run_id"], "status": result["status"], "steps": result["steps"], "replans": result["replans"],
            "model_calls": result.get("model_calls", 0), "model_tokens": result.get("model_tokens", 0),
            "risk_level": (result["report"] or {}).get("risk_level"), "draft": result["draft"],
            "checks": {k: v["passed"] for k, v in result["checks"].items()}, "last_error": result["last_error"],
            "residual_effects": [{"logical_id": a["logical_id"], "status": a["status"], "idempotency_key": a["args"]["idempotency_key"]} for a in result["residual_effects"]]}


def artifact_markdown(report):
    if 'answer' in report:
        text='# '+report['question']+'\n\n'+report['answer']+'\n\n## 来源\n\n'
        text+='\n'.join('- '+c['asset_ref']+' ['+c['evidence_ref']+']' for c in report['citations'])
        return text+'\n\n'+ '\n'.join(report.get('limitations',[]))+'\n'
    text='# '+report['title']+'\n\n'
    text+='\n\n'.join('## '+key+'\n\n'+value for key,value in report['sections'].items())
    return text+'\n\n## 事实引用\n\n'+json.dumps(report['claims'],ensure_ascii=False,indent=2)+'\n'


def export_result(runtime, result, directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    events = runtime.store.events(result["tenant_id"], result["run_id"])
    (directory / "events.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events), encoding="utf-8")
    if result["report"]:
        (directory / 'report.md').write_text(artifact_markdown(result['report']),encoding='utf-8')
    return str(directory)


def parser():
    p = argparse.ArgumentParser(description="Agent MVP：模拟变更评估、草稿创建与失败恢复")
    p.add_argument("--data-dir", default=".agent-data")
    p.add_argument("--tenant", default="tenant-demo")
    p.add_argument("--lease-seconds", type=float, default=10, help="worker lease; must exceed tool timeout")
    p.add_argument("--tool-timeout", type=float, default=2)
    p.add_argument("--planner", choices=("mock", "codex", "cursor"), help="new tasks default to mock; resume restores the frozen planner")
    p.add_argument("--domain",choices=("change-assessment@2.0.0","knowledge-answer@1.0.0"),default="change-assessment@2.0.0")
    p.add_argument("--goal",help="new task instruction / knowledge question")
    p.add_argument("--model", help="model ID for Codex/Cursor; defaults to that CLI's local model preference")
    p.add_argument("--reasoning-effort", choices=("minimal", "low", "medium", "high", "xhigh", "max", "ultra"))
    p.add_argument("--model-timeout", type=float, default=60)
    p.add_argument("--model-attempts", type=int, default=2, help="bounded JSON/schema repair attempts")
    sub = p.add_subparsers(dest="command", required=True)
    web = sub.add_parser("serve", help="启动本机 Web 工作台")
    web.add_argument("--host", choices=("127.0.0.1", "localhost"), default="127.0.0.1")
    web.add_argument("--port", type=int, default=8787)
    web.add_argument("--principal",default="demo-user",help="trusted local simulated actor; never accepted from request JSON")
    for command in ("demo", "submit"):
        c = sub.add_parser(command)
        c.add_argument("--scenario", choices=SCENARIOS, default="normal")
        c.add_argument("--task", type=Path)
        c.add_argument("--max-steps", type=int)
        c.add_argument("--max-wall-seconds", type=float)
        c.add_argument("--no-grant", action="store_true")
        if command == "demo":
            c.add_argument("--pause-after", type=int)
            c.add_argument("--export", type=Path)
    for command in ("resume", "show", "events", "grant", "revoke", "cancel", "stats", "export"):
        c = sub.add_parser(command)
        c.add_argument("run_id")
        if command == "resume":
            c.add_argument("--pause-after", type=int)
            c.add_argument("--export", type=Path)
        if command == "show":
            c.add_argument("--full", action="store_true")
        if command == "export":
            c.add_argument("directory", type=Path)
    return p


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    try:
        if args.command == "serve":
            from .web import serve
            serve(args.data_dir, args.tenant, args.host, args.port, args.principal)
            return 0
        if args.planner not in {"codex", "cursor"} and args.model:
            raise ValueError("--model requires --planner codex or cursor")
        if args.reasoning_effort and args.planner != "codex":
            raise ValueError("--reasoning-effort requires --planner codex")
        planner = LLMPlanner(CodexConfig.local(model=args.model, reasoning_effort=args.reasoning_effort,
                    timeout=args.model_timeout, max_attempts=args.model_attempts)) if args.planner == "codex" else MockPlanner() if args.planner == "mock" else None
        if args.planner == 'cursor':
            config = CursorConfig(args.model) if args.model else CursorConfig.local()
            planner = LLMPlanner(CursorConfig(config.model, timeout=args.model_timeout, max_attempts=args.model_attempts))
        runtime = Runtime(args.data_dir, planner=planner, lease_seconds=args.lease_seconds, tool_timeout=args.tool_timeout)
        if args.command in ("demo", "submit"):
            task = TaskContract.from_dict(json.loads(args.task.read_text(encoding="utf-8"))) if args.task else TaskContract(
                domain_pack_ref=args.domain, goal=args.goal or ("变更评估的风险规则是什么？" if args.domain=="knowledge-answer@1.0.0" else "评估指定变更并创建一份评估草稿"),
                tenant_id=args.tenant, principal="demo-user" if isinstance(planner, LLMPlanner) else "kurt",
                budget=Budget(max_wall_seconds=600 if isinstance(planner, LLMPlanner) else 120))
            if task.tenant_id != args.tenant:
                raise ValueError("task tenant must match --tenant")
            if args.max_steps is not None or args.max_wall_seconds is not None:
                data = task.to_dict()
                if args.max_steps is not None:
                    data["budget"]["max_steps"] = args.max_steps
                if args.max_wall_seconds is not None:
                    data["budget"]["max_wall_seconds"] = args.max_wall_seconds
                task = TaskContract.from_dict(data)
            state = runtime.submit(task, args.scenario, grant=not args.no_grant)
            # Print and flush identity before any possible crash.
            print(f"run_id={state['run_id']}", flush=True)
            if args.command == "submit":
                dump(summary(runtime.store.result(args.tenant, state["run_id"])))
                return 0
            result = runtime.run(state["run_id"], args.tenant, args.pause_after)
        else:
            state = runtime.store.load(args.tenant, args.run_id)
            if args.command == "resume":
                result = runtime.run(args.run_id, args.tenant, args.pause_after)
            elif args.command in ("grant", "revoke"):
                actions = runtime.store.actions(state)
                pending = next((a for a in actions if a["status"] == "PREPARED" and a["tool_ref"].startswith("report.draft.create")), None)
                runtime.store.grant(state, pending["args_hash"] if pending else None, revoke=args.command == "revoke")
                dump({"run_id": args.run_id, "action": args.command, "args_hash": pending["args_hash"] if pending else None})
                return 0
            elif args.command == "cancel":
                runtime.cancel(args.run_id, args.tenant)
                result = runtime.store.result(args.tenant, args.run_id)
            elif args.command == "events":
                for event in runtime.store.events(args.tenant, args.run_id):
                    print(json.dumps(event, ensure_ascii=False))
                return 0
            elif args.command == "stats":
                dump(runtime.external.stats(args.tenant, args.run_id))
                return 0
            else:
                result = runtime.store.result(args.tenant, args.run_id)
        if args.command == "export":
            dump({"directory": export_result(runtime, result, args.directory)})
        else:
            dump(result if getattr(args, "full", False) else summary(result))
            if getattr(args, "export", None):
                print("export=" + export_result(runtime, result, args.export))
        return 0 if result["status"] in {"SUCCEEDED", "CREATED", "RUNNING"} or args.command in {"show", "cancel"} else 2
    except CrashInjected:
        print("模拟进程在写入后、保存回执前退出。租约过期后执行 resume；恢复将先核对外部草稿。", file=sys.stderr)
        return 75
    except (ValueError, KeyError, LeaseBusy, LeaseLost, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
