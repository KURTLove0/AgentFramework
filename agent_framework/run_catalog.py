"""Scoped, header-only projections of authoritative run records."""
import base64
import json
import math
import time

from .contracts import canonical, digest, identifier
from .structured import parse_json
from .store import cancellation_projection


class HistoryQuery:
    def __init__(self, params, scope):
        def option(name, default=None):
            value=params.get(name,default)
            return (value[0] if value else default) if isinstance(value,list) else value
        self.search=str(option('search','') or '').strip()
        if len(self.search)>200:raise ValueError('任务搜索关键词不能超过 200 个字符')
        self.search=self.search.lower()
        self.status=option('status','all') or 'all'
        self.agent=option('agent_id','') or '';self.domain=option('domain','') or ''
        self.sort=option('sort','created_desc')
        self.favorites=option('favorites','all')
        if self.favorites not in {'all','only'}:raise ValueError('不支持的任务收藏范围')
        self.visibility=option('visibility','active')
        if self.visibility not in {'active','archived','all'}:raise ValueError('不支持的任务归档范围')
        if self.sort not in {'created_desc','created_asc','updated_desc','updated_asc'}:
            raise ValueError('不支持的运行排序')
        self.field='created_at' if self.sort.startswith('created') else 'updated_at'
        self.reverse=self.sort.endswith('_desc')
        raw_limit=option('limit')
        try:
            if isinstance(raw_limit,bool):raise ValueError()
            self.limit=200 if raw_limit in (None,'') else int(raw_limit)
            if not 1<=self.limit<=200:raise ValueError()
        except (ValueError,TypeError,OverflowError):
            raise ValueError('运行分页大小须为 1–200') from None
        def timestamp(name):
            value=option(name)
            if value in (None,''):return None
            try:
                if isinstance(value,bool):raise ValueError()
                value=float(value)
                if not math.isfinite(value):raise ValueError()
                return value
            except (ValueError,TypeError,OverflowError):
                raise ValueError('运行日期范围须为有效时间') from None
        self.after,self.before=timestamp('created_after'),timestamp('created_before')
        if self.after is not None and self.before is not None and self.after>self.before:
            raise ValueError('运行结束日期不能早于开始日期')
        self.signature=digest({'scope':scope,'search':self.search,'status':self.status,'agent':self.agent,
                               'domain':self.domain,**({'favorites':self.favorites} if self.favorites!='all' else {}),'after':self.after,'before':self.before,'sort':self.sort,**({'visibility':self.visibility} if self.visibility!='active' else {})})
        self.anchor=None;self.legacy_id=None
        cursor=option('cursor')
        if cursor:
            try:
                if not isinstance(cursor,str) or len(cursor)>2048:raise ValueError()
                decoded=base64.b64decode(cursor+'='*(-len(cursor)%4),altchars=b'-_',validate=True).decode('utf-8')
                if decoded.startswith('{'):
                    value=parse_json(decoded)
                    if (not isinstance(value,dict) or set(value)!={'v','id','value','query'}
                            or type(value['v']) is not int or value['v']!=1 or value['query']!=self.signature
                            or type(value['value']) not in (int,float) or not math.isfinite(value['value'])):
                        raise ValueError()
                    self.anchor=(value['value'],identifier(value['id']))
                else:
                    self.legacy_id=identifier(decoded)
            except (ValueError,TypeError,UnicodeError,OverflowError):
                raise ValueError('运行分页游标无效或条件已变化，请返回第一页') from None

    def key(self,state):
        return state.get(self.field,state['created_at']),state['run_id']

    def following(self,states):
        if self.anchor is not None:
            return [state for state in states if state['run_id']!=self.anchor[1]
                    and (self.key(state)<self.anchor if self.reverse else self.key(state)>self.anchor)]
        if self.legacy_id is not None:
            position=next((index for index,state in enumerate(states) if state['run_id']==self.legacy_id),None)
            if position is None:raise ValueError('运行分页游标无效或已变化，请返回第一页')
            return states[position+1:]
        return states

    def cursor(self,state):
        value={'v':1,'id':state['run_id'],'value':self.key(state)[0],'query':self.signature}
        return base64.urlsafe_b64encode(canonical(value).encode()).decode().rstrip('=')


FIELDS = {
    'run_id': '$.run_id', 'status': '$.status', 'created_at': '$.created_at', 'deadline': '$.deadline',
    'steps': '$.steps', 'replans': '$.replans', 'scenario': '$.scenario', 'last_error': '$.last_error',
    'updated_at': '$.updated_at', 'model_calls': '$.model_calls', 'model_tokens': '$.model_tokens','interruption':'$.interruption',
    'goal': '$.task.goal', 'change_id': '$.task.change_id', 'project_id': '$.task.project_id',
    'principal': '$.task.principal', 'domain_pack_ref': '$.task.domain_pack_ref',
    'source_run_id': '$.task.source_run_id', 'execution_mode': '$.task.execution_mode',
    'planner_ref': '$.snapshot.planner_ref', 'agent_id': '$.snapshot.agent_profile.id',
    'agent_name': '$.snapshot.agent_profile.name', 'agent_revision': '$.snapshot.agent_profile.revision',
    'identity_name': '$.snapshot.agent.identity.name', 'model': '$.snapshot.planner.config.model',
    'domain_id': '$.snapshot.agent_profile.processing_domain.id',
    'domain_name': '$.snapshot.agent_profile.processing_domain.name',
    'domain_revision': '$.snapshot.agent_profile.processing_domain.revision',
    'risk_level': '$.report.risk_level', 'draft': '$.draft',
}


def accessible_roots(app, store, *, compact=False,db=None):
    with store.read_snapshot(db) as connection:
        return _accessible_roots(app,store,compact=compact,db=connection)


