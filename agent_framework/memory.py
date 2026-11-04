"""Episodic facts and experience candidates, archived with the fenced checkpoint."""
import base64
import json
import time

from .contracts import TERMINAL, canonical, digest


def archive(db, state):
    if state['status'] not in TERMINAL:return
    tenant,run=state['tenant_id'],state['run_id']
    if db.execute('SELECT 1 FROM episodic_memories WHERE tenant=? AND run_id=?',(tenant,run)).fetchone():return
    actions=[json.loads(row[0]) for row in db.execute('SELECT data FROM actions WHERE tenant_id=? AND run_id=? ORDER BY rowid',(tenant,run))]
    if state['status']=='SUCCEEDED' and any(a['status'] in ('OBSERVED','DISPATCHED','UNKNOWN','RECONCILING') for a in actions):
        return
    events=[row[0] for row in db.execute('SELECT kind FROM events WHERE tenant_id=? AND run_id=?',(tenant,run))]
    evidence=[row[0] for row in db.execute('SELECT id FROM evidence WHERE tenant_id=? AND run_id=?',(tenant,run))]
    domain=state['snapshot'].get('compiled_agent',{}).get('domain_pack',{}).get('ref','change-assessment@1.0.0')
    episode={'run_id':run,'goal':state['task']['goal'],'domain_pack_ref':domain,
             'outcome':state['status'],'snapshot_hash':state['snapshot']['hash'],
             'checks':state.get('checks',{}),'evidence_refs':evidence,
             'actions':[{'logical_id':a['logical_id'],'tool_ref':a['tool_ref'],'status':a['status'],
                         'args_hash':a['args_hash'],'attempts':a['attempts']} for a in actions],
             'steps':state['steps'],'replans':state['replans'],'archived_at':time.time(),
             'visibility':'PRIVATE','summary':f"{state['task']['goal']}；结果 {state['status']}，重规划 {state['replans']} 次。"}
    db.execute('INSERT INTO episodic_memories VALUES(?,?,?,?,?,?)',
               (tenant,run,state['task']['project_id'],state['task']['environment'],state['task']['principal'],canonical(episode)))
    # Normal turns retain their real episode; fixed workflow lessons are not inferred.
    if state['task'].get('execution_mode') in ('direct','conversation'):return
    # Candidates are not retrieval context, executable policy, or automatically published.
    from .knowledge import Access, SPACE, insert_asset
    if 'action.unknown' in events or 'action.effect_confirmed' in events:
        category,lesson='uncertain-write','写入状态不明确时先按原幂等键核对，无法确认则转人工，禁止重复创建。'
    elif state['status']=='NEEDS_REVIEW':
        category,lesson='readback-integrity','草稿完成以独立回读内容与证据校验为准；不一致时保留草稿并转人工。'
    else:
        category,lesson='evidence-first','先获取并核对规范和变更证据，再按当前授权提出写入；缺证据不宣称完成。'
    if domain=='knowledge-answer@1.0.0' and category=='evidence-first':
        lesson='先检索并回读已发布知识，以原文与版本证据组织回答；资料不足时请求补充，完成前独立检查来源当前状态。'
    if domain=='general-assistant@1.0.0':
        lesson='按任务目标和自定义工作指令组织交付；需要外部事实时核对来源，信息不足时请求补充，不凭空宣称完成。'
    body={'title':f'运行经验候选 · {category}','content':{'category':category,'lesson':lesson,
          'conditions':{'domain_pack_ref':domain},'supporting_runs':[run],
          'counterexamples_required':True,'limitations':['固定模拟场景，不授予权限、不替代当前标准或独立验收。']},
          'space_ref':SPACE,'source_uri':'local:episode/'+run,'source_version':state['snapshot']['hash'],
          'observed_at':time.time(),'effective_at':0,'effective_until':4102444800,
          'access_policy_ref':'task-scope-owner@1.0.0','sensitivity':'private','critical':False,
          'conflict_key':'','supersedes':None,'standard_ref':None}
    insert_asset(db,Access.task(state['task']),'experience-'+run,1,'EXPERIENCE',body,'CANDIDATE','PRIVATE')


def episode_count(store,access,*,db=None):
    with store.read_snapshot(db) as connection:
        return connection.execute('SELECT COUNT(*) FROM episodic_memories WHERE tenant=? AND project=? AND environment=? AND principal=?',
                                  (access.tenant,access.project,access.environment,access.principal)).fetchone()[0]


