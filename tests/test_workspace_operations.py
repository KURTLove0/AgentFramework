from copy import deepcopy
from datetime import datetime
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from agent_framework.web import Application, WebServer
from agent_framework.contracts import PolicyDenied
from agent_framework.definitions import default_definition
from agent_framework.runtime_config import ConfigConflict
from agent_framework.workspace_scheduler import WorkspaceScheduler, tick
from agent_framework.agent_evaluation import AgentEvaluations


def role(name='每日审核岗位', domain='change-assessment@2.0.0'):
    return dict(name=name, description='每日岗位', runtime='mock', model='builtin', options={},
                prompt='根据证据履行岗位职责', skills=[], mcp_servers=[], revision=0,
                definition=default_definition(name, domain))


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.app = Application(self.tmp.name, lease_seconds=.5, tool_timeout=.2)
        self.addCleanup(self.app.close)
        self.agent = self.app.agents.save(role())
        self.scheduler = WorkspaceScheduler(self.app)
        self.evaluations = AgentEvaluations(self.app)

    def task(self, **kw):
        return dict(agent_id=self.agent['id'], agent_revision=self.agent['revision'], goal='评估每日变更并创建草稿',
                    change_id='change-daily-001', grant=False, consent=False, mcp_consent=False) | kw

    def config(self, **kw):
        return dict(revision=self.scheduler.settings()['revision'], enabled=False, timezone='Asia/Shanghai',
                    daily_time='09:00', auto_start=False, tasks=[self.task()]) | kw

    def complete(self, scenario='normal', agent=None):
        agent = agent or self.agent
        created = self.app.create(dict(agent_id=agent['id'], agent_revision=agent['revision'],
                                       start=False, grant=True, scenario=scenario))['run']
        return self.app.runtime().run(created['run_id'])

    def test_schedule_validation_versioning_and_safe_defaults(self):
        self.assertFalse(self.scheduler.settings()['enabled'])
        self.assertFalse(self.scheduler.settings()['auto_start'])
        saved = self.scheduler.save(self.config()); self.assertEqual(saved['revision'], 1)
        with self.assertRaises(ConfigConflict): self.scheduler.save(self.config(revision=0))
        for change in ({'timezone':'invalid/zone'}, {'daily_time':'24:00'}, {'auto_start':1},
                       {'tasks':[self.task(agent_revision=True)]}, {'tasks':[self.task(),self.task()]}):
            with self.assertRaises((ValueError, ConfigConflict)): self.scheduler.save(self.config(**change))
        with self.assertRaises(ConfigConflict): self.scheduler.save(self.config(tasks=[self.task(agent_revision=2)]))

    def test_daily_dispatch_is_idempotent_and_recovers_after_restart(self):
        self.scheduler.save(self.config())
        plan = self.scheduler.generate()
        one = self.scheduler.dispatch(plan['id']); two = self.scheduler.dispatch(plan['id'])
        self.assertEqual(one['items'][0]['run_id'], two['items'][0]['run_id'])
        self.assertEqual(self.app.runs()['counts']['total'], 1)
        self.assertFalse(self.app.detail(one['items'][0]['run_id'])['grant']['valid'])
        restarted = Application(self.tmp.name); self.addCleanup(restarted.close)
        recovered = WorkspaceScheduler(restarted).dispatch(plan['id'])
        self.assertEqual(recovered['items'][0]['run_id'], one['items'][0]['run_id'])
        self.assertEqual(restarted.runs()['counts']['total'], 1)

    def test_crash_after_creation_before_link_recovers_exact_run(self):
        self.scheduler.save(self.config())
        plan = self.scheduler.generate(); create = self.app.create
        def crash(*a, **kw):
            create(*a, **kw)
            raise RuntimeError('simulated loss after durable submit')
        with patch.object(self.app, 'create', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'simulated'): self.scheduler.dispatch(plan['id'])
        self.assertEqual(self.app.runs()['counts']['total'], 1)
        result = self.scheduler.dispatch(plan['id'])
        self.assertIsNotNone(result['items'][0]['run_id'])
        self.assertEqual(self.app.runs()['counts']['total'], 1)

    def test_concurrent_dispatch_shares_durable_claim(self):
        self.scheduler.save(self.config()); plan = self.scheduler.generate()
        second = Application(self.tmp.name); self.addCleanup(second.close)
        errors = []
        def dispatch(service):
            try: service.dispatch(plan['id'])
            except ConfigConflict: pass
            except Exception as exc: errors.append(exc)
        threads = [threading.Thread(target=dispatch, args=(service,)) for service in
                   (self.scheduler, WorkspaceScheduler(second))]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(errors, []); self.assertEqual(self.app.runs()['counts']['total'], 1)

    def test_unsubmitted_preview_regenerates_but_submitted_plan_is_frozen(self):
        empty = self.scheduler.generate(); self.assertEqual(empty['items'], [])
        self.scheduler.save(self.config())
        plan = self.scheduler.generate(); self.assertEqual(len(plan['items']), 1)
        self.assertEqual(plan['id'], empty['id'])
        dispatched = self.scheduler.dispatch(plan['id'])
        self.scheduler.save(self.config(tasks=[self.task(goal='另一个每日目标')]))
        self.assertEqual(self.scheduler.generate()['items'], dispatched['items'])
        with self.assertRaises(ConfigConflict): self.scheduler.dispatch(plan['id'])

    def test_manual_task_created_after_preview_is_reused(self):
        self.scheduler.save(self.config()); plan = self.scheduler.generate()
        manual = self.app.create({**self.task(), 'start':False})['run']['run_id']
        result = self.scheduler.dispatch(plan['id'])
        self.assertEqual(result['items'][0]['status'],'SKIPPED')
        self.assertEqual(result['items'][0]['existing_run_id'],manual)
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_agent_revision_drift_blocks_dispatch_without_creating_run(self):
        self.scheduler.save(self.config()); plan = self.scheduler.generate()
        self.app.agents.save(role() | {'revision':1}, self.agent['id'])
        result = self.scheduler.dispatch(plan['id'])
        self.assertEqual(result['status'], 'PARTIAL')
        self.assertEqual(result['items'][0]['status'], 'BLOCKED')
        self.assertEqual(self.app.runs()['counts']['total'], 0)

    def test_daily_tick_due_timezone_dedup_and_skips_unfinished_duplicates(self):
        self.scheduler.save(self.config(enabled=True))
        day = datetime(2026,10,23,8,59,tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()
        tick(self.app, day); self.assertEqual(self.scheduler.plans(), [])
        self.assertTrue(self.scheduler.overview(day+60)['catch_up_pending'])
        tick(self.app, day+60); tick(self.app, day+90)
        self.assertEqual(self.app.runs()['counts']['total'], 1)
        self.assertEqual(len(self.scheduler.plans()), 1)
        tick(self.app, day+86400+60)
        plan = self.scheduler.plans()[0]
        self.assertEqual(plan['day'], '2026-10-24')
        self.assertEqual(plan['items'][0]['status'], 'SKIPPED')
        self.assertEqual(self.app.runs()['counts']['total'], 1)
        # No backlog of intermediate dates is replayed after an outage.
        tick(self.app, day+86400*5+60)
        self.assertEqual(len(self.scheduler.plans()), 3)

    def test_disabled_and_deleted_workspace_do_not_dispatch(self):
        self.scheduler.save(self.config()); tick(self.app)
        self.assertEqual(self.scheduler.plans(), [])
        w = self.app.workspaces.save(dict(name='暂存空间', business='测试', scenario='每日任务', description='', revision=0))
        scoped = self.app.scoped(w['id']); agent = scoped.agents.save(role())
        service = WorkspaceScheduler(scoped)
        service.save(self.config(revision=0,enabled=True,tasks=[self.task(agent_id=agent['id'])]))
        self.app.workspaces.lifecycle(w['id'],1,True)
        tick(self.app, datetime(2026,10,23,12,tzinfo=ZoneInfo('Asia/Shanghai')).timestamp())
        self.assertEqual(service.plans(), [])

    def test_auto_start_still_waits_for_business_authorization(self):
        self.scheduler.save(self.config(auto_start=True))
        result = self.scheduler.dispatch(self.scheduler.generate()['id'])
        run_id = result['items'][0]['run_id']
        until = time.time()+8
        while (self.app.job(run_id) or {}).get('active') and time.time()<until: time.sleep(.02)
        detail = self.app.detail(run_id)
        self.assertEqual(detail['run']['status'], 'WAITING_AUTH')
        self.assertEqual(len(detail['external']['drafts']), 0)
        self.assertEqual(self.evaluations.overview()['reports'], [])
        self.scheduler.dispatch(result['id'])
        self.assertEqual(self.app.runs()['counts']['total'], 1)
        self.assertEqual(self.app.detail(run_id)['run']['status'], 'WAITING_AUTH')

    def test_auto_start_recovers_a_paused_execution_using_same_run(self):
        self.scheduler.save(self.config(auto_start=True,tasks=[self.task(grant=True)]))
        with patch.object(self.app,'schedule'):
            plan = self.scheduler.dispatch(self.scheduler.generate()['id'])
        run_id = plan['items'][0]['run_id']
        paused = self.app.runtime().run(run_id,pause_after=1)
        self.assertEqual(paused['status'],'RUNNING')
        self.scheduler.dispatch(plan['id'])
        until = time.time()+8
        while (self.app.job(run_id) or {}).get('active') and time.time()<until: time.sleep(.02)
        self.assertEqual(self.app.detail(run_id)['run']['status'],'SUCCEEDED')
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_terminal_evaluation_frozen_role_full_score_and_idempotency(self):
        result = self.complete()
        data = self.evaluations.overview(); report = data['reports'][0]
        self.assertEqual(report['score'], 100); self.assertEqual(report['verdict'], 'PASS')
        self.assertEqual(report['agent_id'], self.agent['id']); self.assertTrue(report['evidence_refs'])
        edited = role() | {'revision':1}
        edited['definition']['identity']['role'] = '新的岗位职责'
        self.app.agents.save(edited, self.agent['id'])
        self.evaluations.evaluate(result['run_id'])
        self.assertEqual(self.evaluations.overview()['reports'][0]['id'], report['id'])
        self.assertEqual(report['identity']['role'], 'release_reviewer')
        with self.app.runtime().store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM agent_evaluations').fetchone()[0], 1)

    def test_failed_baseline_alerts_even_above_low_threshold_and_ack_persists(self):
        self.evaluations.save_policy(dict(revision=0, threshold=1, window_days=30, automatic=True))
        result = self.complete('tampered-draft')
        data = self.evaluations.overview(); report = data['reports'][0]
        self.assertGreater(report['score'], 1); self.assertEqual(report['verdict'], 'FAIL')
        self.assertEqual(data['open_alert_count'], 1)
        alert = data['alerts'][0]; self.evaluations.acknowledge(alert['id'])
        self.evaluations.evaluate(result['run_id'])
        self.assertEqual(self.evaluations.overview()['open_alert_count'], 0)
        restarted = Application(self.tmp.name); self.addCleanup(restarted.close)
        self.assertIsNotNone(AgentEvaluations(restarted).overview()['alerts'][0]['acknowledged_at'])
        self.assertEqual(len(AgentEvaluations(restarted).overview()['alerts']), 1)

    def test_manual_history_and_policy_revision_preserve_prior_reports(self):
        self.evaluations.save_policy(dict(revision=0, threshold=80, window_days=30, automatic=False))
        result = self.complete('read-fails')
        self.assertEqual(self.evaluations.overview()['reports'], [])
        self.assertEqual(self.evaluations.evaluate()['evaluated'], 1)
        first = self.evaluations.overview()['reports'][0]
        self.evaluations.save_policy(dict(revision=1, threshold=90, window_days=7, automatic=True))
        self.evaluations.evaluate(result['run_id'])
        self.assertNotEqual(self.evaluations.overview()['reports'][0]['id'],first['id'])
        self.assertEqual(self.evaluations.get(first['id'])['policy']['threshold'],80)
        with self.app.runtime().store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM agent_evaluations').fetchone()[0],2)
        with self.assertRaises(ConfigConflict): self.evaluations.save_policy(dict(revision=0, threshold=90, window_days=7, automatic=True))

    def test_cancellation_excluded_and_active_runs_not_failed(self):
        r = self.app.create({'start':False})['run']['run_id']
        with self.assertRaises(ConfigConflict): self.evaluations.evaluate(r)
        self.app.mutate(r,'cancel')
        report = self.evaluations.overview()['reports'][0]
        self.assertIsNone(report['score']); self.assertEqual(report['verdict'],'EXCLUDED')
        self.assertEqual(self.evaluations.overview()['open_alert_count'],0)
        self.assertEqual(self.evaluations.overview()['agents'][0]['sample_count'],0)

    def test_evaluations_and_plans_isolated_by_workspace_tenant_and_principal(self):
        result = self.complete('read-fails')
        self.scheduler.save(self.config()); plan = self.scheduler.generate()
        w = self.app.workspaces.save(dict(name='另一空间',business='测试',scenario='隔离',description='',revision=0))
        other = self.app.scoped(w['id'])
        self.assertEqual(AgentEvaluations(other).overview()['reports'],[])
        self.assertEqual(WorkspaceScheduler(other).plans(),[])
        with self.assertRaises(PolicyDenied): AgentEvaluations(other).evaluate(result['run_id'])
        with self.assertRaises(KeyError): WorkspaceScheduler(other).dispatch(plan['id'])
        with self.assertRaises(KeyError): AgentEvaluations(other).acknowledge(self.evaluations.overview()['alerts'][0]['id'])
        for kwargs in ({'tenant':'other'},{'principal':'someone-else'}):
            isolated = Application(self.tmp.name,**kwargs); self.addCleanup(isolated.close)
            self.assertEqual(AgentEvaluations(isolated).overview()['reports'],[])
            self.assertEqual(WorkspaceScheduler(isolated).plans(),[])


class OperationsHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name);self.addCleanup(self.app.close)
        self.server=WebServer(('127.0.0.1',0),self.app)
        threading.Thread(target=self.server.serve_forever,kwargs={'poll_interval':.02},daemon=True).start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def request(self,path,body=None,token=True):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=8)
        headers={'Content-Type':'application/json'}
        if token:headers['X-Agent-Token']=self.app.token
        c.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
        r=c.getresponse();status=r.status;payload=r.read();c.close()
        return status,json.loads(payload) if r.headers.get('Content-Type','').startswith('application/json') else payload

    def test_routes_validation_csrf_and_static_assets(self):
        self.assertEqual(self.request('/api/workspace-schedule')[0],200)
        self.assertEqual(self.request('/api/agent-evaluations')[0],200)
        self.assertEqual(self.request('/api/operation-status')[1]['open_alert_count'],0)
        self.assertEqual(self.request('/operations.js')[0],200)
        self.assertEqual(self.request('/operations.css')[0],200)
        self.assertEqual(self.request('/api/daily-plans/generate',{},False)[0],403)
        self.assertEqual(self.request('/api/daily-plans/generate',{'day':'2020-01-01'})[0],400)
        status,plan=self.request('/api/daily-plans/generate',{});self.assertEqual(status,200)
        self.assertEqual(self.request('/api/daily-plans/'+plan['id']+'/dispatch',{})[0],200)
        self.assertEqual(self.request('/api/agent-evaluations/evaluate',{})[1]['evaluated'],0)
        self.assertEqual(self.request('/api/evaluation-policy',{'revision':0,'threshold':80,'window_days':30,'automatic':True})[0],200)
        self.assertEqual(self.request('/api/evaluation-policy',{'revision':0,'threshold':80,'window_days':30,'automatic':True})[0],409)
        self.assertEqual(self.request('/api/agent-alerts/alert-missing/acknowledge',{})[0],404)
