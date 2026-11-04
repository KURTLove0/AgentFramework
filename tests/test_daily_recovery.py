"""Accepted daily work keeps its target and survives backlog and process loss."""
from copy import deepcopy
from datetime import date, timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import canonical
from agent_framework.runtime_config import ConfigConflict
from agent_framework.workspace_scheduler import WorkspaceScheduler, tick
from agent_framework.web import Application
from tests.test_workspace_operations import role


class DailyRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.addCleanup(lambda:self.app.close())
        self.agent=self.app.agents.save(role());self.service=WorkspaceScheduler(self.app)

    def task(self,goal='原始每日目标'):
        return dict(agent_id=self.agent['id'],agent_revision=1,goal=goal,change_id='change-daily-001',grant=True,consent=False,mcp_consent=False)

    def config(self,**changes):
        return dict(revision=self.service.settings()['revision'],enabled=False,timezone='Asia/Shanghai',daily_time='00:00',auto_start=False,tasks=[self.task()])|changes

    def fill(self):
        self.app.jobs.update({'capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})

    def release(self):
        for identity in list(self.app.jobs):
            if identity.startswith('capacity-'):del self.app.jobs[identity]

    def wait(self,run_id,status='SUCCEEDED'):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            result=self.app.detail(run_id)
            if result['run']['status']==status and not (result['job'] or {}).get('active'):return result
            time.sleep(.02)
        self.fail('task did not reach '+status)

    def crash_after_submit(self,plan):
        create=self.app.create
        def crash(*args,**kwargs):
            create(*args,**kwargs);raise RuntimeError('lost receipt after submit')
        with patch.object(self.app,'create',side_effect=crash):
            with self.assertRaisesRegex(RuntimeError,'lost receipt'):self.service.dispatch(plan['id'])

    def test_unlinked_run_keeps_original_goal_after_configuration_edit(self):
        self.service.save(self.config());plan=self.service.generate();self.crash_after_submit(plan)
        self.service.save(self.config(tasks=[self.task('新目标')]))
        frozen=self.service.generate();self.assertEqual(frozen['schedule_revision'],1)
        self.assertEqual(frozen['items'][0]['task']['goal'],'原始每日目标')
        recovered=self.service.dispatch(plan['id'])
        run=self.app.runtime().store.load(self.app.tenant,recovered['items'][0]['run_id'])
        self.assertEqual(run['task']['goal'],recovered['items'][0]['task']['goal'])
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_legacy_unlinked_run_freezes_regeneration_without_new_dispatch_metadata(self):
        self.service.save(self.config());plan=self.service.generate();self.crash_after_submit(plan)
        old=self.service.get(plan['id']);old.pop('dispatch')
        with self.app.runtime().store.transaction() as db:db.execute('UPDATE workspace_daily_plans SET data=?',(canonical(old),))
        self.service.save(self.config(tasks=[self.task('新模板')]))
        self.assertEqual(self.service.generate()['items'][0]['task']['goal'],'原始每日目标')
        recovered=self.service.dispatch(plan['id']);self.assertEqual(len(self.app.accessible_run_states()),1)
        self.assertEqual(recovered['dispatch']['state'],'COMPLETE')

    def test_capacity_backlog_materializes_all_items_and_recovers_after_midnight_and_disable(self):
        self.service.save(self.config(auto_start=True,tasks=[self.task('目标一'),self.task('目标二')]))
        self.fill();plan=self.service.dispatch(self.service.generate()['id'])
        self.assertEqual(plan['status'],'QUEUED');self.assertEqual(plan['dispatch']['state'],'PENDING');self.assertIsNone(plan['error'])
        ids=[item['run_id'] for item in plan['items']];self.assertTrue(all(ids));self.assertEqual(self.app.runs()['counts']['total'],2)
        self.service.save(self.config(auto_start=False,tasks=[self.task('后续新目标')]))
        self.release();tick(self.app,now=plan['created_at']+86400)
        for identity in ids:self.wait(identity)
        tick(self.app,now=plan['created_at']+86401)
        recovered=self.service.get(plan['id']);self.assertEqual(recovered['dispatch']['state'],'COMPLETE')
        self.assertEqual([item['run_id'] for item in recovered['items']],ids)
        self.assertEqual(len(self.service.plans()),1)
        self.assertEqual(self.app.runs()['counts']['total'],2)

    def test_restarted_service_recovers_saved_automatic_start_without_schedule_enabled(self):
        self.service.save(self.config(auto_start=True));self.fill();plan=self.service.dispatch(self.service.generate()['id']);run=plan['items'][0]['run_id']
        self.release();self.app.close();self.app=Application(self.tmp.name,lease_seconds=.5,tool_timeout=.2);self.service=WorkspaceScheduler(self.app)
        tick(self.app);self.wait(run);tick(self.app)
        self.assertEqual(self.service.get(plan['id'])['dispatch']['state'],'COMPLETE')
        self.assertEqual(len(self.app.detail(run)['external']['drafts']),1)
        self.assertEqual(self.app.detail(run)['external']['calls']['report.draft.create@1.0.0'],1)

    def test_manual_start_plan_stays_created_and_is_not_recovered_automatically(self):
        self.service.save(self.config());plan=self.service.dispatch(self.service.generate()['id']);run=plan['items'][0]['run_id']
        self.assertEqual(plan['dispatch']['state'],'COMPLETE')
        tick(self.app,now=plan['created_at']+86400)
        self.assertEqual(self.app.detail(run)['run']['status'],'CREATED');self.assertIsNone(self.app.job(run))

    def test_authorization_wait_and_cancellation_end_automatic_start_intent(self):
        self.service.save(self.config(auto_start=True,tasks=[self.task()|{'grant':False}]))
        plan=self.service.dispatch(self.service.generate()['id']);run=plan['items'][0]['run_id'];self.wait(run,'WAITING_AUTH')
        with patch.object(self.app,'schedule') as schedule:tick(self.app);schedule.assert_not_called()
        self.assertEqual(self.service.get(plan['id'])['dispatch']['state'],'COMPLETE')
        self.assertFalse(self.app.detail(run)['external']['drafts'])
        self.app.mutate(run,'cancel');tick(self.app);self.wait(run,'CANCELLED')

    def test_unexpected_dispatch_failure_is_visible_and_requires_explicit_retry(self):
        self.service.save(self.config(auto_start=True));plan=self.service.generate()
        with patch.object(self.app,'schedule',side_effect=RuntimeError('executor unavailable')):
            with self.assertRaisesRegex(RuntimeError,'executor unavailable'):self.service.dispatch(plan['id'])
        failed=self.service.get(plan['id']);run=failed['items'][0]['run_id'];self.assertEqual(failed['dispatch']['state'],'FAILED')
        self.service.save(self.config(enabled=True))
        with patch.object(Application,'schedule') as schedule:tick(self.app);schedule.assert_not_called()
        self.assertEqual(self.service.get(plan['id'])['dispatch']['state'],'FAILED')
        self.service.dispatch(plan['id']);self.wait(run)
        self.assertEqual(self.app.runs()['counts']['total'],1)
        self.assertEqual(self.service.get(plan['id'])['dispatch']['last_error'],'executor unavailable')

    def test_worker_error_stops_background_retries_and_surfaces_in_attention(self):
        self.service.save(self.config(auto_start=True));self.fill();plan=self.service.dispatch(self.service.generate()['id']);run=plan['items'][0]['run_id'];self.release()
        self.app.jobs[run]={'active':False,'state':'ERROR','error':'worker failed'}
        with self.assertLogs('agent_framework.workspace_scheduler',level='ERROR'):tick(self.app)
        self.assertEqual(self.service.get(plan['id'])['dispatch']['state'],'FAILED')
        self.assertEqual(self.app.attention()['daily_plans'][0]['id'],plan['id'])
        with patch.object(Application,'schedule') as schedule:tick(self.app);schedule.assert_not_called()
        self.service.dispatch(plan['id']);self.wait(run)

    def test_existing_run_with_wrong_goal_cannot_be_silently_linked(self):
        self.service.save(self.config());plan=self.service.generate();self.crash_after_submit(plan)
        run_id=self.service._run_id(plan,plan['items'][0])
        with self.app.runtime().store.transaction() as db:
            db.execute("UPDATE runs SET state=json_set(state,'$.task.goal','错误目标') WHERE id=?",(run_id,))
        with self.assertRaisesRegex(ConfigConflict,'模板不匹配'):self.service.dispatch(plan['id'])
        failed=self.service.get(plan['id']);self.assertIsNone(failed['items'][0]['run_id']);self.assertEqual(failed['dispatch']['state'],'FAILED')
        self.assertEqual(self.app.runs()['counts']['total'],1)

    def test_config_change_before_claim_rejects_old_preview_without_a_request(self):
        self.service.save(self.config());plan=self.service.generate();self.service.save(self.config(tasks=[self.task('修改')]))
        with self.assertRaises(ConfigConflict):self.service.dispatch(plan['id'])
        self.assertNotIn('dispatch',self.service.get(plan['id']));self.assertEqual(self.app.runs()['counts']['total'],0)
        self.assertEqual(self.service.generate()['items'][0]['task']['goal'],'修改')

    def test_configuration_change_during_submission_preserves_entire_original_plan(self):
        self.service.save(self.config(tasks=[self.task('原目标一'),self.task('原目标二')]));plan=self.service.generate();create=self.app.create
        def create_then_edit(*args,**kwargs):
            result=create(*args,**kwargs)
            if kwargs['run_id']==self.service._run_id(plan,plan['items'][0]):
                self.service.save(self.config(tasks=[self.task('新配置目标')]))
                preview=self.service.generate();self.assertEqual(preview['schedule_revision'],1)
            return result
        with patch.object(self.app,'create',side_effect=create_then_edit):dispatched=self.service.dispatch(plan['id'])
        self.assertEqual([self.app.detail(i['run_id'])['run']['task']['goal'] for i in dispatched['items']],['原目标一','原目标二'])

    def test_interruption_before_any_run_preserves_accepted_request_and_original_template(self):
        self.service.save(self.config());plan=self.service.generate()
        with patch.object(self.app,'create',side_effect=SystemExit(73)):
            with self.assertRaises(SystemExit):self.service.dispatch(plan['id'])
        self.assertEqual(self.app.runs()['counts']['total'],0)
        self.assertEqual(self.service.get(plan['id'])['dispatch']['state'],'PENDING')
        self.service.save(self.config(tasks=[self.task('后来编辑的目标')]))
        self.assertEqual(self.service.generate()['items'][0]['task']['goal'],'原始每日目标')
        tick(self.app,now=time.time()+86400)
        recovered=self.service.get(plan['id']);self.assertEqual(recovered['dispatch']['state'],'COMPLETE')
        self.assertEqual(self.app.detail(recovered['items'][0]['run_id'])['run']['task']['goal'],'原始每日目标')

    def test_accepted_intent_before_first_run_blocks_workspace_deletion(self):
        from tests.test_workspaces import space
        self.app.workspaces.save(space());identity=self.app.workspace['id']
        self.service.save(self.config());plan=self.service.generate()
        with patch.object(self.app,'create',side_effect=SystemExit(73)):
            with self.assertRaises(SystemExit):self.service.dispatch(plan['id'])
        check=self.app.workspaces.deletion_check(identity)
        self.assertEqual([(b['kind'],b['count']) for b in check['blockers']],[('daily_dispatch',1)])
        with self.assertRaisesRegex(ConfigConflict,'等待派发'):self.app.workspaces.lifecycle(identity,1,True)
        tick(self.app);dispatched=self.service.get(plan['id'])
        self.app.mutate(dispatched['items'][0]['run_id'],'cancel')
        self.assertTrue(self.app.workspaces.deletion_check(identity)['can_delete'])

    def test_old_pending_and_failed_plans_stay_visible_beyond_sixty_recent_dates(self):
        self.service.save(self.config(auto_start=True));self.fill();plan=self.service.dispatch(self.service.generate(now=1_700_000_000)['id'])
        with self.app.runtime().store.transaction() as db:
            for index in range(65):
                newer=deepcopy(plan);newer.update(id='recent-'+str(index),day=(date(2030,1,1)+timedelta(days=index)).isoformat(),items=[],status='DISPATCHED',dispatch={'state':'COMPLETE'})
                db.execute('INSERT INTO workspace_daily_plans VALUES(?,?,?,?,?,?,NULL,0,?)',(*self.service.scope,newer['day'],newer['id'],canonical(newer),time.time()))
        for status in ('PENDING','FAILED'):
            plan['dispatch']['state']=status
            with self.app.runtime().store.transaction() as db:db.execute('UPDATE workspace_daily_plans SET data=? WHERE id=?',(canonical(plan),plan['id']))
            self.assertEqual(len(self.service.plans()),61);self.assertIn(plan['id'],{p['id'] for p in self.service.plans()})
        self.release()

    def test_process_exit_after_submit_retains_intent_and_original_snapshot(self):
        self.service.save(self.config());plan=self.service.generate()
        program='''
import os,sys
from agent_framework.web import Application
from agent_framework.workspace_scheduler import WorkspaceScheduler
app=Application(sys.argv[1]);create=app.create
def lost(*args,**kwargs):
    create(*args,**kwargs)
    os._exit(73)
app.create=lost
WorkspaceScheduler(app).dispatch(sys.argv[2])
'''
        process=subprocess.run([sys.executable,'-c',program,self.tmp.name,plan['id']],cwd=Path(__file__).resolve().parents[1],capture_output=True,timeout=10)
        self.assertEqual(process.returncode,73,process.stderr.decode())
        pending=self.service.get(plan['id']);self.assertEqual(pending['dispatch']['state'],'PENDING');self.assertIsNone(pending['items'][0]['run_id'])
        self.service.save(self.config(tasks=[self.task('退出后修改的目标')]))
        self.assertEqual(self.service.generate()['schedule_revision'],1)
        with self.app.runtime().store.transaction() as db:db.execute('UPDATE workspace_daily_plans SET lease_until=0')
        tick(self.app);recovered=self.service.get(plan['id']);self.assertEqual(recovered['dispatch']['state'],'COMPLETE')
        self.assertEqual(self.app.detail(recovered['items'][0]['run_id'])['run']['task']['goal'],'原始每日目标')
        self.assertEqual(self.app.runs()['counts']['total'],1)
