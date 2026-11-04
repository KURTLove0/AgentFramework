"""Scoped task favorites with independent compare-and-swap revisions."""
import time

from .runtime_config import ConfigConflict
from .workspaces import assert_workspace_active


def schema(store):
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS task_favorites(
            tenant TEXT,workspace TEXT,principal TEXT,run_id TEXT,favorited INTEGER,
            revision INTEGER,updated REAL,PRIMARY KEY(tenant,workspace,principal,run_id))''')


def key(app,identity):return app.tenant,app.workspace['id'],app.principal,identity


def read(app,store,identity,db):
    row=db.execute('SELECT favorited,revision,updated FROM task_favorites WHERE tenant=? AND workspace=? AND principal=? AND run_id=?',key(app,identity)).fetchone() if store._optional_table_available(db,'task_favorites') else None
    return {'favorited':bool(row[0]),'revision':row[1],'updated_at':row[2]} if row else {'favorited':False,'revision':0,'updated_at':None}


def update(app,identity,data):
    if not isinstance(data,dict) or set(data)!={'favorited','revision'} or type(data['favorited']) is not bool or type(data['revision']) is not int or not 0<=data['revision']<=9007199254740991:
        raise ValueError('请提供收藏状态和当前版本')
    from .task_conversations import TaskConversations
    service=TaskConversations(app);store=service.store
    with app.lock,store.transaction() as db:
        assert_workspace_active(db,app.tenant,app.workspace['id'])
        root=service.root(identity,db=db);identity=root['run_id'];current=read(app,store,identity,db)
        if data['revision']!=current['revision']:
            if data['revision']+1!=current['revision'] or data['favorited']!=current['favorited']:
                raise ConfigConflict('收藏状态已变化，请核对当前状态后再操作')
            receipt=current
        elif data['favorited']==current['favorited']:receipt=current
        else:
            receipt={'favorited':data['favorited'],'revision':current['revision']+1,'updated_at':time.time()}
            db.execute('INSERT OR REPLACE INTO task_favorites VALUES(?,?,?,?,?,?,?)',(*key(app,identity),int(receipt['favorited']),receipt['revision'],receipt['updated_at']))
            store.event(db,app.tenant,identity,'task.favorite_changed',{'principal':app.principal,'revision':receipt['revision']})
    return {'task_id':identity,'receipt':receipt,'detail':app.detail(identity)}


def inspect(app,identity):
    from .task_conversations import TaskConversations
    service=TaskConversations(app)
    with service.store.read_snapshot() as db:
        root=service.root(identity,db=db)
        return {'task_id':root['run_id'],'detail':app.detail(root['run_id'],db=db)}
