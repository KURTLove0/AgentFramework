"""An independent, durable fake business system (separate from runtime DB)."""

import json
from pathlib import Path
import sqlite3
import time

from .contracts import ToolFailure, canonical, digest
from .store import ClosingConnection


SCENARIOS = ("normal", "read-transient", "read-fails", "response-lost", "crash-after-write",
             "unverifiable", "tampered-draft", "invalid-report", "denied", "source-changed", "missing-evidence")


class MockSystem:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS changes(tenant TEXT, project TEXT, id TEXT, data TEXT, PRIMARY KEY(tenant,project,id));
                CREATE TABLE IF NOT EXISTS drafts(tenant TEXT, project TEXT, key TEXT, data TEXT, PRIMARY KEY(tenant,project,key));
                CREATE TABLE IF NOT EXISTS calls(tenant TEXT, run TEXT, tool TEXT, count INTEGER, PRIMARY KEY(tenant,run,tool));
            """)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5, factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        return db

    def seed(self, task):
        change = {
            "id": task["change_id"], "tenant_id": task["tenant_id"], "project_id": task["project_id"],
            "environment": task["environment"], "version": 1, "title": "支付服务增加超时重试",
            "service": "payment-service", "dependencies": ["order-service", "ledger-service"],
            "files": ["payment/retry.py", "payment/config.py"], "tests": {"passed": 38, "failed": 1},
            "rollback": "关闭 retry_enabled 开关并恢复上一版本", "owner": "payments-team",
        }
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO changes VALUES(?,?,?,?)", (task["tenant_id"], task["project_id"], task["change_id"], canonical(change)))

    def invoke(self, tool, args, trusted):
        tenant, run, scenario = trusted["tenant_id"], trusted["run_id"], trusted["scenario"]
        project = trusted["project_id"]
        if args["project_id"] != project:
            raise ToolFailure("denied", "project scope mismatch")
        with self.connect() as db:
            db.execute("INSERT INTO calls VALUES(?,?,?,1) ON CONFLICT(tenant,run,tool) DO UPDATE SET count=count+1", (tenant, run, tool))
            count = db.execute("SELECT count FROM calls WHERE tenant=? AND run=? AND tool=?", (tenant, run, tool)).fetchone()[0]
        if tool == "change.read@1.0.0":
            if scenario == "read-fails" or (scenario == "read-transient" and count == 1):
                raise ToolFailure("transient", "simulated change service unavailable")
            with self.connect() as db:
                row = db.execute("SELECT data FROM changes WHERE tenant=? AND project=? AND id=?", (tenant, project, args["change_id"])).fetchone()
            if not row:
                raise ToolFailure("not_found", "change not found")
            data = json.loads(row[0])
            if scenario == "missing-evidence":
                data.pop("tests")
            return data
        if tool == "standards.read@1.0.0":
            return {"id": "release-review-rubric", "version": "1.0.0", "effective_until": "2027-12-31",
                    "rules": {"failed_tests_risk": "HIGH", "dependency_risk": "MEDIUM", "default_risk": "LOW"},
                    "required_sections": ["summary", "impact", "risks", "test_results", "rollback", "recommendation"],
                    "source": "mock://engineering-standards/release-review-rubric/1.0.0"}
        if tool == "report.draft.create@1.0.0":
            key = args["idempotency_key"]
            with self.connect() as db:
                # A unique external key, rather than a local checkpoint, prevents duplicate effects.
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT data FROM drafts WHERE tenant=? AND project=? AND key=?", (tenant, project, key)).fetchone()
                if existing:
                    draft = json.loads(existing[0])
                    if draft["content_hash"] != digest(args["report"]):
                        raise ToolFailure("conflict", "idempotency key reused with different content")
                    return {"id": draft["id"], "version": draft["version"]}
                row = db.execute("SELECT data FROM changes WHERE tenant=? AND project=? AND id=?", (tenant, project, args["change_id"])).fetchone()
                if not row:
                    raise ToolFailure("not_found", "change not found")
                change = json.loads(row[0])
                if scenario == "source-changed" and count == 1:
                    change["version"] += 1
                    change["tests"] = {"passed": 39, "failed": 0}
                    db.execute("UPDATE changes SET data=? WHERE tenant=? AND project=? AND id=?", (canonical(change), tenant, project, args["change_id"]))
                    db.commit()
                    raise ToolFailure("precondition", "source version changed; no draft was created")
                if change["version"] != args["source_version"]:
                    raise ToolFailure("precondition", "source version mismatch; no draft was created")
                report = json.loads(canonical(args["report"]))
                if scenario == "tampered-draft":
                    report["risk_level"] = "LOW" if report["risk_level"] != "LOW" else "HIGH"
                draft = {"id": "draft-" + digest([tenant, project, key])[:16], "version": 1, "status": "DRAFT",
                         "tenant_id": tenant, "project_id": project, "change_id": args["change_id"],
                         "source_version": args["source_version"], "content_hash": digest(report), "report": report,
                         "created_at": time.time()}
                db.execute("INSERT INTO drafts VALUES(?,?,?,?)", (tenant, project, key, canonical(draft)))
            if scenario in ("response-lost", "unverifiable") and count == 1:
                raise ToolFailure("unknown", "write committed; simulated response lost")
            return {"id": draft["id"], "version": draft["version"]}
        if tool == "report.read@1.0.0":
            if scenario == "unverifiable":
                raise ToolFailure("transient", "draft lookup unavailable; effect cannot be determined")
            with self.connect() as db:
                row = db.execute("SELECT data FROM drafts WHERE tenant=? AND project=? AND key=?", (tenant, project, args["idempotency_key"])).fetchone()
            return {"found": bool(row), "authoritative": True, "draft": json.loads(row[0]) if row else None}
        raise ToolFailure("invalid", "unknown tool")

    def stats(self, tenant, run):
        with self.connect() as db:
            calls = {r["tool"]: r["count"] for r in db.execute("SELECT * FROM calls WHERE tenant=? AND run=?", (tenant, run))}
            # Keys are generated from run identity by the trusted runtime.
            prefix = run + ":report:"
            rows = db.execute("SELECT data FROM drafts WHERE tenant=? AND substr(key,1,?)=?", (tenant, len(prefix), prefix)).fetchall()
        return {"calls": calls, "drafts": [json.loads(r[0]) for r in rows]}
