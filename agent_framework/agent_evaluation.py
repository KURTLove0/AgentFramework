"""Evidence-based job evaluations. Frozen jobs, never the current edited profile."""
import json
import time

from .contracts import TERMINAL, canonical, digest, identifier
from .runtime_config import ConfigConflict

RUBRIC = 'job-history@2.0.0'
DEFAULT_POLICY = {'revision': 0, 'threshold': 80, 'window_days': 30, 'automatic': True}


def schema(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS evaluation_policies (
            tenant TEXT, project TEXT, principal TEXT, data TEXT,
            PRIMARY KEY(tenant,project,principal));
        CREATE TABLE IF NOT EXISTS agent_evaluations (
            tenant TEXT, project TEXT, principal TEXT, id TEXT, run_id TEXT,
            fingerprint TEXT, data TEXT, created REAL,
            PRIMARY KEY(tenant,id), UNIQUE(tenant,run_id,fingerprint));
        CREATE TABLE IF NOT EXISTS agent_alerts (
            tenant TEXT, project TEXT, principal TEXT, id TEXT, evaluation_id TEXT,
            data TEXT, acknowledged REAL, created REAL,
            PRIMARY KEY(tenant,id), UNIQUE(tenant,evaluation_id));
    ''')


def policy(db, tenant, project, principal):
    row = db.execute('SELECT data FROM evaluation_policies WHERE tenant=? AND project=? AND principal=?',
                     (tenant, project, principal)).fetchone()
    return json.loads(row[0]) if row else dict(DEFAULT_POLICY)


def record(db, state, force=False):
    """Called within the terminal checkpoint transaction; evaluation and alert are atomic."""
    if state['status'] not in TERMINAL:
        return None
    tenant, task = state['tenant_id'], state['task']
    scope = (tenant, task['project_id'], task['principal'])
    settings = policy(db, *scope)
    if not settings['automatic'] and not force:
        return None
    snapshot = state['snapshot']
    compiled = snapshot.get('compiled_agent', {})
    definition = compiled.get('definition', {})
    profile = snapshot.get('agent_profile', {})
    from .evaluation_contract import compile_contract, VERSION
    contract = compiled.get('evaluation_contract')
    if not contract and definition:
        contract = compile_contract(definition, standards=compiled.get('standards'))
    contract = contract or {'version': VERSION, 'identity': snapshot.get('agent', {}).get('identity', {}),
                            'weights': {'identity': 10, 'responsibilities': 35, 'standards': 35, 'delivery': 20},
                            'responsibilities': [], 'standards': [], 'threshold': None, 'capability_refs': []}
    contract_valid = bool(contract.get('hash') and digest({k:v for k,v in contract.items() if k != 'hash'}) == contract['hash'])
    evidence_rows = [json.loads(r[0]) for r in db.execute('SELECT data FROM evidence WHERE tenant_id=? AND run_id=? ORDER BY id',
                                                        (tenant, state['run_id']))]
    evidence = [row['id'] for row in evidence_rows]
    evidence_valid = bool(evidence_rows) and all(row['content_hash'] == digest(row['data']) and
                            row['tenant_id'] == tenant and row['run_id'] == state['run_id'] for row in evidence_rows)
    actions = [json.loads(r[0]) for r in db.execute('SELECT data FROM actions WHERE tenant_id=? AND run_id=?', (tenant,state['run_id']))]
    action_boundary = all(a['tool_ref'] in contract['capability_refs'] for a in actions)
    snapshot_valid = digest({k:v for k,v in snapshot.items() if k != 'hash'}) == snapshot.get('hash')
    compiled_valid = bool(compiled and digest({k:v for k,v in compiled.items() if k != 'hash'}) == compiled.get('hash'))
    required = sorted(set(task['acceptance']))
    checks = state.get('checks', {})

    def mapped(refs):
        return [{'ref': ref, 'passed': checks.get(ref, {}).get('passed') is True and evidence_valid,
                 'reason': ('运行证据缺失或哈希/作用域校验失败' if not evidence_valid else
                            checks.get(ref, {}).get('reason') or checks.get(ref, {}).get('detail') or
                            ('独立验收通过' if checks.get(ref, {}).get('passed') is True else '未通过或缺少独立验收结果')),
                 'evidence_refs': evidence}
                for ref in sorted(set(refs))]

    def criterion(item, deliverable=False):
        results = mapped(item['check_refs'])
        artifact = None
        if deliverable:
            ref = item['deliverable_ref']
            artifact = state.get('draft') if ref == 'release-draft@1.0.0' else state.get('report')
        ratio = sum(c['passed'] for c in results) / len(results) if results else 0
        value = round(100 * ratio, 2) if (not deliverable or artifact) else 0
        return {**item, 'checks': results, 'score': value, 'passed': value >= item['minimum_score'],
                'artifact_present': bool(artifact) if deliverable else None,
                'artifact_hash': digest(artifact) if artifact else None}

    duties = [criterion(item, True) for item in contract['responsibilities']]
    standards = [criterion(item) for item in contract['standards']]
    # Keep the public verifier_refs spelling for older readers, while retaining the frozen contract.
    for standard in standards:
        standard['verifier_refs'] = standard['check_refs']
    baseline = mapped(required)
    identity = contract['identity']
    identity_checks = [
        {'name': '岗位身份与版本', 'passed': bool(compiled and task['agent_ref'] == compiled.get('ref') and
             identity == definition.get('identity') and all(identity.get(k) for k in ('name','role')))},
        {'name': '岗位与任务领域一致', 'passed': contract.get('domain_pack_ref') == task.get('domain_pack_ref')},
        {'name': '冻结快照和评测契约完整', 'passed': snapshot_valid and compiled_valid and contract_valid},
        {'name': '执行能力未超出岗位边界', 'passed': action_boundary}]
    identity_ratio = sum(c['passed'] for c in identity_checks) / len(identity_checks)
    def ratio(items):
        return sum(i['weight'] * i['score'] for i in items) / sum(i['weight'] for i in items) / 100 if items else 0
    weights = contract['weights']
    dimensions = [
        {'name': '身份一致性', 'score': round(weights['identity'] * identity_ratio, 2), 'maximum': weights['identity']},
        {'name': '职责履行', 'score': round(weights['responsibilities'] * ratio(duties), 2), 'maximum': weights['responsibilities']},
        {'name': '标准达成', 'score': round(weights['standards'] * ratio(standards), 2), 'maximum': weights['standards']},
        {'name': '任务交付', 'score': weights['delivery'] if state['status'] == 'SUCCEEDED' else 0, 'maximum': weights['delivery']}]
    score = round(sum(d['score'] for d in dimensions), 2)
    effective_threshold = max(settings['threshold'], contract.get('threshold') or settings['threshold'])
    reasons = [c['ref'] + '：' + str(c['reason']) for c in baseline if not c['passed']]
    reasons.extend(c['name'] + '未通过' for c in identity_checks if not c['passed'])
    reasons.extend('职责「' + d['description'] + f"」达成 {d['score']:g} 分，要求 {d['minimum_score']} 分" for d in duties if not d['passed'])
    reasons.extend('标准 ' + s['ref'] + f" 达成 {s['score']:g} 分，要求 {s['minimum_score']} 分" for s in standards if not s['passed'])
    if not duties or not standards:
        reasons.append('缺少冻结职责或标准映射，需人工复核历史任务')
    if state['status'] != 'SUCCEEDED':
        reasons.append('任务终态为 ' + state['status'] + '，未完成交付')
    if score < effective_threshold:
        reasons.append(f'总分 {score:g} 低于有效基础阈值 {effective_threshold}')
    excluded = state['status'] == 'CANCELLED'
    report = {'rubric': RUBRIC, 'run_id': state['run_id'], 'agent_id': profile.get('id', task['agent_ref'].split('@')[0]),
              'agent_name': identity.get('name', profile.get('name', task['agent_ref'])),
              'agent_revision': profile.get('revision'), 'agent_ref': task['agent_ref'],
              'snapshot_hash': snapshot.get('hash'), 'identity': identity, 'identity_checks': identity_checks,
              'evaluation_contract': contract, 'contract_origin': 'FROZEN' if compiled.get('evaluation_contract') else 'DERIVED_FROM_FROZEN_JOB',
              'effective_threshold': effective_threshold, 'evidence_integrity': evidence_valid,
              'responsibilities': duties, 'standards': standards, 'baseline': baseline,
              'dimensions': dimensions, 'score': None if excluded else score,
              'verdict': 'EXCLUDED' if excluded else 'FAIL' if reasons else 'PASS',
              'reasons': ['人工取消的任务不计入评分'] if excluded else reasons,
              'evidence_refs': evidence, 'policy': settings, 'status': state['status'],
              'goal': task['goal'], 'run_created_at': state['created_at']}
    fingerprint = digest(report)
    identity_key = 'evaluation-' + digest([tenant, state['run_id'], fingerprint])[:24]
    report.update(id=identity_key, created_at=time.time())
    cursor = db.execute('INSERT OR IGNORE INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?)',
                        (*scope, identity_key, state['run_id'], fingerprint, canonical(report), report['created_at']))
    if cursor.rowcount and report['verdict'] == 'FAIL':
        alert = {'id': 'alert-' + digest(identity_key)[:24], 'evaluation_id': identity_key,
                 'run_id': state['run_id'], 'agent_id': report['agent_id'], 'agent_name': report['agent_name'],
                 'score': score, 'threshold': effective_threshold, 'reasons': reasons,
                 'message': report['agent_name'] + ' 的执行未达到基础标准，请查看证据并安排改进。'}
        db.execute('INSERT INTO agent_alerts VALUES(?,?,?,?,?,?,NULL,?)',
                   (*scope, alert['id'], identity_key, canonical(alert), report['created_at']))
    row = db.execute('SELECT data FROM agent_evaluations WHERE tenant=? AND id=?', (tenant, identity_key)).fetchone()
    return json.loads(row[0])


class AgentEvaluations:
    def __init__(self, app):
        self.app, self.store = app, app.runtime().store
        self.scope = (app.tenant, app.workspace['project_id'], app.principal)

    def settings(self):
        with self.store.connect() as db:
            return policy(db, *self.scope)

    def save_policy(self, data):
        if not isinstance(data, dict) or set(data) != set(DEFAULT_POLICY):
            raise ValueError('评测配置需要 revision、threshold、window_days、automatic')
        if type(data['revision']) is not int or data['revision'] < 0:
            raise ValueError('评测配置版本无效')
        if type(data['threshold']) is not int or not 1 <= data['threshold'] <= 100:
            raise ValueError('基础阈值须为 1–100')
        if type(data['window_days']) is not int or not 1 <= data['window_days'] <= 365:
            raise ValueError('历史窗口须为 1–365 天')
        if type(data['automatic']) is not bool:
            raise ValueError('自动评测开关无效')
        with self.store.transaction() as db:
            if policy(db, *self.scope)['revision'] != data['revision']:
                raise ConfigConflict('评测配置已更新，请重新加载')
            saved = {**data, 'revision': data['revision'] + 1}
            db.execute('INSERT OR REPLACE INTO evaluation_policies VALUES(?,?,?,?)', (*self.scope, canonical(saved)))
        return saved

    def evaluate(self, run_id=None):
        settings = self.settings()
        if run_id:
            state = self.store.load(self.app.tenant, identifier(run_id))
            self.app.assert_run_access(state)
            if state['task']['principal'] != self.app.principal:
                raise KeyError('evaluation unavailable')
            if state['status'] not in TERMINAL:
                raise ConfigConflict('执行结束后才能评测，等待授权或材料不计为失败')
            states = [state]
        else:
            with self.store.connect() as db:
                states = [json.loads(r[0]) for r in db.execute('SELECT state FROM runs WHERE tenant_id=?', (self.app.tenant,))]
            states = [s for s in states if s['task']['project_id'] == self.scope[1] and
                      s['task']['principal'] == self.scope[2] and s['status'] in TERMINAL and
                      s['created_at'] >= time.time() - settings['window_days'] * 86400]
        reports = []
        for state in states:
            with self.store.transaction() as db:
                # Read again in the write transaction to evaluate a consistent checkpoint.
                current = json.loads(db.execute('SELECT state FROM runs WHERE tenant_id=? AND id=?',
                                                (self.app.tenant, state['run_id'])).fetchone()[0])
                reports.append(record(db, current, force=True))
        return {'evaluated': len(reports), 'reports': reports}

    def overview(self):
        settings = self.settings()
        with self.store.connect() as db:
            rows = db.execute('SELECT data FROM agent_evaluations WHERE tenant=? AND project=? AND principal=? ORDER BY rowid DESC', self.scope).fetchall()
            alerts = [{**json.loads(r['data']), 'acknowledged_at': r['acknowledged'], 'created_at': r['created']}
                      for r in db.execute('SELECT * FROM agent_alerts WHERE tenant=? AND project=? AND principal=? ORDER BY created DESC', self.scope)]
        latest = {}
        for row in rows:
            report = json.loads(row[0])
            if report['run_created_at'] >= time.time() - settings['window_days'] * 86400:
                latest.setdefault(report['run_id'], report)
        groups = {}
        for report in latest.values():
            group = groups.setdefault(report['agent_id'], {'agent_id': report['agent_id'], 'name': report['agent_name'], 'scores': [], 'failed': 0, 'excluded': 0})
            if report['score'] is None:
                group['excluded'] += 1
            else:
                group['scores'].append(report['score'])
                group['failed'] += report['verdict'] == 'FAIL'
        for group in groups.values():
            scores = group.pop('scores')
            group.update(sample_count=len(scores), score=round(sum(scores) / len(scores), 2) if scores else None)
        return {'policy': settings, 'agents': list(groups.values()), 'reports': list(latest.values())[:200],
                'alerts': alerts[:200], 'open_alert_count': sum(not a['acknowledged_at'] for a in alerts),
                'report_count': len(latest), 'limit': 200}

    def get(self, identity):
        with self.store.connect() as db:
            row = db.execute('SELECT data FROM agent_evaluations WHERE tenant=? AND project=? AND principal=? AND id=?',
                             (*self.scope, identifier(identity))).fetchone()
        if not row:
            raise KeyError('evaluation unavailable')
        return json.loads(row[0])

    def acknowledge(self, identity):
        with self.store.transaction() as db:
            row = db.execute('SELECT * FROM agent_alerts WHERE tenant=? AND project=? AND principal=? AND id=?',
                             (*self.scope, identifier(identity))).fetchone()
            if not row:
                raise KeyError('alert unavailable')
            db.execute('UPDATE agent_alerts SET acknowledged=COALESCE(acknowledged,?) WHERE tenant=? AND id=?',
                       (time.time(), self.app.tenant, identity))
        return {'id': identity, 'acknowledged': True}