def _accessible_roots(app,store,*,compact,db):
    # A registered conversation is private even for a historical root without
    # context_policy. Scope filtering also prevents decoding unrelated snapshots.
    selection = "json_extract(r.state," + ','.join("'" + path + "'" for path in FIELDS.values()) + ')'
    has_archive=store._optional_table_available(db,'task_archives');has_name=store._optional_table_available(db,'task_names');has_favorite=store._optional_table_available(db,'task_favorites')
    archive_columns=',COALESCE(a.archived,0),COALESCE(a.revision,0),a.updated' if has_archive else ',0,0,NULL'
    archive_join='LEFT JOIN task_archives a ON a.tenant=r.tenant_id AND a.run_id=r.id AND a.workspace=? AND a.principal=?' if has_archive else ''
    name_columns=",COALESCE(n.name,''),COALESCE(n.revision,0),n.updated" if has_name else ",'',0,NULL"
    name_join=' LEFT JOIN task_names n ON n.tenant=r.tenant_id AND n.run_id=r.id AND n.workspace=? AND n.principal=?' if has_name else ''
    favorite_columns=',COALESCE(f.favorited,0),COALESCE(f.revision,0),f.updated' if has_favorite else ',0,0,NULL'
    favorite_join=' LEFT JOIN task_favorites f ON f.tenant=r.tenant_id AND f.run_id=r.id AND f.workspace=? AND f.principal=?' if has_favorite else ''
    query = '''SELECT ''' + (selection if compact else 'r.state') + ',' + cancellation_projection() + ' AS cancellation'+archive_columns+name_columns+favorite_columns+''' FROM runs r '''+archive_join+name_join+favorite_join+''' 
        LEFT JOIN run_cancellations stop_request ON stop_request.tenant_id=r.tenant_id AND stop_request.run_id=r.id
        WHERE r.tenant_id=? AND json_extract(r.state,'$.task.project_id')=?
        AND COALESCE(json_extract(r.state,'$.task.conversation_context.turn'),1)=1
        AND (COALESCE(json_extract(r.state,'$.snapshot.context_policy'),'') IN ('','{}','[]',0)
             OR json_extract(r.state,'$.task.principal')=?)
        AND NOT EXISTS(SELECT 1 FROM task_conversations c WHERE c.tenant=r.tenant_id AND c.id=r.id
                       AND (c.workspace!=? OR c.principal!=?))
        ORDER BY r.rowid DESC'''
    rows = db.execute(query, ((app.workspace['id'],app.principal) if has_archive else ())+((app.workspace['id'],app.principal) if has_name else ())+((app.workspace['id'],app.principal) if has_favorite else ())+(app.tenant, app.workspace['project_id'], app.principal,
                              app.workspace['id'], app.principal)).fetchall()
    if not compact:
        result=[]
        for row in rows:
            state=json.loads(row[0]);state['archive']={'archived':bool(row[2]),'revision':row[3],'updated_at':row[4]};state['cancellation']=json.loads(row[1]) if row[1] else None
            state['task_name']={'name':row[5],'revision':row[6],'updated_at':row[7]};state['favorite']={'favorited':bool(row[8]),'revision':row[9],'updated_at':row[10]}
            if state['cancellation']:state['updated_at']=max(state['updated_at'],state['cancellation']['updated_at'])
            result.append(state)
        return result
    result = []
    for row in rows:
        fields = dict(zip(FIELDS, json.loads(row[0])))
        state = {key: fields[key] for key in ('run_id', 'status', 'created_at', 'deadline', 'steps', 'replans',
                                             'scenario', 'last_error', 'model_calls', 'model_tokens', 'draft')}
        state['archive']={'archived':bool(row[2]),'revision':row[3],'updated_at':row[4]}
        state['task_name']={'name':row[5],'revision':row[6],'updated_at':row[7]};state['favorite']={'favorited':bool(row[8]),'revision':row[9],'updated_at':row[10]}
        state['updated_at'] = fields['updated_at'] if fields['updated_at'] is not None else fields['created_at']
        if fields['interruption']:state['interruption']=fields['interruption']
        state['cancellation']=json.loads(row[1]) if row[1] else None
        if state['cancellation']:state['updated_at']=max(state['updated_at'],state['cancellation']['updated_at'])
        state['model_calls'] = fields['model_calls'] or 0
        state['model_tokens'] = fields['model_tokens'] or 0
        state['task'] = {key: fields[key] for key in ('goal', 'change_id', 'project_id', 'principal', 'domain_pack_ref', 'source_run_id', 'execution_mode')}
        profile = {key: fields[value] for key,value in (('id','agent_id'),('name','agent_name'),('revision','agent_revision')) if fields[value] is not None}
        if fields['domain_id']:
            profile['processing_domain'] = {'id': fields['domain_id'], 'name': fields['domain_name'], 'revision': fields['domain_revision']}
        state['snapshot'] = {'planner_ref': fields['planner_ref'], 'agent_profile': profile,
                             'agent': {'identity': {'name': fields['identity_name']}},
                             'planner': {'config': {'model': fields['model']}}}
        state['report'] = {'risk_level': fields['risk_level']} if fields['risk_level'] is not None else None
        result.append(state)
    return result


def active_leases(store,tenant,identities,*,db=None):
    identities=list(dict.fromkeys(identities));result=set();now=time.time()
    with store.read_snapshot(db) as db:
        for offset in range(0,len(identities),400):
            batch=identities[offset:offset+400]
            rows=db.execute('SELECT id FROM runs WHERE tenant_id=? AND owner IS NOT NULL AND owner!=\'\' AND lease_until>? AND id IN ('+
                            ','.join('?' for _ in batch)+')',(tenant,now,*batch)).fetchall()
            result.update(row['id'] for row in rows)
    return result
