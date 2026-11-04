"""Scoped latest-per-run evaluation headers, stable pages and window aggregates."""
import base64
import time

from .agent_evaluation import policy
from .contracts import canonical, digest, identifier
from .structured import parse_json

CATALOG = """WITH scoped AS MATERIALIZED (
    SELECT rowid AS position,id,run_id FROM agent_evaluations
    WHERE tenant=? AND project=? AND principal=? AND rowid<=?
), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY position DESC) AS rank FROM scoped
), headers AS MATERIALIZED (
    SELECT e.position,e.id,e.run_id,a.created AS created_at,
        json_extract(a.data,'$.run_created_at') AS run_created_at,
        json_extract(a.data,'$.agent_id') AS agent_id,json_extract(a.data,'$.agent_name') AS agent_name,
        json_extract(a.data,'$.agent_revision') AS agent_revision,json_extract(a.data,'$.goal') AS goal,
        json_extract(a.data,'$.rubric') AS rubric,json_extract(a.data,'$.status') AS status,
        COALESCE(json_extract(a.data,'$.effective_threshold'),json_extract(a.data,'$.policy.threshold')) AS effective_threshold,
        json_extract(a.data,'$.verdict') AS original_verdict,json_extract(a.data,'$.score') AS original_score,
        (json_type(a.data,'$.assessment') IS NULL AND json_extract(r.state,'$.task.execution_mode') IN ('direct','conversation')) AS legacy_structural,
        json_extract(r.state,'$.snapshot.agent_profile.runtime') AS runtime,
        json_extract(a.data,'$.assessment.scope') AS original_scope
    FROM ranked e JOIN agent_evaluations a ON a.tenant=? AND a.id=e.id
    LEFT JOIN runs r ON r.tenant_id=a.tenant AND r.id=e.run_id WHERE e.rank=1
), catalog AS MATERIALIZED (
    SELECT *,CASE WHEN legacy_structural AND runtime='mock' AND original_verdict!='EXCLUDED'
        THEN 'SIMULATED' ELSE original_verdict END AS verdict,
        CASE WHEN legacy_structural AND runtime='mock' AND original_verdict!='EXCLUDED'
        THEN NULL ELSE original_score END AS score,
        COALESCE(original_scope,CASE WHEN legacy_structural THEN 'STRUCTURAL' ELSE 'BUSINESS_RULES' END) AS assessment_scope
    FROM headers
) """


def summary(row):
    value=dict(row)
    for field in ('position','original_verdict','original_score','legacy_structural','runtime','original_scope'):value.pop(field,None)
    scope=value.pop('assessment_scope')
    value['assessment']={'scope':scope,'label':'离线演示不计分' if value['verdict']=='SIMULATED' else '结构检查分' if scope=='STRUCTURAL' else '业务规则检查分'}
    return value


