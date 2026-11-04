"""Measure startup project discovery with disposable synthetic history only."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from statistics import median
import sys
import tempfile
import time
import tracemalloc
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from agent_framework.contracts import TaskContract,canonical,digest
from agent_framework.store import Store
from agent_framework.workspaces import WorkspaceRegistry


def previous_registration(store,tenant):
    """The previous constructor path, kept only for this synthetic comparison."""
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS workspaces (
            tenant TEXT, id TEXT, revision INTEGER, data TEXT, project TEXT,
            deleted INTEGER, created REAL, updated REAL, PRIMARY KEY(tenant,id), UNIQUE(tenant,project))''')
        now=time.time()
        db.execute('INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,0,?,?)',
            (tenant,'workspace-default',1,canonical({'name':'默认工作空间','business':'待配置','scenario':'待配置','description':'请编辑业务与场景，或创建新的工作空间。'}),'project-demo',now,now))
        for row in db.execute('SELECT state FROM runs WHERE tenant_id=?',(tenant,)).fetchall():
            project=json.loads(row[0])['task']['project_id']
            if project=='project-demo':continue
            db.execute('INSERT OR IGNORE INTO workspaces VALUES(?,?,?,?,?,0,?,?)',
                (tenant,'workspace-legacy-'+digest(project)[:16],1,canonical({'name':project,'business':'历史项目','scenario':'历史任务','description':'自动登记的历史项目空间。'}),project,now,now))


def seed(store,tenant,count,projects,body_bytes):
    template=store.create(TaskContract(tenant_id=tenant),{'hash':'synthetic-benchmark-snapshot'},'normal',grant=False)
    with store.transaction() as db:
        for index in range(count):
            state=deepcopy(template);state.update(run_id='run-workspace-benchmark-'+str(index),version=1,status='SUCCEEDED',report={'content':'x'*body_bytes})
            state['task'].update(project_id=projects[index%len(projects)],goal='模拟历史目标-'+str(index))
            db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,1,?)',(tenant,state['run_id'],canonical(state)))
        db.execute('DELETE FROM runs WHERE tenant_id=? AND id=?',(tenant,template['run_id']))
        db.execute('DELETE FROM events WHERE tenant_id=? AND run_id=?',(tenant,template['run_id']))


def measure(store,operation):
    statements=[];decoded=[];connect=store.connect;loads=json.loads
    def traced():
        db=connect();db.set_trace_callback(statements.append);return db
    def decode(value,*args,**kwargs):
        decoded.append(len(value.encode()) if isinstance(value,str) else len(value));return loads(value,*args,**kwargs)
    tracemalloc.start();started=time.perf_counter()
    try:
        with patch.object(store,'connect',traced),patch.object(json,'loads',decode):operation()
        seconds=time.perf_counter()-started;_,peak=tracemalloc.get_traced_memory()
    finally:tracemalloc.stop()
    return {'seconds':round(seconds,6),'python_peak_bytes':peak,'python_json_decodes':len(decoded),
        'python_json_input_bytes':sum(decoded),'reads':sum(sql.lstrip().upper().startswith(('SELECT','WITH')) for sql in statements),
        'insert_attempts':sum(sql.lstrip().upper().startswith('INSERT') for sql in statements)}


def directory(store,tenant):
    # Creation times differ by measurement; identity, scope and user metadata must agree.
    return [{k:row[k] for k in ('id','revision','data','project','deleted')} for row in read_rows(store,tenant)]


def read_rows(store,tenant):
    with store.connect() as db:return [dict(row) for row in db.execute('SELECT * FROM workspaces WHERE tenant=? ORDER BY id',(tenant,))]


def summarize(items):
    return {'median_seconds':median(item['seconds'] for item in items),
        'median_python_peak_bytes':median(item['python_peak_bytes'] for item in items),'measurements':items}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs',type=int,default=240);parser.add_argument('--projects',type=int,default=12)
    parser.add_argument('--body-bytes',type=int,default=131072);parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--compare',action='store_true');args=parser.parse_args()
    if not(1<=args.runs<=2000 and 1<=args.projects<=min(args.runs,100) and 1<=args.body_bytes<=512000 and 1<=args.repeats<=10) or args.runs*args.body_bytes>128*1024*1024:
        parser.error('runs 1–2000; projects 1–min(runs,100); body 1–512000; repeats 1–10; body total at most 128 MiB')
    tenant='tenant-workspace-benchmark';measurements={};invariants={}
    with tempfile.TemporaryDirectory(prefix='agent-workspace-benchmark-') as temporary:
        store=Store(Path(temporary)/'runtime.sqlite3');registry=WorkspaceRegistry(store,tenant)
        custom=registry.save({'name':'保留用户名称','business':'保留业务','scenario':'保留场景','description':'保留说明','revision':0})
        projects=['project-benchmark-'+str(i) for i in range(args.projects)]
        seed(store,tenant,args.runs,[*projects,'project-demo',custom['project_id']],args.body_bytes)
        # The migration must not revive even the deleted default project.
        registry.lifecycle('workspace-default',1,True);preserved=read_rows(store,tenant)
        before_hash=hashlib.sha256()
        with store.connect() as db:
            for row in db.execute('SELECT state FROM runs ORDER BY tenant_id,id'):before_hash.update(row[0].encode())
        operations={'current':lambda:WorkspaceRegistry(store,tenant)}
        if args.compare:operations={'previous':lambda:previous_registration(store,tenant),**operations}
        expected=None
        for phase in ['first_registration','already_registered']:
            measurements[phase]={}
            for label,operation in operations.items():
                items=[]
                for _ in range(args.repeats):
                    if phase=='first_registration':
                        with store.transaction() as db:
                            for project in projects:db.execute('DELETE FROM workspaces WHERE tenant=? AND project=?',(tenant,project))
                    else:WorkspaceRegistry(store,tenant)
                    items.append(measure(store,operation));actual=directory(store,tenant)
                    if expected is None:expected=actual
                    assert actual==expected,'Discovery changed identity, metadata or deletion state'
                    current={row['id']:row for row in read_rows(store,tenant)}
                    assert all(current[row['id']]==row for row in preserved),'Existing workspaces were rewritten'
                measurements[phase][label]=summarize(items)
        after_hash=hashlib.sha256()
        with store.connect() as db:
            for row in db.execute('SELECT state FROM runs ORDER BY tenant_id,id'):after_hash.update(row[0].encode())
        assert before_hash.digest()==after_hash.digest(),'Frozen history changed'
        invariants={'matching_directories':True,'existing_metadata_and_deleted_default_preserved':True,'frozen_history_sha256':after_hash.hexdigest(),'history_unchanged':True,'workspaces':len(expected)}
    print(json.dumps({'runs':args.runs,'unregistered_projects':args.projects,'body_bytes_per_run':args.body_bytes,
        'repeats':args.repeats,'measurements':measurements,'invariants':invariants,
        'scope':'Registry initialization only; Python allocations include tracing; SQLite/native memory, whole-app startup, disk-cold IO and model discovery are not measured'},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
