"""Private, reversible task organization kept separate from execution state."""
import time

from .runtime_config import ConfigConflict
from .workspaces import assert_workspace_active


def schema(store):
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS task_archives(
            tenant TEXT,workspace TEXT,principal TEXT,run_id TEXT,archived INTEGER,
            revision INTEGER,updated REAL,PRIMARY KEY(tenant,workspace,principal,run_id))''')


def key(app, identity):return app.tenant,app.workspace['id'],app.principal,identity


def read(app,store,identity,db):
    row=db.execute('SELECT archived,revision,updated FROM task_archives WHERE tenant=? AND workspace=? AND principal=? AND run_id=?',key(app,identity)).fetchone() if store._optional_table_available(db,'task_archives') else None
    return {'archived':bool(row[0]),'revision':row[1],'updated_at':row[2]} if row else {'archived':False,'revision':0,'updated_at':None}


def write(app,store,identity,db,archived,current,reason):
    saved={'archived':archived,'revision':current['revision']+1,'updated_at':time.time()}
    db.execute('INSERT OR REPLACE INTO task_archives VALUES(?,?,?,?,?,?,?)',(*key(app,identity),int(archived),saved['revision'],saved['updated_at']))
    if reason!='new-message' or current['archived']:
        store.event(db,app.tenant,identity,'task.archived' if archived else 'task.restored',{'principal':app.principal,'revision':saved['revision'],'reason':reason})
    return saved


def restore_for_message(app,store,identity,db):
    current=read(app,store,identity,db)
    # Even an unarchived task advances: an older in-flight archive must not
    # hide a message accepted after the user last inspected that task.
    write(app,store,identity,db,False,current,'new-message')


def assert_archivable(app,store,root,db):
    from .task_cleanup import pending
    if pending(store,app.tenant,[root['run_id']],db)[root['run_id']]:
        raise ConfigConflict('请先检查并确认运行环境，再归档任务')
    rows=db.execute('''SELECT t.state,json_extract(r.state,'$.status') AS status,r.owner,r.lease_until,
        (stop.run_id IS NOT NULL AND stop.completed_at IS NULL) AS stopping
        FROM task_conversation_turns t LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
        LEFT JOIN run_cancellations stop ON stop.tenant_id=t.tenant AND stop.run_id=t.run_id
        WHERE t.tenant=? AND t.task_id=? ORDER BY t.number''',(app.tenant,root['run_id'])).fetchall()
    if not rows:
        rows=db.execute('''SELECT '' AS state,json_extract(r.state,'$.status') AS status,r.owner,r.lease_until,
            (stop.run_id IS NOT NULL AND stop.completed_at IS NULL) AS stopping FROM runs r
            LEFT JOIN run_cancellations stop ON stop.tenant_id=r.tenant_id AND stop.run_id=r.id
            WHERE r.tenant_id=? AND r.id=?''',(app.tenant,root['run_id'])).fetchall()
    statuses=[]
    for row in rows:
        if row['state']=='CANCELLED':continue
        status=row['status'] or row['state'];statuses.append(status)
        if status not in {'SUCCEEDED','FAILED','EXPIRED','CANCELLED','ERROR','WAITING_INPUT','NEEDS_REVIEW'} or row['stopping'] or row['owner'] and row['lease_until']>time.time():
            raise ConfigConflict('任务仍在执行、排队或处理停止请求，结束后可归档')
    if not statuses or statuses[-1] not in {'SUCCEEDED','FAILED','EXPIRED','CANCELLED','ERROR'}:
        raise ConfigConflict('任务仍需补充、授权或人工核对，处理后可归档')
    uncertain=db.execute('''SELECT 1 FROM actions a WHERE a.tenant_id=?
        AND (a.run_id=? OR a.run_id IN (SELECT run_id FROM task_conversation_turns WHERE tenant=? AND task_id=?))
        AND json_extract(a.data,'$.status') IN ('DISPATCHED','UNKNOWN','RECONCILING','NEEDS_REVIEW') LIMIT 1''',
        (app.tenant,root['run_id'],app.tenant,root['run_id'])).fetchone()
    if uncertain:raise ConfigConflict('任务仍有待核对的操作，确认结果后可归档')


def update(app,identity,data):
    if not isinstance(data,dict) or set(data)!={'archived','revision'} or type(data['archived']) is not bool or type(data['revision']) is not int or data['revision']<0:
        raise ValueError('请提供归档状态和当前版本')
    from .task_conversations import TaskConversations
    service=TaskConversations(app);store=service.store
    with app.lock,store.transaction() as db:
        assert_workspace_active(db,app.tenant,app.workspace['id'])
        root=service.root(identity,db=db);identity=root['run_id'];current=read(app,store,identity,db)
        if data['revision']!=current['revision']:
            if data['revision']+1!=current['revision'] or data['archived']!=current['archived']:
                raise ConfigConflict('任务归档状态已变化，请核对当前状态后再操作')
            receipt=current
        elif data['archived']==current['archived']:receipt=current
        else:
            if data['archived']:assert_archivable(app,store,root,db)
            receipt=write(app,store,identity,db,data['archived'],current,'user')
    return {'task_id':identity,'receipt':receipt,'detail':app.detail(identity)}


def inspect(app,identity):
    from .task_conversations import TaskConversations
    root=TaskConversations(app).root(identity)
    return {'task_id':root['run_id'],'detail':app.detail(root['run_id'])}
