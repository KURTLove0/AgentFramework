"""Episodic facts and experience candidates, archived with the fenced checkpoint."""
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
    body={'title':f'运行经验候选 · {category}','content':{'category':category,'lesson':lesson,
          'conditions':{'domain_pack_ref':domain},'supporting_runs':[run],
          'counterexamples_required':True,'limitations':['固定模拟场景，不授予权限、不替代当前标准或独立验收。']},
          'space_ref':SPACE,'source_uri':'local:episode/'+run,'source_version':state['snapshot']['hash'],
          'observed_at':time.time(),'effective_at':0,'effective_until':4102444800,
          'access_policy_ref':'task-scope-owner@1.0.0','sensitivity':'private','critical':False,
          'conflict_key':'','supersedes':None,'standard_ref':None}
    insert_asset(db,Access.task(state['task']),'experience-'+run,1,'EXPERIENCE',body,'CANDIDATE','PRIVATE')


def episodes(store, access, query='', limit=12):
    if not isinstance(query,str) or len(query)>2000 or type(limit) is not int or not 1<=limit<=50:raise ValueError('invalid memory query')
    with store.connect() as db:
        rows=db.execute('SELECT data FROM episodic_memories WHERE tenant=? AND project=? AND environment=? AND principal=? ORDER BY rowid DESC',
                        (access.tenant,access.project,access.environment,access.principal)).fetchall()
    from .knowledge import tokens
    terms=set(tokens(query));result=[]
    for row in rows:
        episode=json.loads(row[0])
        if not terms or terms.intersection(tokens(episode['summary'])):result.append(episode)
        if len(result)>=limit:break
    return result
