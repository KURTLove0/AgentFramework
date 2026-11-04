"""Explicit environment inspection releases a conversation's cleanup hold.

This records a user's decision to continue, never proof that an OS process died.
Saved process IDs are diagnostic only and are not used to signal processes.
"""
import json
import time

from .contracts import TERMINAL,identifier
from .runtime_config import ConfigConflict
from .workspaces import assert_workspace_active


def schema(store):
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS task_cleanup_reviews(
            tenant TEXT,run_id TEXT,run_version INTEGER,task_id TEXT,workspace TEXT,
            principal TEXT,reviewed_at REAL,PRIMARY KEY(tenant,run_id,run_version))''')


def pending(store,tenant,identities,db):
    result={identity:[] for identity in identities}
    reviewed=('AND NOT EXISTS(SELECT 1 FROM task_cleanup_reviews review WHERE review.tenant=r.tenant_id '
              'AND review.run_id=r.id AND review.run_version=r.version)') if store._optional_table_available(db,'task_cleanup_reviews') else ''
    for offset in range(0,len(identities),400):
        batch=identities[offset:offset+400];slots=','.join('(?)' for _ in batch)
        rows=db.execute('''WITH targets(id) AS (VALUES '''+slots+''')
            SELECT COALESCE(t.task_id,r.id) AS task_id,COALESCE(t.number,1) AS turn,
            r.id,r.version,json_extract(r.state,'$.status') AS status,
            json_extract(r.state,'$.cleanup_failure') AS failure
            FROM runs r LEFT JOIN task_conversation_turns t ON t.tenant=r.tenant_id AND t.run_id=r.id
            WHERE r.tenant_id=? AND r.id IN (SELECT id FROM targets UNION
                SELECT child.run_id FROM task_conversation_turns child JOIN targets ON child.task_id=targets.id WHERE child.tenant=?)
            AND json_type(r.state,'$.cleanup_failure')='object' '''+reviewed+' ORDER BY t.number,r.id',
            (*batch,tenant,tenant))
        for row in rows:
            if row['task_id'] not in result:continue
            failure=json.loads(row['failure'])
            result[row['task_id']].append({'run_id':row['id'],'version':row['version'],'turn':row['turn'],'status':row['status'],
                'kind':failure.get('kind'),'pid':failure.get('pid'),'pipes_closed':failure.get('pipes_closed') is True})
    return result


def inspect(app,identity):
    from .task_conversations import TaskConversations
    service=TaskConversations(app);root=service.root(identity)
    with service.store.read_snapshot() as db:
        receipts=[dict(row) for row in db.execute('''SELECT run_id,run_version AS version,reviewed_at FROM task_cleanup_reviews
            WHERE tenant=? AND task_id=? AND workspace=? AND principal=? ORDER BY reviewed_at''',
            (app.tenant,root['run_id'],app.workspace['id'],app.principal))]
        detail=app.detail(root['run_id'],db=db)
    return {'task_id':root['run_id'],'receipts':receipts,'detail':detail}


def review(app,identity,data):
    if (not isinstance(data,dict) or set(data)!={'run_id','version'} or type(data['version']) is not int or data['version']<1):
        raise ValueError('请提供已检查的运行编号和记录版本')
    run_id=identifier(data['run_id'])
    from .task_conversations import TaskConversations
    service=TaskConversations(app);store=service.store
    with app.lock,store.transaction() as db:
        assert_workspace_active(db,app.tenant,app.workspace['id'])
        root=service.root(identity,db=db);identity=root['run_id']
        row=db.execute('''SELECT r.version,r.owner,r.lease_until,json_extract(r.state,'$.status') AS status,
            json_type(r.state,'$.cleanup_failure') AS failure FROM runs r WHERE r.tenant_id=? AND r.id=?
            AND (r.id=? OR EXISTS(SELECT 1 FROM task_conversation_turns t WHERE t.tenant=r.tenant_id
                AND t.run_id=r.id AND t.task_id=?))''',(app.tenant,run_id,identity,identity)).fetchone()
        if not row:raise KeyError('cleanup run not in conversation')
        if row['version']!=data['version'] or row['failure']!='object':raise ConfigConflict('清理记录已变化，请核对当前运行环境后再确认')
        existing=db.execute('SELECT reviewed_at FROM task_cleanup_reviews WHERE tenant=? AND run_id=? AND run_version=?',
                            (app.tenant,run_id,data['version'])).fetchone()
        if existing:reviewed_at=existing['reviewed_at']
        else:
            if row['status'] not in TERMINAL or row['owner'] and row['lease_until']>time.time():
                raise ConfigConflict('本轮仍在结束处理中，请稍后核对运行环境')
            reviewed_at=time.time();service.register(root,db=db)
            db.execute('INSERT INTO task_cleanup_reviews VALUES(?,?,?,?,?,?,?)',
                       (app.tenant,run_id,data['version'],identity,app.workspace['id'],app.principal,reviewed_at))
            db.execute('UPDATE task_conversations SET revision=revision+1,updated=? WHERE tenant=? AND id=?',
                       (reviewed_at,app.tenant,identity))
            store.event(db,app.tenant,identity,'model.cleanup_reviewed',{'run_id':run_id,'version':data['version'],
                'principal':app.principal,'decision':'environment-inspected-allow-continuation'})
    # If dispatch fails, the durable review remains available to a read/retry.
    service.dispatch(identity)
    return {'task_id':identity,'receipt':{'run_id':run_id,'version':data['version'],'reviewed_at':reviewed_at},'detail':app.detail(identity)}
