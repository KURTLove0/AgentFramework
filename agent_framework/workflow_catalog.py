"""Private workflow headers and anchored history, without hydrating execution bodies."""
import base64
import re
import time

from .contracts import canonical, digest
from .structured import parse_json

TERMINAL = {'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED', 'EXPIRED'}
ATTENTION = {'WAITING_AUTH', 'WAITING_INPUT', 'INTERRUPTED', 'PAUSED', 'NEEDS_REVIEW', 'FAILED', 'EXPIRED', 'QUEUE_ERROR'}
STATUSES = TERMINAL | ATTENTION | {'CREATED', 'RUNNING', 'QUEUED', 'CANCELLING'}

# Materialize the private scope before extracting any JSON, including legacy rows.
HEADERS = """WITH scoped AS MATERIALIZED (
    SELECT r.rowid AS position,r.* FROM workflow_runs r
    WHERE r.tenant=? AND r.workspace=? AND r.principal=?
), headers AS MATERIALIZED (
    SELECT r.position,r.id,json_extract(r.data,'$.name') AS name,
        json_extract(r.data,'$.workflow_id') AS workflow_id,
        json_extract(r.data,'$.snapshot.revision') AS workflow_revision,
        json_extract(r.data,'$.created_at') AS created_at,
        json_extract(r.data,'$.deadline') AS deadline,
        json_extract(r.data,'$.status') AS status,
        json_extract(r.data,'$.last_error') AS last_error,
        json_extract(r.data,'$.change_id') AS change_id,
        json_array_length(r.data,'$.snapshot.definition.nodes') AS node_count,
        r.cancel_requested,(r.owner IS NOT NULL AND r.owner!='' AND r.lease_until>?) AS lease_active,
        d.generation AS dispatch_generation,d.reason AS queue_reason,d.requested AS queue_requested,d.error AS queue_error
    FROM scoped r LEFT JOIN workflow_dispatches d ON d.tenant=r.tenant AND d.run_id=r.id
), catalog AS (
    SELECT *,CASE WHEN status IN ('SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED') THEN status
        WHEN queue_error IS NOT NULL THEN 'QUEUE_ERROR' WHEN cancel_requested THEN 'CANCELLING'
        WHEN dispatch_generation IS NOT NULL THEN CASE WHEN lease_active THEN 'RUNNING' ELSE 'QUEUED' END
        ELSE status END AS display_status FROM headers
) """
ATTENTION_SQL = "display_status IN ('WAITING_AUTH','WAITING_INPUT','INTERRUPTED','PAUSED','NEEDS_REVIEW','FAILED','EXPIRED','QUEUE_ERROR')"


def header(row):
    result = dict(row)
    result.pop('position', None)
    generation = result.pop('dispatch_generation')
    reason, requested, error = (result.pop(key) for key in ('queue_reason', 'queue_requested', 'queue_error'))
    result['lease_active'] = bool(result['lease_active'])
    result['cancel_requested'] = bool(result['cancel_requested'])
    result['queue'] = None if generation is None or result['status'] in TERMINAL else {
        'state': 'ERROR' if error is not None else 'RUNNING' if result['lease_active'] else 'QUEUED',
        'reason': reason, 'requested_at': requested, 'error': error}
    return result


def page(flows, *, search='', status='all', limit=50, cursor=None):
    if not isinstance(search, str) or len(search)>2000:raise ValueError('流程搜索词须为不超过 2000 字的文本')
    search = search.strip().lower()
    if not isinstance(status, str) or status not in STATUSES | {'all', 'attention'}:raise ValueError('流程状态无效')
    if type(limit) is str and re.fullmatch(r'[0-9]+', limit):limit = int(limit)
    if type(limit) is not int or not 1<=limit<=50:raise ValueError('流程分页大小须为 1–50')
    signature = digest([*flows.scope, flows.app.principal, search, status, limit])
    upper = before = None
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or not 1<=len(cursor)<=2048:raise ValueError()
            value = parse_json(base64.b64decode(cursor+'='*(-len(cursor)%4), altchars=b'-_', validate=True).decode())
            if not isinstance(value, dict) or set(value)!={'v','upper','before','query'}:raise ValueError()
            upper, before = value['upper'], value['before']
            if (type(value['v']) is not int or value['v']!=1 or value['query']!=signature or
                    type(upper) is not int or not 0<=upper<=9223372036854775807 or
                    (before is not None and (type(before) is not int or not 0<before<=upper))):raise ValueError()
        except (ValueError, TypeError, UnicodeError, OverflowError):
            raise ValueError('流程分页已失效或筛选条件已变化，请返回第一页') from None
    def token(anchor):
        return base64.urlsafe_b64encode(canonical({'v':1,'upper':upper,'before':anchor,'query':signature}).encode()).decode().rstrip('=')
    conditions = ['position<=?'];filters = []
    if search:
        conditions.append("(instr(lower(COALESCE(name,'')),?)>0 OR instr(lower(id),?)>0 OR instr(lower(COALESCE(workflow_id,'')),?)>0 OR instr(lower(COALESCE(change_id,'')),?)>0)")
        filters.extend([search]*4)
    if status=='attention':conditions.append(ATTENTION_SQL)
    elif status!='all':conditions.append('display_status=?');filters.append(status)
    with flows.store.connect() as db:
        db.execute('BEGIN')
        scope = (*flows.scope, flows.app.principal)
        if upper is None:upper = db.execute('SELECT COALESCE(MAX(rowid),0) FROM workflow_runs WHERE tenant=? AND workspace=? AND principal=?', scope).fetchone()[0]
        params = (*scope,time.time())
        where = ' AND '.join(conditions)
        counts = db.execute(HEADERS+'''SELECT COUNT(*) AS total,
            COALESCE(SUM(position>?),0) AS newer_count,
            COALESCE(SUM(position<=? AND '''+ATTENTION_SQL+'''),0) AS attention_count,
            COALESCE(SUM('''+where+'''),0) AS filtered_total FROM catalog''',(*params,upper,upper,upper,*filters)).fetchone()
        position_filter = ' AND position<?' if before is not None else ''
        bound = (before,) if before is not None else ()
        offset = db.execute(HEADERS+'SELECT COUNT(*) FROM catalog WHERE '+where+' AND position>=?',(*params,upper,*filters,before)).fetchone()[0] if before is not None else 0
        rows = db.execute(HEADERS+'/* catalog_page_rows */ SELECT *, (SELECT COALESCE(MAX(seq),0) FROM workflow_events e WHERE e.tenant=? AND e.run_id=catalog.id) AS revision FROM catalog WHERE '+where+position_filter+' ORDER BY position DESC LIMIT ?',(*params,flows.scope[0],upper,*filters,*bound,limit+1)).fetchall()
    has_more = len(rows)>limit;rows=rows[:limit]
    return {'runs':[header(row) for row in rows],**dict(counts),'offset':offset,'limit':limit,
            'cursor':token(before),'next_cursor':token(rows[-1]['position']) if has_more else None,
            'has_more':has_more,'search':search,'status':status}


def attention(flows):
    with flows.store.connect() as db:
        rows=db.execute(HEADERS+'SELECT * FROM catalog WHERE '+ATTENTION_SQL,(*flows.scope,flows.app.principal,time.time())).fetchall()
    return [header(row) for row in rows]
