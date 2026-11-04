"""Read-only direct task provenance, with stable insertion-order pagination."""
import base64
import json
import time

from .contracts import PolicyDenied,canonical,digest,identifier
from .structured import parse_json
from .store import cancellation_projection


def _root(app,db,identity):
    """Authorize a root without decoding its report or frozen runtime payload."""
    identifier(identity)
    row=db.execute('SELECT task_id,number FROM task_conversation_turns WHERE tenant=? AND run_id=?',(app.tenant,identity)).fetchone()
    root=row['task_id'] if row else identity
    if root!=identity:
        owner=db.execute("SELECT json_extract(state,'$.task.project_id'),json_extract(state,'$.task.principal') FROM runs WHERE tenant_id=? AND id=?",(app.tenant,identity)).fetchone()
        if not owner:raise KeyError('source turn not found')
        if tuple(owner)!=(app.workspace['project_id'],app.principal):raise PolicyDenied('task turn outside current scope')
    source=db.execute("SELECT json_extract(state,'$.task.project_id') AS project,json_extract(state,'$.task.principal') AS principal,json_extract(state,'$.task.source_run_id') AS source,COALESCE(json_extract(state,'$.task.conversation_context.turn'),1) AS turn FROM runs WHERE tenant_id=? AND id=?",(app.tenant,root)).fetchone()
    if not source or source['turn']!=1:raise KeyError('task root not found')
    if source['project']!=app.workspace['project_id'] or source['principal']!=app.principal:raise PolicyDenied('task outside current scope')
    thread=db.execute('SELECT workspace,project,principal FROM task_conversations WHERE tenant=? AND id=?',(app.tenant,root)).fetchone()
    if thread and (thread['workspace'],thread['project'],thread['principal'])!=(app.workspace['id'],app.workspace['project_id'],app.principal):raise PolicyDenied('task conversation outside current scope')
    return root,source['source'],row['number'] if row else 1


def _summaries(app,store,db,identities):
    if not identities:return {}
    names=store._optional_table_available(db,'task_names');archives=store._optional_table_available(db,'task_archives')
    name="COALESCE(n.name,'')" if names else "''";archived='COALESCE(a.archived,0)' if archives else '0'
    joins=('LEFT JOIN task_names n ON n.tenant=r.tenant_id AND n.run_id=r.id AND n.workspace=? AND n.principal=? ' if names else '')+('LEFT JOIN task_archives a ON a.tenant=r.tenant_id AND a.run_id=r.id AND a.workspace=? AND a.principal=? ' if archives else '')
    fields=('status','created_at','updated_at','deadline','model_calls','model_tokens','last_error','interruption','task.goal','snapshot.agent_profile.id','snapshot.agent_profile.name','snapshot.agent_profile.revision','snapshot.agent.identity.name')
    query="SELECT r.id,json_extract(r.state,"+','.join("'$."+field+"'" for field in fields)+') AS fields,'+name+' AS name,'+archived+' AS archived,'+cancellation_projection()+''' AS cancellation FROM runs r '''+joins+''' LEFT JOIN run_cancellations stop_request ON stop_request.tenant_id=r.tenant_id AND stop_request.run_id=r.id
        WHERE r.tenant_id=? AND json_extract(r.state,'$.task.project_id')=? AND json_extract(r.state,'$.task.principal')=? AND r.id IN ('''+','.join('?' for _ in identities)+')'
    params=((app.workspace['id'],app.principal) if names else ())+((app.workspace['id'],app.principal) if archives else ())+(app.tenant,app.workspace['project_id'],app.principal,*identities)
    states=[]
    for row in db.execute(query,params):
        f=dict(zip(fields,json.loads(row['fields'])));state={key:f[key] for key in fields[:8]};state.update(run_id=row['id'],task={'project_id':app.workspace['project_id']},cancellation=json.loads(row['cancellation']) if row['cancellation'] else None,
            title=row['name'] or f['task.goal'],goal=f['task.goal'],archived=bool(row['archived']),agent={'id':f['snapshot.agent_profile.id'],'name':f['snapshot.agent_profile.name'] or f['snapshot.agent.identity.name'],'revision':f['snapshot.agent_profile.revision']})
        states.append(state)
    from .task_conversations import TaskConversations
    return {s['run_id']:{'id':s['run_id'],**{k:s[k] for k in ('title','goal','status','created_at','updated_at','archived','agent')}} for s in TaskConversations(app,store).summary_states(states,db=db)}


