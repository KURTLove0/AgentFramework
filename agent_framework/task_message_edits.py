"""Edit undispatched messages while retaining original submission identities."""
import time

from .contracts import identifier
from .runtime_config import ConfigConflict
from .workspaces import assert_workspace_active


def schema(store):
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS task_message_edits(
            tenant TEXT,task_id TEXT,turn INTEGER,request_id TEXT,revision INTEGER,
            prior_content TEXT,content TEXT,created REAL,
            PRIMARY KEY(tenant,task_id,request_id),UNIQUE(tenant,task_id,turn,revision))''')


def metadata(store,db,tenant,task):
    if not store._optional_table_available(db,'task_message_edits'):return {}
    return {row['turn']:{'edit_revision':row['revision'],'edited_at':row['created']} for row in db.execute('''
        SELECT e.turn,e.revision,e.created FROM task_message_edits e
        JOIN (SELECT turn,MAX(revision) AS revision FROM task_message_edits WHERE tenant=? AND task_id=? GROUP BY turn) latest
        ON e.turn=latest.turn AND e.revision=latest.revision WHERE e.tenant=? AND e.task_id=?''',(tenant,task,tenant,task))}


def original_content(store,db,row):
    first=db.execute('SELECT prior_content FROM task_message_edits WHERE tenant=? AND task_id=? AND turn=? AND revision=1',
                     (row['tenant'],row['task_id'],row['number'])).fetchone() if store._optional_table_available(db,'task_message_edits') else None
    return first['prior_content'] if first else row['content']


def validate_turn(number):
    if type(number) is not int or not 2<=number<=9007199254740991:raise ValueError('仅可修改后续排队消息')


def receipt(row):
    return {'turn':row['turn'],'request_id':row['request_id'],'revision':row['revision'],'content':row['content'],'saved_at':row['created']} if row else None


def update(app,identity,number,data):
    from .task_conversations import TaskConversations,MAX_MESSAGE
    validate_turn(number)
    if not isinstance(data,dict) or set(data)!={'content','revision','request_id'} or type(data['revision']) is not int or not 0<=data['revision']<9007199254740991:
        raise ValueError('请提供消息内容、修改版本和提交编号')
    if not isinstance(data['content'],str) or not 1<=len(data['content'].strip())<=MAX_MESSAGE:raise ValueError('消息须为 1–16000 字')
    content=data['content'].strip();request=identifier(data['request_id']);service=TaskConversations(app);store=service.store
    with app.lock:
        with store.transaction() as db:
            assert_workspace_active(db,app.tenant,app.workspace['id'])
            root=service.root(identity,db=db);identity=root['run_id']
            accepted=db.execute('SELECT * FROM task_message_edits WHERE tenant=? AND task_id=? AND request_id=?',(app.tenant,identity,request)).fetchone()
            if accepted:
                if accepted['turn']!=number or accepted['content']!=content or accepted['revision']!=data['revision']+1:
                    raise ConfigConflict('此修改编号已用于另一份内容，请核对原修改')
            else:
                current=db.execute('''SELECT t.*,r.id AS materialized FROM task_conversation_turns t
                    LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
                    WHERE t.tenant=? AND t.task_id=? AND t.number=?''',(app.tenant,identity,number)).fetchone()
                if not current:raise KeyError('conversation turn not found')
                if current['state']!='QUEUED' or current['materialized']:raise ConfigConflict('这条消息已开始处理或取消，无法修改；本页输入可保留')
                version=db.execute('SELECT COALESCE(MAX(revision),0) FROM task_message_edits WHERE tenant=? AND task_id=? AND turn=?',(app.tenant,identity,number)).fetchone()[0]
                if version!=data['revision']:raise ConfigConflict('这条消息已被修改，请核对当前内容后再保存')
                now=time.time();accepted={'turn':number,'request_id':request,'revision':version+1,'content':content,'created':now}
                db.execute('INSERT INTO task_message_edits VALUES(?,?,?,?,?,?,?,?)',(app.tenant,identity,number,request,version+1,current['content'],content,now))
                db.execute('UPDATE task_conversation_turns SET content=? WHERE tenant=? AND task_id=? AND number=?',(content,app.tenant,identity,number))
                db.execute('UPDATE task_conversations SET revision=revision+1,updated=? WHERE tenant=? AND id=?',(now,app.tenant,identity))
                store.event(db,app.tenant,identity,'conversation.message_edited',{'turn':number,'request_id':request,'revision':version+1})
        service.dispatch(identity)
        return {'task_id':identity,'receipt':receipt(accepted),'detail':app.detail(identity)}


def inspect(app,identity,number,request=None):
    from .task_conversations import TaskConversations
    validate_turn(number)
    if request is not None:identifier(request)
    service=TaskConversations(app);store=service.store
    with store.read_snapshot() as db:
        root=service.root(identity,db=db);identity=root['run_id'];detail=app.detail(identity,db=db)
        turn=next((t for t in detail['conversation']['turns'] if t['number']==number),None)
        if not turn:raise KeyError('conversation turn not found')
        accepted=db.execute('SELECT * FROM task_message_edits WHERE tenant=? AND task_id=? AND turn=? AND request_id=?',
                            (app.tenant,identity,number,request)).fetchone() if request and store._optional_table_available(db,'task_message_edits') else None
        return {'task_id':identity,'receipt':receipt(accepted),'detail':detail}
