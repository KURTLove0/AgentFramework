import argparse
import json
from pathlib import Path
import sys

from .contracts import Budget, LeaseBusy, LeaseLost, TaskContract
from .llm import CodexConfig, CursorConfig, QoderConfig, LLMPlanner
from .planner import MockPlanner
from .mock_tools import SCENARIOS
from .runtime import CrashInjected, Runtime
from .exports import artifact_markdown, capture_run, write_directory


def dump(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def summary(result):
    return {"run_id": result["run_id"], "status": result["status"], "steps": result["steps"], "replans": result["replans"],
            "model_calls": result.get("model_calls", 0), "model_tokens": result.get("model_tokens", 0),
            "risk_level": (result["report"] or {}).get("risk_level"), "draft": result["draft"],
            "checks": {k: v["passed"] for k, v in result["checks"].items()}, "last_error": result["last_error"],
            **({'cancellation':result['cancellation']} if result.get('cancellation') else {}),
            "residual_effects": [{"logical_id": a["logical_id"], "status": a["status"], "idempotency_key": a["args"]["idempotency_key"]} for a in result["residual_effects"]]}

def export_result(runtime,result,directory):
    snapshot=capture_run(runtime.store,result['tenant_id'],result['run_id'])
    return write_directory(snapshot,directory)


def parser():
    p = argparse.ArgumentParser(description="Agent Framework：任务执行、Web 工作台与核心数据维护")
    p.add_argument("--data-dir", default=".agent-data")
    p.add_argument("--tenant", default="tenant-demo")
    p.add_argument("--lease-seconds", type=float, default=10, help="worker lease; must exceed tool timeout")
    p.add_argument("--tool-timeout", type=float, default=2)
    p.add_argument("--planner", choices=("mock", "codex", "cursor", "qoder"), help="new tasks default to mock; resume restores the frozen planner")
    p.add_argument("--domain",choices=("general-assistant@1.0.0","change-assessment@2.0.0","knowledge-answer@1.0.0"),default="change-assessment@2.0.0")
    p.add_argument("--goal",help="new task instruction / knowledge question")
    p.add_argument("--model", help="model ID for Codex/Cursor/Qoder; defaults to that CLI's local model preference")
    p.add_argument("--reasoning-effort", choices=("minimal", "low", "medium", "high", "xhigh", "max", "ultra"))
    p.add_argument("--model-timeout", type=float, default=60)
    p.add_argument("--model-attempts", type=int, default=2, help="bounded JSON/schema repair attempts")
    sub = p.add_subparsers(dest="command", required=True)
    web = sub.add_parser("serve", help="启动本机 Web 工作台")
    web.add_argument("--host", choices=("127.0.0.1", "localhost"), default="127.0.0.1")
    web.add_argument("--port", type=int, default=8787)
    web.add_argument("--principal",default="demo-user",help="trusted local simulated actor; never accepted from request JSON")
    backup = sub.add_parser('backup', help='备份整个本机核心数据目录（所有租户与主体），不覆盖已有文件',
                            description='等待任务结束后，将整个数据目录的两个核心数据库保存为经过校验的 ZIP。范围包括所有租户、空间和主体。')
    backup.add_argument('file', type=Path, help='新的备份 ZIP 文件')
    backup.add_argument('--timeout', type=float, default=2, help='等待数据库写锁的秒数，最多 30 秒')
    verify = sub.add_parser('verify-backup', help='校验备份并查看工作空间与记录数量',
                            description='检查备份格式、SHA-256 和数据库完整性，并列出工作空间与各类记录数量；不启动工作台或模型。')
    verify.add_argument('file', type=Path, help='要检查的备份 ZIP 文件')
    verify.add_argument('--workspace-offset',type=int,default=0,help='工作空间目录起始位置，按返回的 next_offset 继续查看，每页最多 100 条')
    restore = sub.add_parser('restore-backup', help='验证后恢复到新的数据目录，不覆盖原数据',
                             description='完整校验后恢复到尚不存在的目录，保留原数据和备份，恢复后使用原租户与主体启动。')
    restore.add_argument('file', type=Path, help='来源备份 ZIP 文件')
    restore.add_argument('directory', type=Path, help='尚不存在的数据目录，上级目录须已存在')
    verify_export=sub.add_parser('verify-export',help='只读校验任务导出目录或 ZIP 的完整性与快照边界')
    verify_export.add_argument('path',type=Path)
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
    read_help={'show':'只读查看已有运行，不初始化工作台','events':'只读查看已有运行事件','stats':'只读查询已有业务调用与草稿效果','export':'从已有运行只读导出到新目录'}
    for command in ("resume", "show", "events", "grant", "revoke", "cancel", "stats", "export"):
        c = sub.add_parser(command,help=read_help.get(command),description=read_help.get(command))
        c.add_argument("run_id")
        if command == "resume":
            c.add_argument("--pause-after", type=int)
            c.add_argument("--export", type=Path)
        if command == "show":
            c.add_argument("--full", action="store_true")
        if command == "export":
            c.add_argument("directory", type=Path,help='尚不存在的导出目录；已有目录不会被覆盖')
    return p


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    try:
        if args.command == "serve":
            from .web import serve
            serve(args.data_dir, args.tenant, args.host, args.port, args.principal)
            return 0
        if args.command=='verify-export':
            from .exports import verify_export
            dump(verify_export(args.path))
            return 0
        if args.command in {'backup', 'verify-backup', 'restore-backup'}:
            from .backups import create_backup, verify_backup, restore_backup
            if args.command == 'backup':
                result = create_backup(args.data_dir, args.file, timeout=args.timeout)
            elif args.command == 'verify-backup':
                result = verify_backup(args.file,workspace_offset=args.workspace_offset)
            else:
                result = restore_backup(args.file, args.directory)
            dump(result)
            return 0
        from .inspection import READ_COMMANDS,read_run
        if args.command in READ_COMMANDS:
            result=read_run(args.data_dir,args.tenant,args.run_id,args.command,directory=getattr(args,'directory',None))
            if args.command=='events':
                for event in result:print(json.dumps(event,ensure_ascii=False))
            else:dump(summary(result) if args.command=='show' and not args.full else result)
            return 0
        if args.planner not in {"codex", "cursor", "qoder"} and args.model:
            raise ValueError("--model requires --planner codex, cursor or qoder")
        if args.reasoning_effort and args.planner != "codex":
            raise ValueError("--reasoning-effort requires --planner codex")
        planner = LLMPlanner(CodexConfig.local(model=args.model, reasoning_effort=args.reasoning_effort,
                    timeout=args.model_timeout, max_attempts=args.model_attempts)) if args.planner == "codex" else MockPlanner() if args.planner == "mock" else None
        if args.planner in {'cursor','qoder'}:
            config_type=CursorConfig if args.planner=='cursor' else QoderConfig
            config=config_type(args.model) if args.model else config_type.local()
            planner=LLMPlanner(config_type(config.model,timeout=args.model_timeout,max_attempts=args.model_attempts))
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
        dump(summary(result))
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
