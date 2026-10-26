"""SQLite control-plane store; every checkpoint is fenced and transactional."""

from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import time
import uuid

from .contracts import LeaseBusy, LeaseLost, TaskContract, canonical


class ClosingConnection(sqlite3.Connection):
    """sqlite's built-in context manager commits but does not close the handle."""

    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS compiled_agents (
                    tenant TEXT, hash TEXT, data TEXT, PRIMARY KEY(tenant,hash));
                CREATE TABLE IF NOT EXISTS capability_blocks (
                    tenant_id TEXT, ref TEXT, reason TEXT, PRIMARY KEY(tenant_id, ref));
                CREATE TABLE IF NOT EXISTS native_reads (
                    tenant_id TEXT, run_id TEXT, id TEXT, data TEXT,
                    PRIMARY KEY(tenant_id, run_id, id));
                CREATE TABLE IF NOT EXISTS runs (
                    tenant_id TEXT, id TEXT, version INTEGER NOT NULL, state TEXT NOT NULL,
                    owner TEXT, epoch INTEGER NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0,
                    PRIMARY KEY(tenant_id, id));
                CREATE TABLE IF NOT EXISTS events (
                    tenant_id TEXT, run_id TEXT, seq INTEGER, time REAL, kind TEXT, data TEXT,
                    PRIMARY KEY(tenant_id, run_id, seq));
                CREATE TABLE IF NOT EXISTS actions (
                    tenant_id TEXT, run_id TEXT, logical_id TEXT, status TEXT, data TEXT,
                    PRIMARY KEY(tenant_id, run_id, logical_id));
                CREATE TABLE IF NOT EXISTS outbox (
                    tenant_id TEXT, run_id TEXT, logical_id TEXT, status TEXT,
                    PRIMARY KEY(tenant_id, run_id, logical_id));
                CREATE TABLE IF NOT EXISTS evidence (
                    tenant_id TEXT, run_id TEXT, id TEXT, data TEXT,
                    PRIMARY KEY(tenant_id, run_id, id));
                CREATE TABLE IF NOT EXISTS verifications (
                    tenant_id TEXT, run_id TEXT, id TEXT, data TEXT,
                    PRIMARY KEY(tenant_id, run_id, id));
                CREATE TABLE IF NOT EXISTS grants (
                    tenant_id TEXT, run_id TEXT, principal TEXT, project_id TEXT, environment TEXT,
                    expires_at REAL, revoked INTEGER, args_hash TEXT,
                    PRIMARY KEY(tenant_id, run_id));
                CREATE TABLE IF NOT EXISTS experience_candidates (
                    tenant_id TEXT, run_id TEXT, data TEXT, status TEXT DEFAULT 'PENDING_REVIEW',
                    PRIMARY KEY(tenant_id, run_id));
            """)
        from .knowledge import schema
        with self.connect() as db:schema(db)
        from .agent_evaluation import schema as evaluation_schema
        with self.connect() as db:evaluation_schema(db)

    def save_context(self, state, lease, manifest):
        with self.transaction() as db:
            self.fence(db, state, lease)
            db.execute('INSERT INTO context_manifests VALUES(?,?,?,?)', (state['tenant_id'], state['run_id'], manifest['id'], canonical(manifest)))
            self.event(db,state['tenant_id'],state['run_id'],'context.compiled',
                       {'manifest_id':manifest['id'],'hash':manifest['hash'],'phase':manifest['phase']})

    def contexts(self, tenant, run_id):
        self.load(tenant,run_id)
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT data FROM context_manifests WHERE tenant=? AND run_id=? ORDER BY rowid',(tenant,run_id))]

    def native_read_count(self, state):
        with self.connect() as db:
            return db.execute('SELECT COUNT(*) FROM native_reads WHERE tenant_id=? AND run_id=?',
                              (state['tenant_id'], state['run_id'])).fetchone()[0]

    def capability_disabled(self, tenant, ref):
        with self.connect() as db:
            return db.execute('SELECT 1 FROM capability_blocks WHERE tenant_id=? AND ref=?', (tenant, ref)).fetchone() is not None

    def set_capability_disabled(self, tenant, ref, reason=None):
        with self.transaction() as db:
            if reason:
                db.execute('INSERT OR REPLACE INTO capability_blocks VALUES(?,?,?)', (tenant, ref, reason))
            else:
                db.execute('DELETE FROM capability_blocks WHERE tenant_id=? AND ref=?', (tenant, ref))

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5, factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def event(db, tenant, run, kind, data):
        seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE tenant_id=? AND run_id=?", (tenant, run)).fetchone()[0]
        db.execute("INSERT INTO events VALUES(?,?,?,?,?,?)", (tenant, run, seq, time.time(), kind, canonical(data)))

    def create(self, task: TaskContract, snapshot: dict, scenario: str, grant=True, run_id=None) -> dict:
        now = time.time()
        run_id = run_id or "run-" + uuid.uuid4().hex[:16]
        state = {
            "run_id": run_id, "tenant_id": task.tenant_id, "version": 0, "task": task.to_dict(),
            "snapshot": snapshot, "scenario": scenario, "status": "CREATED", "created_at": now,
            "deadline": now + task.budget.max_wall_seconds,
            "steps": 0, "replans": 0, "model_calls": 0, "model_tokens": 0, "report_revision": 0, "plan": [], "observations": {},
            "report": None, "draft": None, "checks": {}, "last_error": None,
        }
        with self.transaction() as db:
            db.execute("INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,0,?)", (task.tenant_id, run_id, canonical(state)))
            if snapshot.get('compiled_agent'):
                compiled = snapshot['compiled_agent']
                db.execute('INSERT OR IGNORE INTO compiled_agents VALUES(?,?,?)', (task.tenant_id, compiled['hash'], canonical(compiled)))
            if grant:
                db.execute("INSERT INTO grants VALUES(?,?,?,?,?,?,0,NULL)",
                           (task.tenant_id, run_id, task.principal, task.project_id, task.environment, now + 3600))
            self.event(db, task.tenant_id, run_id, "task.created", {"task": task.to_dict(), "snapshot_hash": snapshot["hash"]})
        return state

    def load(self, tenant, run_id):
        with self.connect() as db:
            row = db.execute("SELECT state FROM runs WHERE tenant_id=? AND id=?", (tenant, run_id)).fetchone()
        if row is None:
            raise KeyError(f"run not found in tenant {tenant}: {run_id}")
        return json.loads(row[0])

    def acquire(self, tenant, run_id, seconds):
        owner = uuid.uuid4().hex
        with self.transaction() as db:
            row = db.execute("SELECT * FROM runs WHERE tenant_id=? AND id=?", (tenant, run_id)).fetchone()
            if row is None:
                raise KeyError(run_id)
            if row["owner"] and row["lease_until"] > time.time():
                raise LeaseBusy("another worker owns this run")
            epoch = row["epoch"] + 1
            db.execute("UPDATE runs SET owner=?,epoch=?,lease_until=? WHERE tenant_id=? AND id=?",
                       (owner, epoch, time.time() + seconds, tenant, run_id))
        return (owner, epoch)

    @staticmethod
    def fence(db, state, lease):
        row = db.execute("SELECT * FROM runs WHERE tenant_id=? AND id=?", (state["tenant_id"], state["run_id"])).fetchone()
        if not row or row["owner"] != lease[0] or row["epoch"] != lease[1] or row["lease_until"] <= time.time():
            raise LeaseLost("worker lease expired or was replaced")
        if row["version"] != state["version"]:
            raise LeaseLost("checkpoint version changed")

    def renew(self, state, lease, seconds):
        with self.transaction() as db:
            self.fence(db, state, lease)
            db.execute("UPDATE runs SET lease_until=? WHERE tenant_id=? AND id=?", (time.time() + seconds, state["tenant_id"], state["run_id"]))

    def release(self, state, lease):
        with self.transaction() as db:
            db.execute("UPDATE runs SET owner=NULL,lease_until=0 WHERE tenant_id=? AND id=? AND owner=? AND epoch=?",
                       (state["tenant_id"], state["run_id"], *lease))

    def checkpoint(self, state, lease, kind, data=None, *, action=None, evidence=None, checks=None, experience=None):
        tenant, run = state["tenant_id"], state["run_id"]
        updated = deepcopy(state)
        updated["version"] += 1
        with self.transaction() as db:
            self.fence(db, state, lease)
            db.execute("UPDATE runs SET state=?,version=? WHERE tenant_id=? AND id=?", (canonical(updated), updated["version"], tenant, run))
            if action is not None:
                db.execute("INSERT OR REPLACE INTO actions VALUES(?,?,?,?,?)", (tenant, run, action["logical_id"], action["status"], canonical(action)))
                db.execute("INSERT OR REPLACE INTO outbox VALUES(?,?,?,?)", (tenant, run, action["logical_id"],
                           "PENDING" if action["status"] == "PREPARED" else "DISPATCHED" if action["status"] in ("DISPATCHED", "UNKNOWN") else "DONE"))
            if evidence is not None:
                db.execute("INSERT OR REPLACE INTO evidence VALUES(?,?,?,?)", (tenant, run, evidence["id"], canonical(evidence)))
            if checks is not None:
                for name, result in checks.items():
                    db.execute("INSERT OR REPLACE INTO verifications VALUES(?,?,?,?)", (tenant, run, name, canonical(result)))
            if experience is not None:
                db.execute("INSERT OR REPLACE INTO experience_candidates(tenant_id,run_id,data) VALUES(?,?,?)", (tenant, run, canonical(experience)))
            self.event(db, tenant, run, kind, data or {})
            if updated['status'] in ('SUCCEEDED','FAILED','NEEDS_REVIEW','EXPIRED','CANCELLED'):
                from .memory import archive
                archive(db,updated)
                from .agent_evaluation import record
                record(db,updated)
        state["version"] = updated["version"]

    def actions(self, state):
        with self.connect() as db:
            rows = db.execute("SELECT data FROM actions WHERE tenant_id=? AND run_id=? ORDER BY rowid", (state["tenant_id"], state["run_id"])).fetchall()
        return [json.loads(r[0]) for r in rows]

    def evidence(self, state):
        with self.connect() as db:
            rows = db.execute("SELECT data FROM evidence WHERE tenant_id=? AND run_id=?", (state["tenant_id"], state["run_id"])).fetchall()
        return {json.loads(r[0])["id"]: json.loads(r[0]) for r in rows}

    def events(self, tenant, run_id):
        self.load(tenant, run_id)
        with self.connect() as db:
            rows = db.execute("SELECT seq,time,kind,data FROM events WHERE tenant_id=? AND run_id=? ORDER BY seq", (tenant, run_id)).fetchall()
        return [{**dict(r), "data": json.loads(r["data"])} for r in rows]

    def grant(self, state, args_hash=None, revoke=False):
        task = state["task"]
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO grants VALUES(?,?,?,?,?,?,?,?)", (state["tenant_id"], state["run_id"], task["principal"], task["project_id"], task["environment"], time.time() + 3600, int(revoke), args_hash))
            self.event(db, state["tenant_id"], state["run_id"], "grant.revoked" if revoke else "grant.issued", {"args_hash": args_hash})

    def get_grant(self, state):
        with self.connect() as db:
            row = db.execute("SELECT * FROM grants WHERE tenant_id=? AND run_id=?", (state["tenant_id"], state["run_id"])).fetchone()
        return dict(row) if row else None

    def result(self, tenant, run_id):
        state = self.load(tenant, run_id)
        actions = self.actions(state)
        with self.connect() as db:
            exp = db.execute("SELECT data,status FROM experience_candidates WHERE tenant_id=? AND run_id=?", (tenant, run_id)).fetchone()
        with self.connect() as db:
            native = [json.loads(r[0]) for r in db.execute('SELECT data FROM native_reads WHERE tenant_id=? AND run_id=? ORDER BY rowid', (tenant, run_id))]
        return {**state, "actions": actions, "native_reads": native, "residual_effects": [a for a in actions if a["tool_ref"].startswith("report.draft.create") and a["status"] not in ("PREPARED", "REJECTED", "CONFIRMED_NOT_APPLIED")],
                "experience_candidate": {"data": json.loads(exp[0]), "status": exp[1]} if exp else None}
