"""Historical CLI reads never initialize an executor or migrate source records."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent_framework.cli import main
from agent_framework.contracts import TaskContract
from agent_framework.runtime import Runtime
from agent_framework.backups import RESTORE_MARKER, _restore_guard
from agent_framework.exports import verify_export
from agent_framework.inspection import read_run
from agent_framework.store import Store, ClosingConnection


class InspectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='inspection-',dir='/private/tmp');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.data=self.root/'历史 工作台';self.runtime=Runtime(self.data)
        self.run=self.runtime.submit(TaskContract(),grant=False)

    def invoke(self,command,*,data=None,tenant='tenant-demo',extra=()):
        stdout,stderr=io.StringIO(),io.StringIO()
        args=['--data-dir',str(data or self.data),'--tenant',tenant,command,self.run['run_id'],*extra]
        with redirect_stdout(stdout),redirect_stderr(stderr):status=main(args)
        return status,stdout.getvalue(),stderr.getvalue()

    def test_missing_source_is_rejected_without_creating_a_workbench(self):
        for command in ('show','events','stats','export'):
            source=self.root/('missing-'+command);extra=(str(self.root/('export-'+command)),) if command=='export' else ()
            with self.subTest(command=command):
                status,_,error=self.invoke(command,data=source,extra=extra)
                self.assertEqual(status,1);self.assertFalse(source.exists());self.assertIn('error:',error)

    def test_reads_do_not_construct_runtime_or_model_planner(self):
        with patch('agent_framework.cli.Runtime',side_effect=AssertionError('read initialized runtime')),patch('agent_framework.cli.LLMPlanner',side_effect=AssertionError('read initialized model')):
            for command in ('show','events','stats','export'):
                extra=(str(self.root/'no-runtime-export'),) if command=='export' else ()
                with self.subTest(command=command):self.assertEqual(self.invoke(command,extra=extra)[0],0)

    def test_show_and_export_work_without_creating_a_missing_business_database(self):
        business=self.data/'mock-business.sqlite3';business.unlink()
        self.assertEqual(self.invoke('show',extra=('--full',))[0],0)
        self.assertEqual(self.invoke('export',extra=(str(self.root/'export'),))[0],0)
        self.assertFalse(business.exists())

    def test_missing_business_database_is_not_reported_as_zero_effects(self):
        business=self.data/'mock-business.sqlite3';business.unlink()
        status,_,error=self.invoke('stats')
        self.assertEqual(status,1);self.assertFalse(business.exists());self.assertIn('业务',error)

    def test_old_schema_is_read_without_creating_new_control_tables(self):
        path=self.data/'runtime.sqlite3'
        with sqlite3.connect(path,factory=ClosingConnection) as db:
            for table in ('run_cancellations','context_manifests','native_reads','experience_candidates'):db.execute('DROP TABLE '+table)
        before=path.read_bytes()
        status,raw,_=self.invoke('show',extra=('--full',));self.assertEqual(status,0);self.assertIsNone(json.loads(raw)['cancellation'])
        self.assertEqual(json.loads(raw)['native_reads'],[])
        self.assertEqual(self.invoke('export',extra=(str(self.root/'old-schema-export'),))[0],0)
        self.assertTrue(verify_export(self.root/'old-schema-export')['valid'])
        self.assertEqual(path.read_bytes(),before)
        with sqlite3.connect(path,factory=ClosingConnection) as db:self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='run_cancellations'").fetchone())

    def test_read_only_store_rejects_updates_and_does_not_touch_execution_ownership(self):
        source=self.data/'runtime.sqlite3';before=source.read_bytes();store=Store(source,read_only=True)
        with self.assertRaises(ValueError):
            with store.transaction():pass
        with store.connect() as db:
            self.assertEqual(db.execute('PRAGMA query_only').fetchone()[0],1)
            with self.assertRaises(sqlite3.OperationalError):db.execute('DELETE FROM runs')
        with patch('agent_framework.cli.CodexConfig.local',side_effect=AssertionError('read loaded local model settings')),redirect_stdout(io.StringIO()):
            self.assertEqual(main(['--data-dir',str(self.data),'--planner','codex','--model','unavailable-model','--lease-seconds','0','show',self.run['run_id']]),0)
        self.assertEqual(source.read_bytes(),before)
        with store.connect() as db:
            row=db.execute('SELECT owner,epoch,lease_until FROM runs WHERE id=?',(self.run['run_id'],)).fetchone()
        self.assertEqual(tuple(row),(None,0,0))

    def test_committed_wal_records_are_visible_without_checkpointing_or_immutable_mode(self):
        path=self.data/'runtime.sqlite3';writer=self.runtime.store.connect();self.addCleanup(writer.close)
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute("UPDATE runs SET state=json_set(state,'$.last_error',?) WHERE id=?",('WAL 中的最新记录',self.run['run_id']))
        self.runtime.store.event(writer,'tenant-demo',self.run['run_id'],'inspection.wal',{'saved':True});writer.commit()
        wal=Path(str(path)+'-wal');self.assertTrue(wal.exists());before=path.read_bytes();wal_before=wal.read_bytes()
        status,raw,_=self.invoke('show',extra=('--full',));self.assertEqual(status,0);self.assertEqual(json.loads(raw)['last_error'],'WAL 中的最新记录')
        status,raw,_=self.invoke('events');self.assertEqual(status,0);self.assertEqual(json.loads(raw.splitlines()[-1])['kind'],'inspection.wal')
        self.assertEqual(path.read_bytes(),before);self.assertEqual(wal.read_bytes(),wal_before)

    def test_restore_guards_block_all_inspection_before_opening_a_database(self):
        for marker in (self.data/RESTORE_MARKER,_restore_guard(self.data)):
            with self.subTest(marker=marker.name):
                marker.write_text('incomplete')
                try:
                    before=(self.data/'runtime.sqlite3').read_bytes()
                    for command in ('show','events','stats','export'):
                        extra=(str(self.root/'must-not-export'),) if command=='export' else ()
                        status,_,error=self.invoke(command,extra=extra);self.assertEqual(status,1);self.assertIn('恢复尚未完成',error)
                    self.assertEqual((self.data/'runtime.sqlite3').read_bytes(),before);self.assertFalse((self.root/'must-not-export').exists())
                finally:marker.unlink()

    def test_invalid_or_incompatible_database_reports_an_error_without_repair(self):
        for label,raw in (('corrupt',b'not a sqlite database'),('empty',b'')):
            source=self.root/label;source.mkdir();database=source/'runtime.sqlite3';database.write_bytes(raw)
            status,_,error=self.invoke('show',data=source)
            self.assertEqual(status,1);self.assertIn('未执行初始化或修复',error);self.assertEqual(database.read_bytes(),raw)
            self.assertFalse((source/'mock-business.sqlite3').exists())

    def test_tenant_and_run_checks_precede_stats_or_export(self):
        target=self.root/'forbidden-export'
        for command in ('show','events','stats','export'):
            extra=(str(target),) if command=='export' else ()
            self.assertEqual(self.invoke(command,tenant='other-tenant',extra=extra)[0],1)
        self.assertFalse(target.exists())

    def test_stats_preserve_existing_counts_and_read_a_consistent_business_snapshot(self):
        tenant=self.run['tenant_id'];run_id=self.run['run_id'];source=self.data/'mock-business.sqlite3'
        with self.runtime.external.connect() as db:
            db.execute('INSERT INTO calls VALUES(?,?,?,?)',(tenant,run_id,'fixture.read',4))
            db.execute('INSERT INTO calls VALUES(?,?,?,?)',('other-tenant',run_id,'foreign.read',9))
            db.execute('INSERT INTO drafts VALUES(?,?,?,?)',(tenant,'project-demo',run_id+':report:one',json.dumps({'id':'draft-one'})))
        before=source.read_bytes();result=read_run(self.data,tenant,run_id,'stats')
        self.assertEqual(result,{'calls':{'fixture.read':4},'drafts':[{'id':'draft-one'}]});self.assertEqual(source.read_bytes(),before)

    def test_closed_rollback_journal_database_can_be_inspected_without_write_permissions(self):
        path=self.data/'runtime.sqlite3'
        with sqlite3.connect(path,factory=ClosingConnection) as db:db.execute('PRAGMA journal_mode=DELETE')
        path.chmod(0o400);self.data.chmod(0o500)
        try:
            self.assertEqual(self.invoke('show',extra=('--full',))[0],0)
            self.assertEqual(self.invoke('export',extra=(str(self.root/'read-only-source-export'),))[0],0)
        finally:self.data.chmod(0o700);path.chmod(0o600)

    def test_missing_columns_are_not_silently_reported_as_empty_optional_data(self):
        path=self.data/'runtime.sqlite3'
        with sqlite3.connect(path,factory=ClosingConnection) as db:
            db.execute('DROP TABLE native_reads');db.execute('CREATE TABLE native_reads(incompatible TEXT)')
        before=path.read_bytes();status,_,error=self.invoke('show',extra=('--full',))
        self.assertEqual(status,1);self.assertIn('未执行初始化或修复',error);self.assertEqual(path.read_bytes(),before)

    def test_empty_business_database_is_rejected_instead_of_initialized(self):
        path=self.data/'mock-business.sqlite3';path.write_bytes(b'')
        status,_,error=self.invoke('stats')
        self.assertEqual(status,1);self.assertIn('业务数据库缺少必需',error);self.assertEqual(path.read_bytes(),b'')

    def test_data_directory_interpretation_matches_existing_creation_commands(self):
        program='''import sys
from agent_framework.runtime import Runtime
from agent_framework.cli import main
data=sys.argv[1]
runtime=Runtime(data)
run=runtime.submit()
raise SystemExit(main(['--data-dir',data,'show',run['run_id']]))
'''
        data='~/'+self.root.name+'/literal-history'
        process=subprocess.run([sys.executable,'-c',program,data],cwd=self.root,env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1])},capture_output=True,text=True,timeout=10)
        self.assertEqual(process.returncode,0,process.stderr)
        self.assertTrue((self.root/data/'runtime.sqlite3').is_file())
