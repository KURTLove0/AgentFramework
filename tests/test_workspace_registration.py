"""Historical project discovery reads identifiers without loading task bodies."""
from copy import deepcopy
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_framework.contracts import TaskContract,canonical,digest
from agent_framework.runtime import Runtime
from agent_framework.store import Store
from agent_framework.web import Application
from agent_framework.workspaces import WorkspaceRegistry


class WorkspaceRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'runtime.sqlite3');self.tenant='tenant-registration'
        self.registry=WorkspaceRegistry(self.store,self.tenant)

    def seed(self,projects,*,tenant=None,body_bytes=1024):
        tenant=tenant or self.tenant
        task=TaskContract(tenant_id=tenant)
        template=self.store.create(task,{'hash':'synthetic-registration-snapshot'},'normal',grant=False)
        identities=[]
        with self.store.transaction() as db:
            for index,project in enumerate(projects):
                identity='run-registration-'+str(index)+'-'+digest([tenant,project])[:8]
                state=deepcopy(template);state.update(run_id=identity,status='SUCCEEDED',version=1,report={'content':'x'*body_bytes})
                state['task']['project_id']=project
                db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,1,?)',(tenant,identity,canonical(state)));identities.append(identity)
                self.store.event(db,tenant,identity,'fixture.history',{'note':'保留原审计','snapshot_hash':state['snapshot']['hash']})
            db.execute('DELETE FROM runs WHERE tenant_id=? AND id=?',(tenant,template['run_id']))
            db.execute('DELETE FROM events WHERE tenant_id=? AND run_id=?',(tenant,template['run_id']))
        return identities

    def directory(self):
        return {w['project_id']:w for w in self.registry.list()}

    def raw(self,table):
        with self.store.connect() as db:return [tuple(r) for r in db.execute('SELECT * FROM '+table+' ORDER BY rowid')]

    def test_repeated_runs_register_each_project_once_without_decoding_task_json(self):
        self.seed(['project-a','project-b','project-a','project-demo']*20,body_bytes=8192)
        with patch('agent_framework.workspaces.json.loads',side_effect=AssertionError('Full task JSON decoded')):
            WorkspaceRegistry(self.store,self.tenant)
        projects=self.directory();self.assertEqual(set(projects),{'project-demo','project-a','project-b'})
        for project in ['project-a','project-b']:
            self.assertEqual(projects[project]['id'],'workspace-legacy-'+digest(project)[:16]);self.assertEqual(projects[project]['name'],project)

    def test_already_registered_projects_do_not_attempt_an_insert_for_every_run(self):
        self.seed(['project-a']*70+['project-demo']*30)
        WorkspaceRegistry(self.store,self.tenant)
        before=self.raw('workspaces');statements=[];connect=self.store.connect
        def traced():
            db=connect();db.set_trace_callback(statements.append);return db
        with patch.object(self.store,'connect',traced):WorkspaceRegistry(self.store,self.tenant)
        inserts=[sql for sql in statements if sql.lstrip().upper().startswith('INSERT')]
        self.assertEqual(len(inserts),1,'Only the fixed default workspace initialization may be attempted')
        self.assertEqual(self.raw('workspaces'),before)

    def test_existing_names_revisions_and_deleted_workspaces_are_preserved(self):
        self.seed(['project-a','project-b','project-demo']*3);WorkspaceRegistry(self.store,self.tenant)
        projects=self.directory();a=projects['project-a'];b=projects['project-b']
        self.registry.save({'name':'用户修改的空间名','business':'已配置业务','scenario':'已配置场景','description':'保留说明','revision':1},a['id'])
        self.registry.lifecycle(b['id'],1,True);self.registry.lifecycle('workspace-default',1,True)
        before=self.raw('workspaces');WorkspaceRegistry(self.store,self.tenant);self.assertEqual(self.raw('workspaces'),before)
        self.assertTrue(self.registry.get(b['id'],include_deleted=True)['deleted']);self.assertEqual(self.registry.get(a['id'])['revision'],2)

    def test_new_projects_added_after_an_earlier_start_are_discovered(self):
        self.seed(['project-a']);WorkspaceRegistry(self.store,self.tenant)
        self.seed(['project-later']);WorkspaceRegistry(self.store,self.tenant)
        self.assertEqual(set(self.directory()),{'project-demo','project-a','project-later'})

    def test_registration_does_not_rewrite_frozen_runs_or_audit(self):
        self.seed(['project-a','project-b']*5)
        before_runs=self.raw('runs');before_events=self.raw('events');WorkspaceRegistry(self.store,self.tenant)
        self.assertEqual(len(before_events),10)
        self.assertEqual(self.raw('runs'),before_runs);self.assertEqual(self.raw('events'),before_events)

    def test_other_tenants_projects_and_corrupt_json_are_not_read(self):
        self.seed(['project-own']);self.seed(['project-foreign'],tenant='tenant-other')
        with self.store.transaction() as db:db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,0,?)',('tenant-other','run-corrupt','{invalid json'))
        WorkspaceRegistry(self.store,self.tenant);self.assertEqual(set(self.directory()),{'project-demo','project-own'})
        with self.store.transaction() as db:db.execute('DELETE FROM runs WHERE id=?',('run-corrupt',))
        other=WorkspaceRegistry(self.store,'tenant-other');self.assertEqual({w['project_id'] for w in other.list()},{'project-demo','project-foreign'})

    def test_two_simultaneous_registries_create_one_workspace_per_project(self):
        self.seed(['project-a','project-b']*10);barrier=threading.Barrier(3);results=[];errors=[]
        def start():
            try:
                store=Store(self.store.path);barrier.wait(timeout=5);results.append(WorkspaceRegistry(store,self.tenant).list())
            except BaseException as error:errors.append(error)
        threads=[threading.Thread(target=start) for _ in range(2)]
        for thread in threads:thread.start()
        barrier.wait(timeout=5)
        for thread in threads:thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads));self.assertEqual(errors,[]);self.assertEqual(len(results),2)
        self.assertEqual({w['project_id'] for w in results[0]},{'project-demo','project-a','project-b'})
        self.assertEqual(results[0],results[1])

    def test_invalid_project_headers_fail_without_partial_registration_or_body_disclosure(self):
        for project in [None,7,True,[],{},'z invalid-project']:
            with self.subTest(project=project):
                with self.store.transaction() as db:db.execute('DELETE FROM runs')
                self.seed(['project-valid',project]);before=self.raw('workspaces')
                with self.assertRaisesRegex(ValueError,'历史任务.*项目标识'):
                    WorkspaceRegistry(self.store,self.tenant)
                self.assertEqual(self.raw('workspaces'),before)

    def test_malformed_current_tenant_json_is_not_silently_hidden(self):
        self.seed(['project-valid']);before=self.raw('workspaces')
        with self.store.transaction() as db:db.execute('INSERT INTO runs(tenant_id,id,version,state) VALUES(?,?,0,?)',(self.tenant,'run-corrupt','{invalid json'))
        with self.assertRaises((ValueError,sqlite3.DatabaseError)):WorkspaceRegistry(self.store,self.tenant)
        self.assertEqual(self.raw('workspaces'),before)

    def test_actual_application_restart_keeps_historical_project_and_snapshot_accessible(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime=Runtime(directory)
            original=runtime.submit(task=TaskContract(project_id='project-historical-cli',principal='demo-user'))
            app=Application(directory);self.addCleanup(app.close)
            space=next(w for w in app.workspaces.list() if w['project_id']=='project-historical-cli')
            scoped=app.scoped(space['id']);detail=scoped.detail(original['run_id'])
            self.assertEqual(detail['run']['snapshot'],original['snapshot']);self.assertEqual(canonical(detail['run']['task']),canonical(original['task']))
            self.assertEqual([item['run_id'] for item in scoped.runs()['runs']],[original['run_id']])
