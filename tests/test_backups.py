"""Core-data backups preserve both sides of execution and never overwrite data."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

from agent_framework import backups
from agent_framework.backups import BackupError, create_backup, restore_backup, verify_backup
from agent_framework.cli import main
from agent_framework.contracts import TaskContract
from agent_framework.runtime import CrashInjected, Runtime
from agent_framework.store import ClosingConnection
from agent_framework.web import Application
from agent_framework.workspace_scheduler import WorkspaceScheduler
from tests.test_workflows import definition, role


def contents(path):
    with sqlite3.connect(path, factory=ClosingConnection) as db:
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {table: sorted(db.execute('SELECT * FROM "' + table.replace('"', '""') + '"').fetchall(), key=repr) for table in tables}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / '原始 工作台'
        self.app = Application(self.source, lease_seconds=.8, tool_timeout=.3)
        self.addCleanup(self.app.close)
        self.archive = self.root / '工作台 备份.zip'
        self.target = self.root / '恢复 工作台'

    def backup(self):
        return create_backup(self.source, self.archive)

    def entries(self):
        with zipfile.ZipFile(self.archive) as archive:
            return {name: archive.read(name) for name in archive.namelist()}

    def rewrite(self, entries, name='modified.zip'):
        target = self.root / name
        with zipfile.ZipFile(target, 'w') as archive:
            for filename, content in entries.items():
                archive.writestr(filename, content)
        return target

    def test_round_trip_preserves_all_core_tables_and_queued_workflow_executes_once(self):
        agent = role(self.app)
        library = self.app.library()
        document = library.create(self.app.library_access(), {'title': '备份资料', 'content': {'text': '需要保留的工作知识'}})
        library.transition(self.app.library_access(), document['ref'], 'REVIEW')
        library.transition(self.app.library_access(), document['ref'], 'PUBLISHED')
        workflow = self.app.workflows().save(definition([agent]))
        queued = self.app.workflows().start(workflow['id'], {'revision': 1, 'grant': True, 'request_id': 'keep-queue'})
        space = self.app.workspaces.save({'name': '第二工作空间', 'business': '测试', 'scenario': '备份', 'description': '', 'revision': 0})
        second_agent = role(self.app.scoped(space['id']), '第二空间岗位')
        other = Application(self.source, tenant='other-tenant', principal='other-owner')
        self.addCleanup(other.close)
        private_agent = role(other, '其他主体的岗位')
        before = {name: contents(self.source / name) for name in backups.DATABASES}
        self.backup()
        self.assertTrue(verify_backup(self.archive)['valid'])
        restore_backup(self.archive, self.target)
        for name in backups.DATABASES:
            self.assertEqual(contents(self.target / name), before[name])
        restored = Application(self.target, lease_seconds=.8, tool_timeout=.3)
        self.addCleanup(restored.close)
        self.assertEqual(restored.agents.get(agent['id']), self.app.agents.get(agent['id']))
        self.assertEqual(restored.scoped(space['id']).agents.get(second_agent['id'])['name'], '第二空间岗位')
        restored_other = Application(self.target, tenant='other-tenant', principal='other-owner')
        self.addCleanup(restored_other.close)
        self.assertEqual(restored_other.agents.get(private_agent['id'])['name'], '其他主体的岗位')
        self.assertEqual(restored.library().get(restored.library_access(), document['ref'])['content'], {'text': '需要保留的工作知识'})
        result = restored.workflows().execute(queued['id'])
        self.assertEqual(result['status'], 'SUCCEEDED')
        self.assertEqual(result['snapshot_hash'], queued['snapshot_hash'])
        stats = restored.runtime().external.stats(restored.tenant, result['nodes']['n0']['run_id'])
        self.assertEqual(len(stats['drafts']), 1)
        self.assertEqual(stats['calls']['report.draft.create@1.0.0'], 1)
        self.assertEqual(self.app.workflows().run(queued['id'])['status'], 'CREATED')

    def test_restored_daily_start_intent_recovers_the_same_run_once(self):
        agent=role(self.app);service=WorkspaceScheduler(self.app)
        service.save(dict(revision=0,enabled=False,timezone='Asia/Shanghai',daily_time='00:00',auto_start=True,
            tasks=[dict(agent_id=agent['id'],agent_revision=1,goal='恢复每日原任务',change_id='backup-daily',grant=True,consent=False,mcp_consent=False)]))
        self.app.jobs.update({'capacity-'+str(i):{'active':True,'cancel':threading.Event()} for i in range(16)})
        plan=service.dispatch(service.generate()['id']);run=plan['items'][0]['run_id']
        self.assertEqual(plan['dispatch']['state'],'PENDING');self.backup();restore_backup(self.archive,self.target)
        restored=Application(self.target,lease_seconds=.8,tool_timeout=.3);self.addCleanup(restored.close)
        from agent_framework.workspace_scheduler import tick
        tick(restored);deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            result=restored.detail(run)
            if result['run']['status']=='SUCCEEDED' and not result['job']['active']:break
            time.sleep(.02)
        self.assertEqual(restored.detail(run)['run']['status'],'SUCCEEDED')
        tick(restored)
        self.assertEqual(WorkspaceScheduler(restored).get(plan['id'])['dispatch']['state'],'COMPLETE')
        result=restored.detail(run);self.assertEqual(result['external']['calls']['report.draft.create@1.0.0'],1)
        self.assertEqual(len(result['external']['drafts']),1)
        self.assertEqual(restored.runs()['counts']['total'],1)
        self.assertEqual(self.app.detail(run)['run']['status'],'CREATED')

    def test_committed_wal_records_in_both_databases_are_included(self):
        opened = []
        try:
            for name in backups.DATABASES:
                db = sqlite3.connect(self.source / name)
                opened.append(db)
                db.execute('PRAGMA wal_autocheckpoint=0')
                db.execute('CREATE TABLE backup_probe(value TEXT)')
                db.execute('INSERT INTO backup_probe VALUES(?)', ('仅在 WAL 中的已提交内容 ' + name,))
                db.commit()
                self.assertGreater(Path(str(self.source / name) + '-wal').stat().st_size, 0)
            self.backup()
            restore_backup(self.archive, self.target)
            for name in backups.DATABASES:
                with sqlite3.connect(self.target / name, factory=ClosingConnection) as db:
                    self.assertEqual(db.execute('SELECT value FROM backup_probe').fetchone()[0], '仅在 WAL 中的已提交内容 ' + name)
            self.assertEqual(set(self.entries()), {'manifest.json', *backups.DATABASES})
        finally:
            for db in opened:
                db.close()

    def test_active_execution_refuses_backup_without_modifying_the_task(self):
        runtime = self.app.runtime()
        task = runtime.submit(TaskContract(principal=self.app.principal))
        lease = runtime.store.acquire(self.app.tenant, task['run_id'], 30)
        try:
            before = runtime.store.load(self.app.tenant, task['run_id'])
            with self.assertRaisesRegex(BackupError, '正在执行'):
                self.backup()
            self.assertFalse(self.archive.exists())
            self.assertEqual(runtime.store.load(self.app.tenant, task['run_id']), before)
        finally:
            runtime.store.release(task, lease)

    def test_busy_writer_returns_a_bounded_error_and_does_not_publish_partial_archive(self):
        with sqlite3.connect(self.source / 'runtime.sqlite3', factory=ClosingConnection) as writer:
            writer.execute('BEGIN IMMEDIATE')
            with self.assertRaisesRegex(BackupError, '正在写入'):
                create_backup(self.source, self.archive, timeout=.02)
        self.assertFalse(self.archive.exists())
        self.assertFalse(list(self.root.glob('.agent-backup-*.tmp')))

    def test_active_flow_or_daily_dispatch_also_defers_backup(self):
        workflow = self.app.workflows().save(definition([role(self.app)]))
        flow = self.app.workflows().start(workflow['id'], {'revision': 1})
        plan = WorkspaceScheduler(self.app).generate()
        for table, identity in (('workflow_runs', flow['id']), ('workspace_daily_plans', plan['id'])):
            with self.app.runtime().store.transaction() as db:
                db.execute('UPDATE ' + table + ' SET owner=?,lease_until=? WHERE id=?', ('working', time.time() + 30, identity))
            try:
                with self.subTest(table=table), self.assertRaisesRegex(BackupError, '正在执行'):
                    self.backup()
                self.assertFalse(self.archive.exists())
            finally:
                with self.app.runtime().store.transaction() as db:
                    db.execute('UPDATE ' + table + ' SET owner=NULL,lease_until=0 WHERE id=?', (identity,))

    def test_restore_clears_expired_process_leases_but_keeps_source_unchanged(self):
        task = self.app.runtime().submit(TaskContract(principal=self.app.principal))
        agent = role(self.app)
        workflow = self.app.workflows().save(definition([agent]))
        flow = self.app.workflows().start(workflow['id'], {'revision': 1})
        plan = WorkspaceScheduler(self.app).generate()
        with self.app.runtime().store.transaction() as db:
            db.execute('UPDATE runs SET owner=?,lease_until=?,epoch=7 WHERE id=?', ('old-process', time.time() - 1, task['run_id']))
            db.execute('UPDATE workflow_runs SET owner=?,lease_until=? WHERE id=?', ('old-process', time.time() - 1, flow['id']))
            db.execute('UPDATE workspace_daily_plans SET owner=?,lease_until=? WHERE id=?', ('old-process', time.time() - 1, plan['id']))
        self.backup()
        receipt = restore_backup(self.archive, self.target)
        self.assertEqual(receipt['leases_cleared'], {'runs': 1, 'workflow_runs': 1, 'workspace_daily_plans': 1, 'workflow_chat_requests': 0})
        with sqlite3.connect(self.target / 'runtime.sqlite3', factory=ClosingConnection) as db:
            self.assertEqual(db.execute('SELECT owner,lease_until,epoch FROM runs WHERE id=?', (task['run_id'],)).fetchone(), (None, 0, 8))
        with self.app.runtime().store.connect() as db:
            self.assertEqual(db.execute('SELECT owner,epoch FROM runs WHERE id=?', (task['run_id'],)).fetchone()['owner'], 'old-process')

    def test_restored_unknown_write_reconciles_original_draft_without_recreating_it(self):
        runtime = self.app.runtime()
        task = runtime.submit(TaskContract(principal=self.app.principal), scenario='crash-after-write')
        with self.assertRaises(CrashInjected):
            runtime.run(task['run_id'])
        frozen = runtime.store.load(self.app.tenant, task['run_id'])['snapshot']
        with runtime.store.transaction() as db:
            db.execute('UPDATE runs SET lease_until=? WHERE id=?', (time.time() - 1, task['run_id']))
        self.backup()
        restore_backup(self.archive, self.target)
        restored = Runtime(self.target, lease_seconds=.8, tool_timeout=.3)
        result = restored.run(task['run_id'])
        self.assertEqual(result['status'], 'SUCCEEDED')
        self.assertEqual(result['snapshot'], frozen)
        stats = restored.external.stats(self.app.tenant, task['run_id'])
        self.assertEqual(len(stats['drafts']), 1)
        self.assertEqual(stats['calls']['report.draft.create@1.0.0'], 1)

    def test_backup_excludes_logs_subdirectories_and_login_files_and_has_private_permissions(self):
        (self.source / 'auth.json').write_text('DO_NOT_COPY_CREDENTIAL')
        (self.source / 'web.log').write_text('DO_NOT_COPY_LOG')
        (self.source / 'test-data').mkdir()
        (self.source / 'test-data' / 'private.txt').write_text('DO_NOT_COPY_NESTED')
        self.backup()
        entries = self.entries()
        self.assertEqual(set(entries), {'manifest.json', *backups.DATABASES})
        self.assertNotIn(b'DO_NOT_COPY', b''.join(entries.values()))
        self.assertEqual(self.archive.stat().st_mode & 0o077, 0)
        restore_backup(self.archive, self.target)
        self.assertEqual(self.target.stat().st_mode & 0o077, 0)
        for path in self.target.iterdir():
            self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_invalid_archives_never_create_destination(self):
        self.backup()
        original = self.entries()
        cases = {}
        changed = dict(original)
        changed['runtime.sqlite3'] = changed['runtime.sqlite3'][:-1] + b'X'
        cases['checksum'] = changed
        cases['extra-path'] = {**original, '../outside': b'unsafe'}
        cases['missing-pair'] = {key: value for key, value in original.items() if key != 'mock-business.sqlite3'}
        for name, change in (('future-format', {'format_version': 2}), ('future-application', {'application_version': '999.0.0'}),
                             ('too-large', {'files': {**json.loads(original['manifest.json'])['files'], 'runtime.sqlite3': {'size': backups.MAX_DATABASE_BYTES + 1, 'sha256': '0' * 64}}})):
            value = json.loads(original['manifest.json'])
            value.update(change)
            cases[name] = {**original, 'manifest.json': json.dumps(value).encode()}
        for name, entries in cases.items():
            with self.subTest(name=name), self.assertRaises(BackupError):
                restore_backup(self.rewrite(entries, name + '.zip'), self.target)
            self.assertFalse(self.target.exists())
        self.assertFalse((self.root / 'outside').exists())

    def test_valid_checksum_does_not_hide_invalid_database_or_unsafe_schema(self):
        self.backup()
        for mode in ('invalid-sqlite', 'missing-table', 'trigger'):
            entries = self.entries()
            path = self.root / (mode + '.sqlite3')
            path.write_bytes(entries['runtime.sqlite3'])
            if mode == 'invalid-sqlite':
                path.write_bytes(b'not a database')
            else:
                with sqlite3.connect(path, factory=ClosingConnection) as db:
                    db.execute('DROP TABLE runs' if mode == 'missing-table' else 'CREATE TRIGGER forbidden AFTER INSERT ON runs BEGIN DELETE FROM events; END')
            content = path.read_bytes()
            value = json.loads(entries['manifest.json'])
            value['files']['runtime.sqlite3'] = {'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
            entries.update({'runtime.sqlite3': content, 'manifest.json': json.dumps(value).encode()})
            with self.subTest(mode=mode), self.assertRaises(BackupError):
                restore_backup(self.rewrite(entries, mode + '.zip'), self.target)
            self.assertFalse(self.target.exists())

    def test_existing_targets_and_publish_race_never_overwrite_files(self):
        self.archive.write_text('existing backup')
        with self.assertRaises(BackupError):
            self.backup()
        self.assertEqual(self.archive.read_text(), 'existing backup')
        self.archive.unlink()
        publish = backups.os.link
        def raced(source, destination):
            Path(destination).write_text('created by another writer')
            return publish(source, destination)
        with patch.object(backups.os, 'link', side_effect=raced), self.assertRaises(BackupError):
            self.backup()
        self.assertEqual(self.archive.read_text(), 'created by another writer')
        self.archive.unlink()
        self.backup()
        self.target.mkdir()
        (self.target / 'keep.txt').write_text('keep existing data')
        with self.assertRaises(BackupError):
            restore_backup(self.archive, self.target)
        self.assertEqual((self.target / 'keep.txt').read_text(), 'keep existing data')

    def test_failed_restore_cleans_its_partial_files_and_preserves_source(self):
        self.backup()
        copy = backups.shutil.copyfileobj
        calls = 0
        def fail(source, target, length):
            nonlocal calls
            calls += 1
            if calls == 2:
                target.write(b'partial file')
                raise OSError('disk full')
            return copy(source, target, length)
        with patch.object(backups.shutil, 'copyfileobj', side_effect=fail), self.assertRaisesRegex(OSError, 'disk full'):
            restore_backup(self.archive, self.target)
        self.assertFalse(self.target.exists())
        self.assertTrue(verify_backup(self.archive)['valid'])

    def test_process_loss_during_restore_cannot_start_a_partial_workspace(self):
        self.backup()
        program = '''import os,sys
from agent_framework import backups
def crash(source,target,length):
    target.write(b'PARTIAL RESTORE')
    target.flush()
    os._exit(75)
backups.shutil.copyfileobj=crash
backups.restore_backup(sys.argv[1],sys.argv[2])
'''
        crashed = subprocess.run([sys.executable, '-c', program, str(self.archive), str(self.target)], capture_output=True, text=True)
        self.assertEqual(crashed.returncode, 75, crashed.stderr)
        self.assertTrue((self.target / backups.RESTORE_MARKER).exists())
        with self.assertRaisesRegex(ValueError, '数据恢复尚未完成'):
            Runtime(self.target)
        self.assertFalse((self.target / 'mock-business.sqlite3').exists())
        with self.assertRaises(BackupError):
            restore_backup(self.archive, self.target)
        before_mkdir = self.root / 'crashed-before-mkdir'
        program = '''import os,sys
from pathlib import Path
from agent_framework import backups
mkdir=Path.mkdir
def crash(path,*args,**kwargs):
    if path==Path(sys.argv[2]):
        os._exit(75)
    return mkdir(path,*args,**kwargs)
Path.mkdir=crash
backups.restore_backup(sys.argv[1],sys.argv[2])
'''
        crashed = subprocess.run([sys.executable, '-c', program, str(self.archive), str(before_mkdir)], capture_output=True, text=True)
        self.assertEqual(crashed.returncode, 75, crashed.stderr)
        self.assertFalse(before_mkdir.exists())
        with self.assertRaisesRegex(ValueError, '数据恢复尚未完成'):
            Runtime(before_mkdir)
        self.assertFalse(before_mkdir.exists())
        fresh = self.root / 'complete-restoration'
        restore_backup(self.archive, fresh)
        self.assertFalse((fresh / backups.RESTORE_MARKER).exists())
        Runtime(fresh)

    def test_missing_source_is_not_silently_initialized(self):
        absent = self.root / 'missing'
        with self.assertRaises(BackupError):
            create_backup(absent, self.archive)
        self.assertFalse(absent.exists())
        self.assertFalse(self.archive.exists())

    def test_worker_initialization_busy_error_releases_capacity_and_can_resume(self):
        task = self.app.runtime().submit(TaskContract(principal=self.app.principal))
        identity = task['run_id']
        factory = self.app.runtime
        failed = False
        def busy_once(*args, **kwargs):
            nonlocal failed
            if not failed and threading.current_thread().name.startswith('agent-web'):
                failed = True
                raise sqlite3.OperationalError('database is locked')
            return factory(*args, **kwargs)
        with patch.object(self.app, 'runtime', side_effect=busy_once):
            self.app.schedule(identity)
            deadline=time.monotonic()+5
            while self.app.jobs[identity]['active'] and time.monotonic()<deadline:time.sleep(.01)
        job=self.app.jobs[identity]
        self.assertFalse(job['active'])
        self.assertEqual(job['state'], 'ERROR')
        self.assertIn('ended_at', job)
        self.app.schedule(identity)
        deadline = time.monotonic() + 5
        while (self.app.job(identity) or {}).get('active') and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(self.app.runtime().store.load(self.app.tenant, identity)['status'], 'SUCCEEDED')

    def test_cli_backup_verify_restore_and_failure_have_no_model_or_default_data_side_effects(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(main(['--data-dir', str(self.source), 'backup', str(self.archive)]), 0)
        self.assertTrue(json.loads(stdout.getvalue())['valid'])
        command = [sys.executable, '-m', 'agent_framework']
        root = str(Path(__file__).resolve().parents[1])
        environment = {**os.environ, 'PYTHONPATH': root}
        verified = subprocess.run([*command, 'verify-backup', str(self.archive)], cwd=self.root, env=environment, capture_output=True, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertTrue(json.loads(verified.stdout)['valid'])
        self.assertFalse((self.root / '.agent-data').exists())
        restored = subprocess.run([*command, 'restore-backup', str(self.archive), str(self.target)], cwd=self.root, env=environment, capture_output=True, text=True)
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(json.loads(restored.stdout)['directory'], str(self.target))
        rejected = subprocess.run([*command, 'restore-backup', str(self.archive), str(self.target)], cwd=self.root, env=environment, capture_output=True, text=True)
        self.assertEqual(rejected.returncode, 1)
        self.assertNotIn('Traceback', rejected.stderr)
        self.assertIn('不会覆盖', rejected.stderr)
        invalid = self.root / 'invalid.zip'
        invalid.write_bytes(b'not a ZIP backup')
        rejected = subprocess.run([*command, 'verify-backup', str(invalid)], cwd=self.root, env=environment, capture_output=True, text=True)
        self.assertEqual(rejected.returncode, 1)
        self.assertIn('备份损坏', rejected.stderr)
        self.assertNotIn('Traceback', rejected.stderr)


if __name__ == '__main__':
    unittest.main()
