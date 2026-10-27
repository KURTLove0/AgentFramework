"""Durable daily workspace plans and bounded dispatch through Application.create."""
from datetime import datetime, timedelta
import json
import logging
import re
import time
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .contracts import TERMINAL, canonical, digest, identifier
from .runtime_config import ConfigConflict

DEFAULT = {'revision': 0, 'enabled': False, 'timezone': 'Asia/Shanghai',
           'daily_time': '09:00', 'auto_start': False, 'tasks': []}
TASK_FIELDS = {'agent_id', 'agent_revision', 'goal', 'change_id', 'grant', 'consent', 'mcp_consent'}


def schema(store):
    with store.connect() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS workspace_schedules (
                tenant TEXT, workspace TEXT, principal TEXT, data TEXT, updated REAL,
                PRIMARY KEY(tenant,workspace,principal));
            CREATE TABLE IF NOT EXISTS workspace_daily_plans (
                tenant TEXT, workspace TEXT, principal TEXT, day TEXT, id TEXT, data TEXT,
                owner TEXT, lease_until REAL DEFAULT 0, created REAL,
                PRIMARY KEY(tenant,workspace,principal,day), UNIQUE(tenant,id));
        ''')


class WorkspaceScheduler:
    def __init__(self, app):
        self.app, self.store = app, app.runtime().store
        self.scope = (app.tenant, app.workspace['id'], app.principal)

    def settings(self):
        with self.store.connect() as db:
            row = db.execute('SELECT data FROM workspace_schedules WHERE tenant=? AND workspace=? AND principal=?', self.scope).fetchone()
        return json.loads(row[0]) if row else dict(DEFAULT, tasks=[])

    def validate_task(self, task):
        from .agents import text
        if not isinstance(task, dict) or not TASK_FIELDS<=set(task) or set(task)-TASK_FIELDS-{'execution_mode'}:
            raise ValueError('每日任务字段不完整或含未知字段')
        if 'execution_mode' in task and task['execution_mode']!='conversation':raise ValueError('每日任务执行方式无效')
        if task.get('execution_mode')=='conversation' and task['grant']:raise ValueError('普通每日任务不预授予业务写入权限')
        for key in ('grant', 'consent', 'mcp_consent'):
            if type(task[key]) is not bool:
                raise ValueError(key + ' 必须为布尔值')
        identifier(task['change_id'])
        text(task['goal'], '每日任务目标', 2000)
        profile = self.app.agents.get(identifier(task['agent_id']))
        if profile['archived']:
            raise ConfigConflict('每日任务的 Agent 已归档')
        if type(task['agent_revision']) is not int or task['agent_revision'] != profile['revision']:
            raise ConfigConflict('每日任务的 Agent 版本已变化，请重新选择并保存')
        self.app.agents.compile(profile['id'])
        if profile['runtime'] != 'mock' and not task['consent']:
            raise ValueError('真实模型每日任务需要明确允许发送上下文')
        if ((profile.get('definition') or {}).get('native_read_refs') or any(s['enabled'] for s in profile['mcp_servers'])) and not task['mcp_consent']:
            raise ValueError('每日任务需要明确允许 Agent 的受控 MCP 读取')
        return profile

    def save(self, data):
        if not isinstance(data, dict) or set(data) != set(DEFAULT):
            raise ValueError('每日计划配置字段不完整或含未知字段')
        if type(data['revision']) is not int or data['revision'] < 0:
            raise ValueError('每日计划配置版本无效')
        for key in ('enabled', 'auto_start'):
            if type(data[key]) is not bool:
                raise ValueError(key + ' 必须为布尔值')
        if not isinstance(data['timezone'], str) or len(data['timezone']) > 80:
            raise ValueError('请选择有效时区')
        try:
            ZoneInfo(data['timezone'])
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError('请选择有效的 IANA 时区') from None
        if not isinstance(data['daily_time'], str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', data['daily_time']):
            raise ValueError('每日执行时间须为 HH:MM')
        if not isinstance(data['tasks'], list) or len(data['tasks']) > 16:
            raise ValueError('每日最多派发 16 项任务')
        seen = set()
        for task in data['tasks']:
            self.validate_task(task)
            key = digest([task['agent_id'], task['goal'].strip(), task['change_id']])
            if key in seen:
                raise ValueError('每日计划包含重复任务')
            seen.add(key)
        with self.store.transaction() as db:
            row = db.execute('SELECT data FROM workspace_schedules WHERE tenant=? AND workspace=? AND principal=?', self.scope).fetchone()
            revision = json.loads(row[0])['revision'] if row else 0
            if revision != data['revision']:
                raise ConfigConflict('每日计划已更新，请重新加载')
            saved = {**data, 'revision': revision + 1,
                     'tasks': [{**t, 'goal': t['goal'].strip()} for t in data['tasks']]}
            db.execute('INSERT OR REPLACE INTO workspace_schedules VALUES(?,?,?,?,?)', (*self.scope, canonical(saved), time.time()))
        return saved

    def plans(self):
        with self.store.connect() as db:
            rows = db.execute('SELECT data FROM workspace_daily_plans WHERE tenant=? AND workspace=? AND principal=? ORDER BY day DESC LIMIT 60', self.scope).fetchall()
        plans = [json.loads(r[0]) for r in rows]
        for plan in plans:
            for item in plan['items']:
                if item.get('run_id'):
                    state = self.store.load(self.app.tenant, item['run_id'])
                    self.app.assert_run_access(state)
                    item['run_status'] = state['status']
        return plans

    def get(self, identity):
        with self.store.connect() as db:
            row = db.execute('SELECT data FROM workspace_daily_plans WHERE tenant=? AND workspace=? AND principal=? AND id=?',
                             (*self.scope, identifier(identity))).fetchone()
        if not row:
            raise KeyError('daily plan unavailable')
        return json.loads(row[0])

    def overview(self, now=None):
        now = time.time() if now is None else now
        config, plans = self.settings(), self.plans()
        local = datetime.fromtimestamp(now, ZoneInfo(config['timezone']))
        due = local.replace(hour=int(config['daily_time'][:2]), minute=int(config['daily_time'][3:]), second=0, microsecond=0)
        has_today = any(p['day'] == local.date().isoformat() for p in plans)
        catch_up = config['enabled'] and due.timestamp() <= now and not has_today
        if due.timestamp() <= now or has_today:
            due += timedelta(days=1)
        return {'settings': config, 'plans': plans, 'today': local.date().isoformat(),
                'next_run_at': due.timestamp() if config['enabled'] else None,
                'catch_up_pending': catch_up, 'service_required': True}

    def generate(self, now=None):
        now = time.time() if now is None else now
        config = self.settings()
        local = datetime.fromtimestamp(now, ZoneInfo(config['timezone']))
        day = local.date().isoformat()
        with self.store.connect() as db:
            prior = db.execute('SELECT data FROM workspace_daily_plans WHERE tenant=? AND workspace=? AND principal=? AND day=?', (*self.scope, day)).fetchone()
        states=self.app.accessible_run_states()
        if prior:
            old_plan = json.loads(prior[0])
            if old_plan['schedule_revision'] == config['revision'] or any(i.get('run_id') for i in old_plan['items']):
                return old_plan
        states = [s for s in states if s['task']['project_id'] == self.app.workspace['project_id'] and s['task']['principal'] == self.app.principal]
        pending = [s for s in states if s['status'] not in TERMINAL]
        items = []
        for index, task in enumerate(config['tasks']):
            item = {'id': 'daily-task-' + str(index + 1), 'task': task, 'status': 'READY',
                    'run_id': None, 'reason': None, 'agent_name': task['agent_id']}
            try:
                profile = self.validate_task(task)
                item['agent_name'] = profile['name']
                item['responsibilities'] = profile['definition']['responsibilities']
                matching = next((s for s in pending if s['snapshot'].get('agent_profile', {}).get('id') == task['agent_id'] and
                                 s['task']['goal'] == task['goal'] and (task.get('execution_mode')=='conversation' or s['task']['change_id'] == task['change_id'])), None)
                if matching:
                    item.update(status='SKIPPED', reason='同目标任务尚未结束，先处理原任务', existing_run_id=matching['run_id'])
            except (ValueError, KeyError, ConfigConflict) as exc:
                item.update(status='BLOCKED', reason=str(exc))
            items.append(item)
        ready = sum(i['status'] == 'READY' for i in items)
        waiting = [{'run_id': s['run_id'], 'goal': s['task']['goal'], 'status': s['status']} for s in pending]
        plan = {'id': 'daily-' + digest([*self.scope, day])[:24], 'day': day, 'timezone': config['timezone'],
                'schedule_revision': config['revision'], 'auto_start': config['auto_start'], 'status': 'PLANNED',
                'created_at': now, 'items': items, 'pending_runs': waiting,
                'summary': f'工作空间有 {len(pending)} 项未完成任务；今日可派发 {ready} 项，阻塞 {sum(i["status"] == "BLOCKED" for i in items)} 项，避免重复 {sum(i["status"] == "SKIPPED" for i in items)} 项。',
                'history_counts': {'total': len(states), 'pending': len(pending), 'succeeded': sum(s['status'] == 'SUCCEEDED' for s in states)},
                'error': None}
        with self.store.transaction() as db:
            # Rebuild an unsubmitted preview after editing settings; submitted plans stay frozen.
            if prior:
                db.execute('DELETE FROM workspace_daily_plans WHERE tenant=? AND workspace=? AND principal=? AND day=? AND owner IS NULL AND data=?',
                           (*self.scope, day, prior[0]))
            db.execute('INSERT OR IGNORE INTO workspace_daily_plans VALUES(?,?,?,?,?,?,NULL,0,?)',
                       (*self.scope, day, plan['id'], canonical(plan), now))
        return self.get(plan['id'])

    def dispatch(self, identity):
        config = self.settings()
        plan = self.get(identity)
        if config['revision'] != plan['schedule_revision']:
            raise ConfigConflict('配置已变化，此计划已冻结；请在下一日使用新配置，或先处理今日已派发任务')
        # A short durable claim serializes dispatch across tabs, scheduler ticks and processes.
        owner = uuid4().hex
        with self.store.transaction() as db:
            changed = db.execute('UPDATE workspace_daily_plans SET owner=?,lease_until=? WHERE tenant=? AND workspace=? AND principal=? AND id=? AND (owner IS NULL OR lease_until<?)',
                                 (owner, time.time() + 120, *self.scope, identity, time.time())).rowcount
            if not changed:
                raise ConfigConflict('每日计划正在派发，请稍后刷新')
            plan = json.loads(db.execute('SELECT data FROM workspace_daily_plans WHERE tenant=? AND id=?', (self.app.tenant, identity)).fetchone()[0])
        try:
            for item in plan['items']:
                if item['status'] in ('SKIPPED', 'BLOCKED'):
                    continue
                run_id = 'run-daily-' + digest([*self.scope, identity, item['id']])[:24]
                # A crash after submission but before linking recovers this exact run.
                try:
                    existing = self.store.load(self.app.tenant, run_id)
                    self.app.assert_run_access(existing)
                    item.update(run_id=run_id, status='DISPATCHED', reason=None)
                except KeyError:
                    if item.get('run_id'):
                        raise
                    try:
                        self.validate_task(item['task'])
                        # Recheck after preview: a manual task may have appeared in the meantime.
                        pending=self.app.accessible_run_states()
                        matching = next((s for s in pending if s['status'] not in TERMINAL and
                                         s['task']['project_id'] == self.app.workspace['project_id'] and
                                         s['task']['principal'] == self.app.principal and
                                         s['snapshot'].get('agent_profile', {}).get('id') == item['task']['agent_id'] and
                                         s['task']['goal'] == item['task']['goal'] and
                                         (item['task'].get('execution_mode')=='conversation' or s['task']['change_id'] == item['task']['change_id'])), None)
                        if matching:
                            item.update(status='SKIPPED', reason='同目标任务尚未结束，先处理原任务', existing_run_id=matching['run_id'])
                            self._save_claim(plan, owner)
                            continue
                        if item['task'].get('execution_mode')=='conversation':
                            self.app.start_task({k:item['task'][k] for k in ('goal','agent_id','agent_revision')}|{'request_id':run_id},run_id=run_id,start=False)
                        else:self.app.create({**item['task'], 'start': False}, run_id=run_id)
                        item.update(run_id=run_id, status='DISPATCHED', reason=None)
                    except (ValueError, KeyError, ConfigConflict) as exc:
                        item.update(status='BLOCKED', reason=str(exc))
                self._save_claim(plan, owner)
                if item.get('run_id') and plan['auto_start']:
                    state = self.store.load(self.app.tenant, run_id)
                    # Never silently resume an authorization/input wait or a failed job.
                    if state['status'] in {'CREATED', 'RUNNING', 'RECONCILING', 'VERIFYING'} and not self.app.lease(run_id)['active'] and not (self.app.job(run_id) or {}).get('active'):
                        self.app.schedule(run_id)
            plan['status'] = 'PARTIAL' if any(i['status'] == 'BLOCKED' for i in plan['items']) else 'DISPATCHED'
            plan['error'] = None
            self._save_claim(plan, owner)
        except Exception as exc:
            plan['error'] = str(exc)[:300]
            self._save_claim(plan, owner)
            raise
        finally:
            with self.store.transaction() as db:
                db.execute('UPDATE workspace_daily_plans SET owner=NULL,lease_until=0 WHERE tenant=? AND id=? AND owner=?',
                           (self.app.tenant, identity, owner))
        return self.get(identity)

    def _save_claim(self, plan, owner):
        with self.store.transaction() as db:
            if not db.execute('UPDATE workspace_daily_plans SET data=?,lease_until=? WHERE tenant=? AND id=? AND owner=? AND lease_until>?',
                              (canonical(plan), time.time() + 120, self.app.tenant, plan['id'], owner, time.time())).rowcount:
                raise ConfigConflict('每日计划派发租约已变化，请刷新后恢复')


def tick(app, now=None):
    """Only today's occurrence catches up. Missed days never produce a task storm."""
    now = time.time() if now is None else now
    with app.runtime().store.connect() as db:
        rows = db.execute('SELECT workspace,data FROM workspace_schedules WHERE tenant=? AND principal=?', (app.tenant, app.principal)).fetchall()
    for row in rows:
        config = json.loads(row['data'])
        if not config['enabled']:
            continue
        local = datetime.fromtimestamp(now, ZoneInfo(config['timezone']))
        if local.strftime('%H:%M') < config['daily_time']:
            continue
        try:
            scoped = app.scoped(row['workspace'])
            service = WorkspaceScheduler(scoped)
            plan = service.generate(now)
            if plan['schedule_revision'] == config['revision']:
                service.dispatch(plan['id'])
        except (KeyError, ConfigConflict):
            continue
        except Exception:
            logging.getLogger(__name__).exception('Daily workspace dispatch failed for %s', row['workspace'])
