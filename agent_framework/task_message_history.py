"""Scoped, read-only and bounded views of immutable queued-message edits."""
import base64
import json

from .contracts import canonical,digest


def history(app,identity,number,params=None,*,store=None):
    from .task_conversations import TaskConversations
    if type(number) is not int or not 1<=number<=9007199254740991:raise ValueError('消息轮次无效')
    params=params or {}
    def option(key,default=None):
        value=params.get(key,default)
        return (value[0] if value else default) if isinstance(value,list) else value
    raw_limit=option('limit',10)
    try:
        if isinstance(raw_limit,bool) or not isinstance(raw_limit,(str,int)):raise ValueError()
        limit=int(raw_limit)
        if not 1<=limit<=20:raise ValueError()
    except (ValueError,TypeError,OverflowError):raise ValueError('修改记录每页须为 1–20 条') from None
    service=TaskConversations(app,store);store=service.store
    with store.read_snapshot() as db:
        root=service.root(identity,db=db);identity=root['run_id']
        scope=digest([app.tenant,app.workspace['id'],app.principal,identity,number])
        turn=db.execute('''SELECT t.content,t.state,t.run_id,r.id AS materialized,
            json_extract(r.state,'$.status') AS status,json_extract(r.state,'$.task.goal') AS execution_content
            FROM task_conversation_turns t LEFT JOIN runs r ON r.tenant_id=t.tenant AND r.id=t.run_id
            WHERE t.tenant=? AND t.task_id=? AND t.number=?''',(app.tenant,identity,number)).fetchone()
        if not turn:raise KeyError('conversation turn not found')
        key=(app.tenant,identity,number);available=store._optional_table_available(db,'task_message_edits')
        latest=db.execute('SELECT COALESCE(MAX(revision),0) FROM task_message_edits WHERE tenant=? AND task_id=? AND turn=?',key).fetchone()[0] if available else 0
        through=latest;before=latest+1;cursor=option('cursor')
        if cursor:
            try:
                if not isinstance(cursor,str) or len(cursor)>1024:raise ValueError()
                value=json.loads(base64.b64decode(cursor+'='*(-len(cursor)%4),altchars=b'-_',validate=True).decode())
                if not isinstance(value,dict) or set(value)!={'v','scope','through','before'} or type(value['v']) is not int or value['v']!=1 or value['scope']!=scope:raise ValueError()
                through,before=value['through'],value['before']
                if type(through) is not int or type(before) is not int or not 1<before<=through<=latest:raise ValueError()
            except (ValueError,TypeError,UnicodeError):raise ValueError('修改记录分页位置无效，请刷新记录') from None
        changes=[];original=turn['content'];total=0
        if available:
            first=db.execute('SELECT prior_content FROM task_message_edits WHERE tenant=? AND task_id=? AND turn=? ORDER BY revision LIMIT 1',key).fetchone()
            if first:original=first['prior_content']
            total=db.execute('SELECT COUNT(*) FROM task_message_edits WHERE tenant=? AND task_id=? AND turn=? AND revision<=?',(*key,through)).fetchone()[0]
            changes=[{'revision':r['revision'],'before':r['prior_content'],'after':r['content'],'saved_at':r['created']} for r in db.execute('''
                SELECT revision,prior_content,content,created FROM task_message_edits
                WHERE tenant=? AND task_id=? AND turn=? AND revision<=? AND revision<? ORDER BY revision DESC LIMIT ?''',(*key,through,before,limit+1))]
        more=len(changes)>limit;changes=changes[:limit]
        next_cursor=base64.urlsafe_b64encode(canonical({'v':1,'scope':scope,'through':through,'before':changes[-1]['revision']}).encode()).decode().rstrip('=') if more else None
        return {'task_id':identity,'turn':number,'original_content':original,
                'current':{'content':turn['content'],'revision':latest,'status':turn['status'] or turn['state']},
                'execution':{'run_id':turn['run_id'],'content':turn['execution_content'],'status':turn['status']} if turn['materialized'] else None,
                'snapshot_revision':through,'latest_revision':latest,'total':total,'limit':limit,'changes':changes,'next_cursor':next_cursor}
