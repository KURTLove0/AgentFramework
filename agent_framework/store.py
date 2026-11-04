"""SQLite control-plane store; every checkpoint is fenced and transactional."""

from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import time
import uuid

from .contracts import LeaseBusy, LeaseLost, PolicyDenied, TaskContract, TERMINAL, canonical


def cancellation_projection(alias='stop_request'):
    fields=('generation','requested_at','updated_at','requested_by','source','error','completed_at','outcome')
    values=','.join("'"+field+"',"+alias+'.'+field for field in fields)
    return "CASE WHEN "+alias+".run_id IS NULL THEN NULL ELSE json_object("+values+",'pending',json(CASE WHEN "+alias+".completed_at IS NULL THEN 'true' ELSE 'false' END)) END"


class ClosingConnection(sqlite3.Connection):
    """sqlite's built-in context manager commits but does not close the handle."""

    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Store:
    def __init__(self, path: str | Path, *, read_only=False):
        self.path = Path(path).resolve()
        self.read_only=read_only
        if read_only:
            if not self.path.is_file():raise ValueError('已有数据库不存在：'+str(self.path))
            return
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
                CREATE INDEX IF NOT EXISTS runs_source ON runs(tenant_id,json_extract(state,'$.task.source_run_id'))
                    WHERE json_valid(state);
                CREATE TABLE IF NOT EXISTS events (
                    tenant_id TEXT, run_id TEXT, seq INTEGER, time REAL, kind TEXT, data TEXT,
                    PRIMARY KEY(tenant_id, run_id, seq));
                CREATE INDEX IF NOT EXISTS events_kind ON events(tenant_id,run_id,kind,seq);
                CREATE INDEX IF NOT EXISTS events_progress_kind ON events(tenant_id,run_id,json_extract(data,'$.kind'),seq)
                    WHERE kind='model.progress';
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
                CREATE TABLE IF NOT EXISTS task_drafts (
                    tenant TEXT, workspace TEXT, principal TEXT, revision INTEGER NOT NULL,
                    data TEXT NOT NULL, updated REAL NOT NULL,
                    PRIMARY KEY(tenant, workspace, principal));
                CREATE TABLE IF NOT EXISTS run_cancellations (
                    tenant_id TEXT, run_id TEXT, generation INTEGER NOT NULL,
                    requested_at REAL NOT NULL, updated_at REAL NOT NULL, requested_by TEXT, source TEXT,
                    error TEXT, completed_at REAL, outcome TEXT, PRIMARY KEY(tenant_id,run_id));
                CREATE INDEX IF NOT EXISTS run_cancellations_pending ON run_cancellations(tenant_id,requested_at,run_id) WHERE completed_at IS NULL;
                CREATE TABLE IF NOT EXISTS run_permission_dispatches (
                    tenant TEXT, workspace TEXT, principal TEXT, run_id TEXT, proof TEXT,
                    logical_id TEXT, args_hash TEXT, requested REAL, error TEXT,
                    PRIMARY KEY(tenant,run_id));
                CREATE TABLE IF NOT EXISTS workflow_chats (
                    tenant TEXT, workspace TEXT, principal TEXT, id TEXT,
                    revision INTEGER, data TEXT, PRIMARY KEY(tenant,id));
                CREATE TABLE IF NOT EXISTS workflow_chat_requests (
                    tenant TEXT, workspace TEXT, principal TEXT, request_id TEXT,
                    payload TEXT NOT NULL, state TEXT NOT NULL, owner TEXT NOT NULL,
                    lease_until REAL NOT NULL, attempt INTEGER NOT NULL,
                    chat_id TEXT NOT NULL, response TEXT, error TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL,
                    PRIMARY KEY(tenant,workspace,principal,request_id));
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

    def contexts(self, tenant, run_id, *, db=None):
        with self.read_snapshot(db) as db:
            self.load(tenant,run_id,db=db)
            if not self._optional_table_available(db,'context_manifests'):return []
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
        db = sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True,timeout=5,factory=ClosingConnection) if self.read_only else sqlite3.connect(self.path,timeout=5,factory=ClosingConnection)
        db.row_factory = sqlite3.Row
        try:
            if self.read_only:
                db.execute('PRAGMA query_only=ON')
                db.execute('PRAGMA trusted_schema=OFF')
        except BaseException:
            db.close()
            raise
        return db

    def _optional_table_available(self,db,name):
        # Normal runtimes initialize these tables. Historical inspection must
        # accept an absent later addition without migrating the source file.
        return not self.read_only or db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(name,)).fetchone() is not None

    @contextmanager
    def read_snapshot(self,db=None):
        """Reuse one SQLite read snapshot without holding a writer lock."""
        if db is not None:
            yield db
            return
        with self.connect() as connection:
            connection.execute('BEGIN')
            yield connection

    @contextmanager
    def transaction(self):
        if self.read_only:raise ValueError('只读历史存储不能执行写操作')
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

    def create(self, task: TaskContract, snapshot: dict, scenario: str, grant=True, run_id=None, *, on_created=None) -> dict:
        """Commit the run and optional initial control records in one transaction.

        on_created uses this connection; execution may start only after commit.
        """
        now = time.time()
        run_id = run_id or "run-" + uuid.uuid4().hex[:16]
        state = {
            "run_id": run_id, "tenant_id": task.tenant_id, "version": 0, "task": task.to_dict(),
            "snapshot": snapshot, "scenario": scenario, "status": "CREATED", "created_at": now, "updated_at": now,
            "deadline": now + task.budget.max_wall_seconds,
            "steps": 0, "replans": 0, "model_calls": 0, "model_tokens": 0, "report_revision": 0, "plan": [], "observations": {},
            "report": None, "draft": None, "checks": {}, "last_error": None,
        }
        with self.transaction() as db:
            # CLI stores can predate workspaces. Once registered, a deleted
            # project cannot accept a run from an already-scoped process.
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'").fetchone():
                workspace=db.execute('SELECT deleted FROM workspaces WHERE tenant=? AND project=?',(task.tenant_id,task.project_id)).fetchone()
                if workspace and workspace['deleted']:raise KeyError('workspace unavailable')
            db.execute("INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,0,?)", (task.tenant_id, run_id, canonical(state)))
            if snapshot.get('compiled_agent'):
                compiled = snapshot['compiled_agent']
                db.execute('INSERT OR IGNORE INTO compiled_agents VALUES(?,?,?)', (task.tenant_id, compiled['hash'], canonical(compiled)))
            if grant:
                db.execute("INSERT INTO grants VALUES(?,?,?,?,?,?,0,NULL)",
                           (task.tenant_id, run_id, task.principal, task.project_id, task.environment, now + 3600))
            self.event(db, task.tenant_id, run_id, "task.created", {"task": task.to_dict(), "snapshot_hash": snapshot["hash"]})
            if on_created:on_created(db,state)
        return state

    def load(self, tenant, run_id, *, db=None):
        with self.read_snapshot(db) as db:
            row = db.execute("SELECT state FROM runs WHERE tenant_id=? AND id=?", (tenant, run_id)).fetchone()
        if row is None:
            raise KeyError(f"run not found in tenant {tenant}: {run_id}")
        return json.loads(row[0])

    def cancellation(self,tenant,run_id,*,db=None):
        if db is None:
            with self.connect() as connection:return self.cancellation(tenant,run_id,db=connection)
        if not self._optional_table_available(db,'run_cancellations'):return None
        row=db.execute('SELECT * FROM run_cancellations WHERE tenant_id=? AND run_id=?',(tenant,run_id)).fetchone()
        if not row:return None
        return {**{k:row[k] for k in row.keys() if k not in ('tenant_id','run_id')},'pending':row['completed_at'] is None}

    def request_cancellation(self,tenant,run_id,*,principal=None,source='runtime',retry=False):
        with self.transaction() as db:
            row=db.execute('SELECT state FROM runs WHERE tenant_id=? AND id=?',(tenant,run_id)).fetchone()
            if not row:raise KeyError(run_id)
            state=json.loads(row[0]);prior=self.cancellation(tenant,run_id,db=db)
            if state['status'] in TERMINAL:
                self.resolve_cancellation(db,tenant,run_id,state['status']);return self.cancellation(tenant,run_id,db=db)
            now=time.time();actor=principal or state['task']['principal']
            if not prior:
                db.execute('INSERT INTO run_cancellations VALUES(?,?,1,?,?,?,?,NULL,NULL,NULL)',(tenant,run_id,now,now,actor,source))
                self.event(db,tenant,run_id,'run.cancel_requested',{'source':source,'requested_by':actor,'generation':1})
            elif prior['pending'] and prior['error'] and retry:
                db.execute('UPDATE run_cancellations SET error=NULL,generation=generation+1,updated_at=?,requested_by=?,source=? WHERE tenant_id=? AND run_id=?',(now,actor,source,tenant,run_id))
                self.event(db,tenant,run_id,'run.cancel_retried',{'source':source,'requested_by':actor,'generation':prior['generation']+1})
            return self.cancellation(tenant,run_id,db=db)

    def resolve_cancellation(self,db,tenant,run_id,status):
        if status not in TERMINAL:return
        now=time.time()
        changed=db.execute('UPDATE run_cancellations SET completed_at=?,updated_at=?,outcome=?,error=NULL WHERE tenant_id=? AND run_id=? AND completed_at IS NULL',(now,now,status,tenant,run_id)).rowcount
        if changed:self.event(db,tenant,run_id,'run.cancel_completed',{'outcome':status})

    def fail_cancellation(self,tenant,run_id,generation,message):
        with self.transaction() as db:
            changed=db.execute('UPDATE run_cancellations SET error=?,updated_at=? WHERE tenant_id=? AND run_id=? AND generation=? AND completed_at IS NULL AND error IS NULL',
                               (message,time.time(),tenant,run_id,generation)).rowcount
            if changed:self.event(db,tenant,run_id,'run.cancel_failed',{'generation':generation,'message':message})
        return bool(changed)

    def begin_execution(self, tenant, run_id, *, automatic=False,cancelling=False):
        """Fence queued attempts before handing one to a process-local executor."""
        with self.transaction() as db:
            row=db.execute('SELECT * FROM runs WHERE tenant_id=? AND id=?',(tenant,run_id)).fetchone()
            if not row:raise KeyError(run_id)
            state=json.loads(row['state'])
            if state['status'] in TERMINAL:raise LeaseBusy('运行已结束，不能继续执行')
            if row['owner'] and row['lease_until']>time.time():raise LeaseBusy('运行仍由工作进程持有，请稍后重试')
            cancellation=self.cancellation(tenant,run_id,db=db)
            if cancellation and cancellation['pending'] and not cancelling:raise LeaseBusy('停止请求尚未完成，请等待或重试停止，不能恢复执行')
            previous=state.get('interruption')
            if previous and automatic and not cancelling:raise LeaseBusy('本轮执行已中断，请检查后手动恢复原任务')
            epoch=row['epoch']+1
            if previous and not cancelling:
                state.pop('interruption');state.update(version=row['version']+1,updated_at=time.time())
                db.execute('UPDATE runs SET state=?,version=? WHERE tenant_id=? AND id=?',(canonical(state),state['version'],tenant,run_id))
                self.event(db,tenant,run_id,'worker.retry_requested',{'code':previous['code'],'previous_epoch':previous['epoch']})
            db.execute('UPDATE runs SET epoch=?,owner=NULL,lease_until=0 WHERE tenant_id=? AND id=?',(epoch,tenant,run_id))
        return epoch

    def interrupt_execution(self, tenant, run_id, epoch, *, kind, code, message, exception_type):
        """Only the failed attempt may publish a diagnostic; never store raw exceptions."""
        with self.transaction() as db:
            row=db.execute('SELECT * FROM runs WHERE tenant_id=? AND id=?',(tenant,run_id)).fetchone()
            if not row or row['epoch']!=epoch:return False
            state=json.loads(row['state'])
            if state['status'] in TERMINAL|{'WAITING_AUTH','WAITING_INPUT'}:return False
            if state.get('interruption',{}).get('epoch')==epoch:return True
            diagnostic={'kind':kind,'code':code,'message':message,'exception_type':exception_type,'epoch':epoch,'at':time.time()}
            state.update(interruption=diagnostic,version=row['version']+1,updated_at=diagnostic['at'])
            db.execute('UPDATE runs SET state=?,version=? WHERE tenant_id=? AND id=?',(canonical(state),state['version'],tenant,run_id))
            self.event(db,tenant,run_id,'worker.interrupted',diagnostic)
        return True

    def acquire(self, tenant, run_id, seconds, *, expected_epoch=None):
        owner = uuid.uuid4().hex
        with self.transaction() as db:
            row = db.execute("SELECT * FROM runs WHERE tenant_id=? AND id=?", (tenant, run_id)).fetchone()
            if row is None:
                raise KeyError(run_id)
            if expected_epoch is not None and row['epoch']!=expected_epoch:
                raise LeaseLost('execution attempt was superseded')
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
        updated["updated_at"] = time.time()
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
                self.resolve_cancellation(db,tenant,run,updated['status'])
                from .memory import archive
                archive(db,updated)
                from .agent_evaluation import record
                record(db,updated)
        state["version"] = updated["version"]

    def actions(self, state, *, db=None):
        with self.read_snapshot(db) as db:
            rows = db.execute("SELECT data FROM actions WHERE tenant_id=? AND run_id=? ORDER BY rowid", (state["tenant_id"], state["run_id"])).fetchall()
        return [json.loads(r[0]) for r in rows]

    def evidence(self, state, *, db=None):
        with self.read_snapshot(db) as db:
            rows = db.execute("SELECT data FROM evidence WHERE tenant_id=? AND run_id=?", (state["tenant_id"], state["run_id"])).fetchall()
        return {json.loads(r[0])["id"]: json.loads(r[0]) for r in rows}

    def events(self, tenant, run_id, *, db=None):
        with self.read_snapshot(db) as db:
            self.load(tenant,run_id,db=db)
            rows = db.execute("SELECT seq,time,kind,data FROM events WHERE tenant_id=? AND run_id=? ORDER BY seq", (tenant, run_id)).fetchall()
        return [{**dict(r), "data": json.loads(r["data"])} for r in rows]

    def grant(self, state, args_hash=None, revoke=False, *, db=None):
        if db is None:
            with self.transaction() as connection:
                return self.grant(state, args_hash, revoke, db=connection)
        task = state["task"]
        cancellation=self.cancellation(state['tenant_id'],state['run_id'],db=db)
        if not revoke and cancellation and cancellation['pending']:raise PolicyDenied('任务正在停止，不能新增执行授权')
        db.execute("INSERT OR REPLACE INTO grants VALUES(?,?,?,?,?,?,?,?)", (state["tenant_id"], state["run_id"], task["principal"], task["project_id"], task["environment"], time.time() + 3600, int(revoke), args_hash))
        self.event(db, state["tenant_id"], state["run_id"], "grant.revoked" if revoke else "grant.issued", {"args_hash": args_hash})

    def get_grant(self, state, *, db=None):
        with self.read_snapshot(db) as db:
            row = db.execute("SELECT * FROM grants WHERE tenant_id=? AND run_id=?", (state["tenant_id"], state["run_id"])).fetchone()
        return dict(row) if row else None

    def result(self, tenant, run_id, *, db=None):
        with self.read_snapshot(db) as db:
            row=db.execute('SELECT state FROM runs WHERE tenant_id=? AND id=?',(tenant,run_id)).fetchone()
            if not row:raise KeyError(run_id)
            state=json.loads(row[0]);cancellation=self.cancellation(tenant,run_id,db=db)
            actions=self.actions(state,db=db)
            exp = db.execute("SELECT data,status FROM experience_candidates WHERE tenant_id=? AND run_id=?", (tenant, run_id)).fetchone() if self._optional_table_available(db,'experience_candidates') else None
            native = [json.loads(r[0]) for r in db.execute('SELECT data FROM native_reads WHERE tenant_id=? AND run_id=? ORDER BY rowid', (tenant, run_id))] if self._optional_table_available(db,'native_reads') else []
        return {**state, 'cancellation':cancellation,"actions": actions, "native_reads": native, "residual_effects": [a for a in actions if a["tool_ref"].startswith("report.draft.create") and a["status"] not in ("PREPARED", "REJECTED", "CONFIRMED_NOT_APPLIED")],
                "experience_candidate": {"data": json.loads(exp[0]), "status": exp[1]} if exp else None}