def page(service, *, search='', agent_id=None, verdict='all', period='window', limit=50, cursor=None):
    if not isinstance(search,str) or len(search)>2000:raise ValueError('评测搜索词须为不超过 2000 字的文本')
    search=search.strip().lower()
    if agent_id is not None:agent_id=identifier(agent_id)
    if not isinstance(verdict,str) or verdict not in ('all','PASS','FAIL','EXCLUDED','SIMULATED'):raise ValueError('评测结论无效')
    if not isinstance(period,str) or period not in ('window','all'):raise ValueError('评测历史范围无效')
    if type(limit) is str and limit.isascii() and limit.isdigit() and len(limit)<=2:limit=int(limit)
    if type(limit) is not int or not 1<=limit<=50:raise ValueError('评测分页大小须为 1–50')
    upper=before=None;asof=int(time.time())
    with service.store.connect() as db:
        db.execute('BEGIN')
        settings=policy(db,*service.scope)
        signature=digest([*service.scope,settings,search,agent_id,verdict,period,limit])
        if cursor is not None:
            try:
                if not isinstance(cursor,str) or not 1<=len(cursor)<=2048:raise ValueError()
                value=parse_json(base64.b64decode(cursor+'='*(-len(cursor)%4),altchars=b'-_',validate=True).decode())
                if not isinstance(value,dict) or set(value)!={'v','upper','before','asof','query'}:raise ValueError()
                upper,before,saved_asof=value['upper'],value['before'],value['asof']
                if (type(value['v']) is not int or value['v']!=1 or value['query']!=signature or
                        type(upper) is not int or not 0<=upper<=9223372036854775807 or
                        type(saved_asof) is not int or not 0<=saved_asof<=asof+1 or
                        (before is not None and (type(before) is not int or not 0<before<=upper))):raise ValueError()
                asof=saved_asof
            except (ValueError,TypeError,UnicodeError,OverflowError):
                raise ValueError('评测分页已失效或条件已变化，请返回第一页') from None
        if upper is None:upper=db.execute('SELECT COALESCE(MAX(rowid),0) FROM agent_evaluations WHERE tenant=? AND project=? AND principal=?',service.scope).fetchone()[0]
        params=(*service.scope,upper,service.scope[0]);cutoff=asof-settings['window_days']*86400
        conditions=['run_created_at>=?'] if period=='window' else ['1=1'];filters=[cutoff] if period=='window' else []
        period_where=' AND '.join(conditions);period_params=tuple(filters)
        if agent_id:conditions.append('agent_id=?');filters.append(agent_id)
        if verdict!='all':conditions.append('verdict=?');filters.append(verdict)
        if search:
            conditions.append("(instr(lower(COALESCE(goal,'')),?)>0 OR instr(lower(COALESCE(agent_name,'')),?)>0 OR instr(lower(run_id),?)>0 OR instr(lower(id),?)>0)")
            filters.extend([search]*4)
        where=' AND '.join(conditions)
        counts=db.execute(CATALOG+'SELECT COALESCE(SUM('+period_where+'),0) AS total,COALESCE(SUM('+where+'),0) AS filtered_total,COALESCE(SUM(run_created_at>=?),0) AS window_total FROM catalog',(*params,*period_params,*filters,cutoff)).fetchone()
        newer=db.execute('SELECT COUNT(*) FROM agent_evaluations WHERE tenant=? AND project=? AND principal=? AND rowid>?',(*service.scope,upper)).fetchone()[0]
        groups=db.execute(CATALOG+'''SELECT agent_id,MAX(agent_name) AS name,COUNT(score) AS sample_count,AVG(score) AS score,
            SUM(score IS NOT NULL AND verdict='FAIL') AS failed,SUM(verdict='EXCLUDED') AS excluded,SUM(verdict='SIMULATED') AS simulated,
            SUM(score IS NOT NULL AND assessment_scope='STRUCTURAL') AS structural_samples
            FROM catalog WHERE run_created_at>=? GROUP BY agent_id ORDER BY name,agent_id''',(*params,cutoff)).fetchall()
        agents=db.execute(CATALOG+'''SELECT agent_id AS id,agent_name AS name FROM catalog c
            WHERE position=(SELECT MAX(position) FROM catalog same WHERE same.agent_id=c.agent_id) ORDER BY name,id''',params).fetchall()
        offset=db.execute(CATALOG+'SELECT COUNT(*) FROM catalog WHERE '+where+' AND position>=?',(*params,*filters,before)).fetchone()[0] if before is not None else 0
        position_filter=' AND position<?' if before is not None else '';bound=(before,) if before is not None else ()
        rows=db.execute(CATALOG+'/* evaluation_page_rows */ SELECT * FROM catalog WHERE '+where+position_filter+' ORDER BY position DESC LIMIT ?',(*params,*filters,*bound,limit+1)).fetchall()
        open_alerts=db.execute('SELECT COUNT(*) FROM agent_alerts WHERE tenant=? AND project=? AND principal=? AND acknowledged IS NULL',service.scope).fetchone()[0]
    def token(anchor):
        return base64.urlsafe_b64encode(canonical({'v':1,'upper':upper,'before':anchor,'asof':asof,'query':signature}).encode()).decode().rstrip('=')
    has_more=len(rows)>limit;rows=rows[:limit]
    return {'policy':settings,'agents':[{**dict(g),'score':round(g['score'],2) if g['score'] is not None else None} for g in groups],'report_agents':[dict(a) for a in agents],
            'reports':[summary(row) for row in rows],**dict(counts),'newer_count':newer,'open_alert_count':open_alerts,
            'offset':offset,'limit':limit,'search':search,'agent_id':agent_id,'verdict':verdict,'period':period,'asof':asof,
            'cursor':token(before),'next_cursor':token(rows[-1]['position']) if has_more else None,'has_more':has_more}