def episodes(store, access, query='', limit=12, *, db=None):
    if not isinstance(query,str) or len(query)>2000 or type(limit) is not int or not 1<=limit<=50:raise ValueError('invalid memory query')
    from .knowledge import tokens
    terms=set(tokens(query));scope='tenant=? AND project=? AND environment=? AND principal=?'
    params=(access.tenant,access.project,access.environment,access.principal)
    with store.read_snapshot(db) as connection:
        if not terms:
            rows=connection.execute('SELECT data FROM episodic_memories WHERE '+scope+' ORDER BY rowid DESC LIMIT ?',(*params,limit))
            return [json.loads(row[0]) for row in rows]
        selected=[]
        summaries=connection.execute("SELECT rowid,json_extract(data,'$.summary') AS summary FROM episodic_memories WHERE "+scope+' ORDER BY rowid DESC',params)
        for row in summaries:
            if terms.intersection(tokens(row['summary'])):selected.append(row['rowid'])
            if len(selected)>=limit:break
        if not selected:return []
        rows=connection.execute('SELECT data FROM episodic_memories WHERE '+scope+' AND rowid IN ('+','.join('?' for _ in selected)+') ORDER BY rowid DESC',(*params,*selected))
        return [json.loads(row[0]) for row in rows]


def page(store, access, query='', *, limit=50, cursor=None, db=None):
    """Browse a private, insertion-ordered window without shifting on new archives."""
    from .knowledge import tokens
    from .structured import parse_json
    if not isinstance(query,str) or len(query)>2000:raise ValueError('记忆检索内容须在 2000 字以内')
    if type(limit) is not int:
        if not isinstance(limit,str) or not limit.isascii() or not limit.isdigit() or len(limit)>2:raise ValueError('记忆分页大小须为 1–50')
        limit=int(limit)
    if not 1<=limit<=50:raise ValueError('记忆分页大小须为 1–50')
    params=(access.tenant,access.project,access.environment,access.principal)
    scope='tenant=? AND project=? AND environment=? AND principal=?'
    signature=digest([*params,query,limit]);upper=before=None
    if cursor is not None:
        try:
            if not isinstance(cursor,str) or not cursor or len(cursor)>2048:raise ValueError()
            value=parse_json(base64.b64decode(cursor+'='*(-len(cursor)%4),altchars=b'-_',validate=True).decode('utf-8'))
            if (not isinstance(value,dict) or set(value)!={'v','upper','before','query'}
                    or type(value['v']) is not int or value['v']!=1 or value['query']!=signature
                    or type(value['upper']) is not int or not 0<=value['upper']<9223372036854775807
                    or type(value['before']) is not int or not 1<=value['before']<=value['upper']+1):raise ValueError()
            upper,before=value['upper'],value['before']
        except (ValueError,TypeError,UnicodeError,OverflowError):
            raise ValueError('记忆分页位置无效或条件已变化，请从最新记录开始') from None
    terms=set(tokens(query))
    with store.read_snapshot(db) as connection:
        if upper is None:
            upper=connection.execute('SELECT COALESCE(MAX(rowid),0) FROM episodic_memories WHERE '+scope,params).fetchone()[0]
            before=upper+1
        total=connection.execute('SELECT COUNT(*) FROM episodic_memories WHERE '+scope+' AND rowid<=?',(*params,upper)).fetchone()[0]
        newer=connection.execute('SELECT COUNT(*) FROM episodic_memories WHERE '+scope+' AND rowid>?',(*params,upper)).fetchone()[0]
        if not terms:
            filtered=total
            offset=connection.execute('SELECT COUNT(*) FROM episodic_memories WHERE '+scope+' AND rowid<=? AND rowid>=?',(*params,upper,before)).fetchone()[0]
            rows=connection.execute('SELECT rowid,data FROM episodic_memories WHERE '+scope+' AND rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT ?',(*params,upper,before,limit)).fetchall()
        else:
            selected=[];filtered=offset=0
            summaries=connection.execute("SELECT rowid,json_extract(data,'$.summary') AS summary FROM episodic_memories WHERE "+scope+' AND rowid<=? ORDER BY rowid DESC',(*params,upper))
            for row in summaries:
                if not terms.intersection(tokens(row['summary'])):continue
                filtered+=1
                if row['rowid']>=before:offset+=1
                elif len(selected)<limit:selected.append(row['rowid'])
            rows=connection.execute('SELECT rowid,data FROM episodic_memories WHERE '+scope+' AND rowid IN ('+','.join('?' for _ in selected)+') ORDER BY rowid DESC',(*params,*selected)).fetchall() if selected else []
        items=[json.loads(row['data']) for row in rows]
    def encode(position):
        return base64.urlsafe_b64encode(canonical({'v':1,'upper':upper,'before':position,'query':signature}).encode()).decode().rstrip('=')
    more=offset+len(items)<filtered
    return {'episodes':items,'total':total,'filtered_total':filtered,'offset':offset,'newer_count':newer,'limit':limit,
            'cursor':encode(before),'next_cursor':encode(rows[-1]['rowid']) if more and rows else None,'has_more':more}
