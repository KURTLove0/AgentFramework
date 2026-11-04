"""Private display names, independent of immutable task requirements."""
import time
import unicodedata

from .runtime_config import ConfigConflict
from .workspaces import assert_workspace_active


def schema(store):
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS task_names(
            tenant TEXT,workspace TEXT,principal TEXT,run_id TEXT,name TEXT,
            revision INTEGER,updated REAL,PRIMARY KEY(tenant,workspace,principal,run_id))''')


def key(app,identity):return app.tenant,app.workspace['id'],app.principal,identity


def read(app,store,identity,db):
    row=db.execute('SELECT name,revision,updated FROM task_names WHERE tenant=? AND workspace=? AND principal=? AND run_id=?',key(app,identity)).fetchone() if store._optional_table_available(db,'task_names') else None
    return {'name':row[0],'revision':row[1],'updated_at':row[2]} if row else {'name':'','revision':0,'updated_at':None}


def update(app,identity,data):
    if not isinstance(data,dict) or set(data)!={'name','revision'} or not isinstance(data['name'],str) or type(data['revision']) is not int or not 0<=data['revision']<=9007199254740991:
        raise ValueError('请提供任务名称和当前版本')
    if any(unicodedata.category(c) in {'Cc','Cs'} for c in data['name']):raise ValueError('任务名称须为单行文字，不含控制字符')
    name=data['name'].strip()
    if len(name)>120:raise ValueError('任务名称最多 120 个字符')
    from .task_conversations import TaskConversations
    service=TaskConversations(app);store=service.store
    with app.lock,store.transaction() as db:
        assert_workspace_active(db,app.tenant,app.workspace['id'])
        root=service.root(identity,db=db);identity=root['run_id'];current=read(app,store,identity,db)
        if data['revision']!=current['revision']:
            if data['revision']+1!=current['revision'] or name!=current['name']:raise ConfigConflict('任务名称已变化，请核对当前名称后再保存')
            receipt=current
        elif name==current['name']:receipt=current
        else:
            receipt={'name':name,'revision':current['revision']+1,'updated_at':time.time()}
            db.execute('INSERT OR REPLACE INTO task_names VALUES(?,?,?,?,?,?,?)',(*key(app,identity),name,receipt['revision'],receipt['updated_at']))
            # Older public run audits must not expose this private display name.
            store.event(db,app.tenant,identity,'task.renamed',{'principal':app.principal,'revision':receipt['revision']})
    return {'task_id':identity,'receipt':receipt,'detail':app.detail(identity)}


def inspect(app,identity):
    from .task_conversations import TaskConversations
    root=TaskConversations(app).root(identity)
    return {'task_id':root['run_id'],'detail':app.detail(root['run_id'])}