def relations(app,identity,params=None,*,store=None):
    store=store or app.control_store;params=params or {}
    def option(key,default=None):
        value=params.get(key,default)
        return (value[0] if value else default) if isinstance(value,list) else value
    try:
        raw=option('limit',20)
        if isinstance(raw,bool) or not isinstance(raw,(str,int)):raise ValueError()
        limit=int(raw)
        if not 1<=limit<=50:raise ValueError()
    except (ValueError,TypeError):raise ValueError('关联任务每页须为 1–50 项') from None
    with store.read_snapshot() as db:
        identity,source,_=_root(app,db,identity);scope=digest([app.tenant,app.workspace['id'],app.workspace['project_id'],app.principal,identity]);captured=time.time()
        # Followup/retry runs share source_run_id but are not independent tasks.
        # Bound candidates to this root and its turns before inspecting task JSON.
        # Include the root explicitly for older, unregistered conversations.
        pool='''WITH source_runs AS (SELECT ? AS run_id UNION SELECT run_id FROM task_conversation_turns WHERE tenant=? AND task_id=?),
            linked AS (SELECT r.rowid AS position,r.id,origin.id AS source_run_id,COALESCE(origin_turn.number,1) AS source_turn
            FROM runs r JOIN runs origin ON origin.tenant_id=r.tenant_id AND origin.id=json_extract(r.state,'$.task.source_run_id')
            LEFT JOIN task_conversation_turns origin_turn ON origin_turn.tenant=r.tenant_id AND origin_turn.run_id=origin.id
            LEFT JOIN task_conversation_turns member ON member.tenant=r.tenant_id AND member.run_id=r.id
            LEFT JOIN task_conversations c ON c.tenant=r.tenant_id AND c.id=r.id
            WHERE r.tenant_id=? AND json_extract(r.state,'$.task.project_id')=? AND json_extract(r.state,'$.task.principal')=?
            AND json_valid(r.state)
            AND json_extract(r.state,'$.task.source_run_id') IS NOT NULL
            AND json_extract(r.state,'$.task.source_run_id') IN (SELECT run_id FROM source_runs)
            AND COALESCE(json_extract(r.state,'$.task.conversation_context.turn'),1)=1 AND (member.number IS NULL OR member.number=1)
            AND (c.id IS NULL OR (c.workspace=? AND c.project=? AND c.principal=?))
            AND json_extract(origin.state,'$.task.project_id')=? AND json_extract(origin.state,'$.task.principal')=?
            AND COALESCE(origin_turn.task_id,origin.id)=? AND r.id!=?) '''
        values=(identity,app.tenant,identity,app.tenant,app.workspace['project_id'],app.principal,app.workspace['id'],app.workspace['project_id'],app.principal,app.workspace['project_id'],app.principal,identity,identity)
        def query(sql,args=()):return db.execute(pool+sql,(*values,*args))
        ceiling=query('SELECT position,id FROM linked ORDER BY position DESC LIMIT 1').fetchone();through=ceiling['position'] if ceiling else 0;head=ceiling['id'] if ceiling else None;before=through+1
        cursor=option('cursor')
        if cursor:
            try:
                if not isinstance(cursor,str) or len(cursor)>2048:raise ValueError()
                value=parse_json(base64.b64decode(cursor+'='*(-len(cursor)%4),altchars=b'-_',validate=True).decode())
                if (not isinstance(value,dict) or set(value)!={'v','scope','through','head','before','anchor'} or type(value['v']) is not int or value['v']!=1 or value['scope']!=scope
                        or type(value['through']) is not int or type(value['before']) is not int or not 0<value['before']<=value['through']<=through):raise ValueError()
                through,head,before=value['through'],identifier(value['head']),value['before'];anchor=identifier(value['anchor'])
                if query('SELECT id FROM linked WHERE position=?',(through,)).fetchone()['id']!=head or query('SELECT id FROM linked WHERE position=?',(before,)).fetchone()['id']!=anchor:raise ValueError()
            except (ValueError,TypeError,KeyError,UnicodeError):raise ValueError('关联任务分页位置已变化，请刷新关联') from None
        total=query('SELECT COUNT(*) FROM linked WHERE position<=?',(through,)).fetchone()[0]
        new_count=query('SELECT COUNT(*) FROM linked WHERE position>?',(through,)).fetchone()[0]
        rows=query('SELECT * FROM linked WHERE position<=? AND position<? ORDER BY position DESC LIMIT ?',(through,before,limit+1)).fetchall();more=len(rows)>limit;rows=rows[:limit]
        parent={'state':'none'};parent_id=None
        if source:
            parent={'state':'unavailable'}
            try:
                # Check the exact source run as well as its containing root.
                owner=db.execute("SELECT json_extract(state,'$.task.project_id') AS project,json_extract(state,'$.task.principal') AS principal FROM runs WHERE tenant_id=? AND id=?",(app.tenant,identifier(source))).fetchone()
                if owner and (owner['project'],owner['principal'])==(app.workspace['project_id'],app.principal):
                    candidate,_,number=_root(app,db,source)
                    if candidate!=identity:parent_id=candidate;parent={'state':'available','source_run_id':source,'turn':number}
            except (KeyError,PolicyDenied,ValueError):pass
        headers=_summaries(app,store,db,list(dict.fromkeys([row['id'] for row in rows]+([parent_id] if parent_id else []))))
        if parent_id:parent['task']=headers[parent_id]
        items=[{**headers[row['id']],'source_run_id':row['source_run_id'],'source_turn':row['source_turn']} for row in rows]
        next_cursor=base64.urlsafe_b64encode(canonical({'v':1,'scope':scope,'through':through,'head':head,'before':rows[-1]['position'],'anchor':rows[-1]['id']}).encode()).decode().rstrip('=') if more else None
        return {'task_id':identity,'source':parent,'items':items,'total':total,'new_count':new_count,'limit':limit,'next_cursor':next_cursor,'snapshot':digest([scope,through,head]),'captured_at':captured}
