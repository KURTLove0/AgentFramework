"""Public conversation projections; full execution and audit records stay intact."""
import json

from .contracts import PolicyDenied
from .store import cancellation_projection


FIELDS = ('version', 'status', 'report', 'updated_at', 'model_calls', 'model_tokens',
          'deadline', 'last_error', 'interruption')
BATCH_SIZE = 400


def turn_states(db, tenant, principal, project, identities, *, cancellations=True):
    states = {}
    for offset in range(0, len(identities), BATCH_SIZE):
        batch = identities[offset:offset+BATCH_SIZE]
        fields = ','.join("'$." + field + "'" for field in FIELDS)
        stop = cancellation_projection() if cancellations else 'NULL'
        join = ('LEFT JOIN run_cancellations stop_request ON stop_request.tenant_id=r.tenant_id AND stop_request.run_id=r.id'
                if cancellations else '')
        rows = db.execute('''SELECT r.id,r.owner,r.lease_until,
            json_extract(r.state,''' + fields + ''') AS fields,
            json_extract(r.state,'$.task.principal') AS principal,
            json_extract(r.state,'$.task.project_id') AS project,
            ''' + stop + ''' AS cancellation,
            COALESCE((SELECT MAX(e.seq) FROM events e WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id),0) AS event_seq
            FROM runs r ''' + join + ''' WHERE r.tenant_id=? AND r.id IN (''' + ','.join('?' for _ in batch) + ')',
            (tenant, *batch))
        for row in rows:
            if row['principal'] != principal or row['project'] != project:
                raise PolicyDenied('conversation turn outside scope')
            values = json.loads(row['fields'])
            states[row['id']] = {**{k:v for k,v in zip(FIELDS, values) if v is not None},
                'run_id':row['id'], 'cancellation':json.loads(row['cancellation']) if row['cancellation'] else None,
                '_event_seq':row['event_seq'], '_lease_owner':row['owner'], '_lease_until':row['lease_until']}
    return states


def progress_events(db, tenant, states):
    result = {identity: {'progress': [], 'preview': None} for identity in states}
    identities = list(states)
    for offset in range(0, len(identities), BATCH_SIZE):
        batch = identities[offset:offset+BATCH_SIZE]
        slots = ','.join('?' for _ in batch)
        # A streaming summary keeps its original position while its text, ID
        # and timestamp come from the latest event for that attempt/stream.
        # Distinguish absent keys from explicit JSON null, as dict.get does.
        rows = db.execute('''WITH summaries AS (
            SELECT run_id,MIN(seq) AS position,MAX(seq) AS latest FROM events
            WHERE tenant_id=? AND run_id IN (''' + slots + ''')
              AND kind='model.progress' AND json_extract(data,'$.kind')='summary_text'
            GROUP BY run_id,
              CASE WHEN json_type(data,'$.attempt') IS NULL THEN 1 ELSE json_extract(data,'$.attempt') END,
              CASE WHEN json_type(data,'$.stream_id') IS NULL THEN 'summary' ELSE json_extract(data,'$.stream_id') END
        )
        SELECT e.run_id,s.position,e.seq,e.time,e.kind,e.data FROM summaries s JOIN events e
          ON e.tenant_id=? AND e.run_id=s.run_id AND e.seq=s.latest
        UNION ALL
        SELECT run_id,seq,seq,time,kind,data FROM events
          WHERE tenant_id=? AND run_id IN (''' + slots + ''') AND kind='model.progress'
            AND json_extract(data,'$.kind') IN ('status','summary','message','tool')
        UNION ALL
        SELECT run_id,seq,seq,time,kind,
            CASE WHEN kind='execution.summary' THEN json_object('text',json_extract(data,'$.text')) ELSE '{}' END FROM events
          WHERE tenant_id=? AND run_id IN (''' + slots + ''')
            AND kind IN ('execution.summary','native.read_prepared','native.read_verified')
        ORDER BY run_id,position''', (tenant, *batch, tenant, tenant, *batch, tenant, *batch))
        for row in rows:
            data = json.loads(row['data'])
            item = {'id':row['seq'], 'time':row['time']}
            if row['kind'] == 'model.progress':
                kind = data['kind']
                item.update(kind='summary' if kind == 'summary_text' else kind, text=data['text'])
                if kind == 'summary_text':item['streaming'] = True
            elif row['kind'] == 'execution.summary':
                item.update(kind='summary', text=data['text'])
            else:
                item.update(kind='tool', text='正在读取资料。' if row['kind'] == 'native.read_prepared' else '资料读取完成。')
            result[row['run_id']]['progress'].append(item)

        previews = [identity for identity in batch if not states[identity].get('report')]
        if not previews:continue
        slots = ','.join('?' for _ in previews)
        rows = db.execute('''WITH answers AS (
            SELECT run_id,MAX(seq) AS latest FROM events
              WHERE tenant_id=? AND run_id IN (''' + slots + ''')
                AND kind='model.progress' AND json_extract(data,'$.kind')='answer_text' GROUP BY run_id
        ), resets AS (
            SELECT run_id,MAX(seq) AS latest FROM events
              WHERE tenant_id=? AND run_id IN (''' + slots + ''')
                AND kind IN ('model.requested','model.output_rejected') AND json_extract(data,'$.phase')='execute' GROUP BY run_id
        )
        SELECT e.run_id,e.seq,e.data FROM answers a LEFT JOIN resets r ON r.run_id=a.run_id
          JOIN events e ON e.tenant_id=? AND e.run_id=a.run_id AND e.seq=a.latest
          WHERE a.latest>COALESCE(r.latest,0)''', (tenant, *previews, tenant, *previews, tenant))
        for row in rows:
            data = json.loads(row['data'])
            result[row['run_id']]['preview'] = {'content':data['text'], 'attempt':data.get('attempt',1), 'seq':row['seq']}
    return result
