"""Backup publication and restore completion must survive failed namespace syncs."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from agent_framework import backups
from agent_framework.cli import main
from agent_framework.inspection import read_run
from agent_framework.runtime import Runtime
from agent_framework.store import ClosingConnection
from agent_framework.web import Application


def sync_phase(path, target):
    path = Path(path)
    guard = backups._restore_guard(target)
    if path == target.parent:
        if not target.exists():
            return 'guard-entry' if guard.exists() else 'rollback'
        return 'destination-entry' if guard.exists() else 'guard-removal'
    if path == target:
        if not (target / backups.RESTORE_MARKER).exists():
            return 'marker-removal'
        return 'data-entries' if (target / 'restore-receipt.json').exists() else 'marker-entry'
    return 'other'


PHASES = ('guard-entry', 'marker-entry', 'data-entries', 'destination-entry', 'marker-removal', 'guard-removal')


class BackupDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / 'source'
        self.archive = self.root / 'backup.zip'
        self.target = self.root / 'restored'
        app = Application(self.source)
        app.close()
        for name in backups.DATABASES:
            with sqlite3.connect(self.source / name, factory=ClosingConnection) as db:
                db.execute('CREATE TABLE durability_probe(value TEXT)')
                db.execute('INSERT INTO durability_probe VALUES(?)', (name,))

    def assert_pair(self, directory):
        for name in backups.DATABASES:
            self.assertTrue((directory / name).is_file(), name)
            with sqlite3.connect((directory / name).as_uri() + '?mode=ro', uri=True, factory=ClosingConnection) as db:
                self.assertEqual(db.execute('SELECT value FROM durability_probe').fetchone()[0], name)
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])

    def test_backup_syncs_published_archive_directory_before_success(self):
        sync = os.fsync
        synced = []
        def observe(fd):
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                synced.append((info.st_dev, info.st_ino, self.archive.exists()))
            return sync(fd)
        with patch.object(backups.os, 'fsync', side_effect=observe):
            backups.create_backup(self.source, self.archive)
        info = self.root.stat()
        self.assertIn((info.st_dev, info.st_ino, True), synced)
        self.assertTrue(backups.verify_backup(self.archive)['valid'])

    def test_completed_pair_is_not_deleted_after_final_guard_removal_error(self):
        backups.create_backup(self.source, self.archive)
        guard = backups._restore_guard(self.target)
        unlink = Path.unlink
        def remove_then_fail(path, *args, **kwargs):
            result = unlink(path, *args, **kwargs)
            if path == guard:
                raise OSError('injected error after guard removal')
            return result
        with patch.object(Path, 'unlink', remove_then_fail), self.assertRaisesRegex(OSError, 'after guard removal'):
            backups.restore_backup(self.archive, self.target)
        self.assert_pair(self.target)
        self.assertTrue((self.target / 'restore-receipt.json').is_file())
        self.assert_pair(self.source)

    def assert_blocked(self, target):
        self.assertTrue(backups.restore_incomplete(target))
        with self.assertRaisesRegex(ValueError, '数据恢复尚未完成'):
            Runtime(target)
        with self.assertRaisesRegex(ValueError, '数据恢复尚未完成'):
            read_run(target, 'test', 'absent', 'show')

    def test_guard_is_durable_before_mkdir_and_all_data_before_guard_retirement(self):
        backups.create_backup(self.source, self.archive)
        sync, mkdir, unlink = os.fsync, Path.mkdir, Path.unlink
        guard = backups._restore_guard(self.target)
        file_syncs, directory_states = set(), []
        def observe_sync(fd):
            info = os.fstat(fd)
            if stat.S_ISDIR(info.st_mode):
                directory_states.append(sync_phase(self.root if info.st_ino == self.root.stat().st_ino else self.target, self.target))
            else:
                for path in [guard, *(self.target / name for name in (*backups.DATABASES, 'restore-receipt.json'))]:
                    if path.exists() and path.stat().st_ino == info.st_ino:
                        file_syncs.add(path.name)
            return sync(fd)
        def checked_mkdir(path, *args, **kwargs):
            if path == self.target:
                self.assertIn(guard.name, file_syncs)
                self.assertIn('guard-entry', directory_states)
            return mkdir(path, *args, **kwargs)
        def checked_unlink(path, *args, **kwargs):
            if path == self.target / backups.RESTORE_MARKER:
                self.assertTrue({*backups.DATABASES, 'restore-receipt.json'} <= file_syncs)
                self.assertIn('data-entries', directory_states)
                self.assertEqual(directory_states[-1], 'destination-entry')
            if path == guard:
                self.assertEqual(directory_states[-1], 'marker-removal')
            return unlink(path, *args, **kwargs)
        with patch.object(backups.os, 'fsync', side_effect=observe_sync), patch.object(Path, 'mkdir', checked_mkdir), patch.object(Path, 'unlink', checked_unlink):
            result = backups.restore_backup(self.archive, self.target)
        self.assertTrue(result['valid'])
        self.assertEqual(directory_states, list(PHASES))
        self.assert_pair(self.target)

    def test_directory_sync_failure_at_every_boundary_never_reports_success_or_loses_source(self):
        backups.create_backup(self.source, self.archive)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        sync = backups._sync_directory
        for phase in PHASES:
            target = self.root / ('failed-' + phase)
            failed = False
            def fail_once(path):
                nonlocal failed
                if not failed and sync_phase(path, target) == phase:
                    failed = True
                    raise OSError('injected sync failure: ' + phase)
                return sync(path)
            with self.subTest(phase=phase), patch.object(backups, '_sync_directory', side_effect=fail_once):
                with self.assertRaisesRegex(OSError, 'injected sync failure'):
                    backups.restore_backup(self.archive, target)
                self.assertTrue(failed)
            if phase in ('marker-removal', 'guard-removal'):
                self.assert_pair(target)
                if phase == 'marker-removal':
                    self.assert_blocked(target)
                else:
                    self.assertFalse(backups.restore_incomplete(target))
                    Runtime(target)
            else:
                self.assertFalse(target.exists())
                self.assertFalse(backups.restore_incomplete(target))
            self.assert_pair(self.source)
            self.assertEqual(hashlib.sha256(self.archive.read_bytes()).hexdigest(), digest)

    def test_failed_backup_directory_sync_keeps_verifiable_file_and_cli_reports_uncertainty(self):
        sync = backups._sync_directory
        def fail_published(path):
            if self.archive.exists():
                raise OSError('injected directory sync failure')
            return sync(path)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(backups, '_sync_directory', side_effect=fail_published), redirect_stdout(stdout), redirect_stderr(stderr):
            result = main(['--data-dir', str(self.source), 'backup', str(self.archive)])
        self.assertEqual(result, 1)
        self.assertEqual(stdout.getvalue(), '')
        self.assertIn('未能确认发布完成', stderr.getvalue())
        self.assertIn(str(self.archive), stderr.getvalue())
        self.assertTrue(backups.verify_backup(self.archive)['valid'])
        self.assertFalse(list(self.root.glob('.agent-backup-*.tmp')))
        with self.assertRaisesRegex(backups.BackupError, '不会覆盖'):
            backups.create_backup(self.source, self.archive)

    def test_unsupported_directory_sync_refuses_backup_before_creating_files(self):
        with patch.object(backups, '_sync_directory', side_effect=OSError('unsupported sync')):
            with self.assertRaisesRegex(OSError, 'unsupported sync'):
                backups.create_backup(self.source, self.archive)
        self.assertFalse(self.archive.exists())
        self.assertFalse(list(self.root.glob('.agent-backup-*.tmp')))
        self.assert_pair(self.source)

    def test_rollback_sync_failure_keeps_guard_and_original_copy_error(self):
        backups.create_backup(self.source, self.archive)
        sync = backups._sync_directory
        copying = False
        def fail_copy(source, target, length):
            nonlocal copying
            copying = True
            target.write(b'partial data')
            raise OSError('injected disk full')
        def fail_rollback_sync(path):
            if copying:
                raise OSError('injected rollback sync failure')
            return sync(path)
        with patch.object(backups.shutil, 'copyfileobj', side_effect=fail_copy), patch.object(backups, '_sync_directory', side_effect=fail_rollback_sync):
            with self.assertRaisesRegex(OSError, 'injected disk full'):
                backups.restore_backup(self.archive, self.target)
        self.assert_blocked(self.target)
        self.assert_pair(self.source)

    def test_rollback_does_not_remove_unrelated_files_or_unprotect_the_directory(self):
        backups.create_backup(self.source, self.archive)
        def fail_copy(source, target, length):
            (self.target / 'keep.txt').write_text('created by another writer')
            target.write(b'partial data')
            raise OSError('injected copy failure')
        with patch.object(backups.shutil, 'copyfileobj', side_effect=fail_copy), self.assertRaisesRegex(OSError, 'copy failure'):
            backups.restore_backup(self.archive, self.target)
        self.assertEqual((self.target / 'keep.txt').read_text(), 'created by another writer')
        self.assert_blocked(self.target)
        self.assert_pair(self.source)

    def test_rollback_syncs_partial_file_removal_before_retiring_the_guard(self):
        backups.create_backup(self.source, self.archive)
        sync, unlink = backups._sync_directory, Path.unlink
        removed_directory_synced = False
        guard = backups._restore_guard(self.target)
        def observe_sync(path):
            nonlocal removed_directory_synced
            if Path(path) == self.root and not self.target.exists() and guard.exists():
                removed_directory_synced = removed_directory_synced or (guard.stat().st_ino in removed_guards)
            return sync(path)
        removed_guards = set()
        def fail_copy(source, target, length):
            removed_guards.add(guard.stat().st_ino)
            raise OSError('injected copy failure')
        def checked_unlink(path, *args, **kwargs):
            if path == guard:
                self.assertTrue(removed_directory_synced)
                self.assertFalse(self.target.exists())
            return unlink(path, *args, **kwargs)
        with patch.object(backups.shutil, 'copyfileobj', side_effect=fail_copy), patch.object(backups, '_sync_directory', side_effect=observe_sync), patch.object(Path, 'unlink', checked_unlink):
            with self.assertRaisesRegex(OSError, 'copy failure'):
                backups.restore_backup(self.archive, self.target)
        self.assertFalse(backups.restore_incomplete(self.target))

    def test_process_exit_after_each_directory_barrier_leaves_guard_or_complete_pair(self):
        backups.create_backup(self.source, self.archive)
        program = '''import os,sys
from pathlib import Path
from agent_framework import backups
from tests.test_backup_durability import sync_phase
target=Path(sys.argv[2]);phase=sys.argv[3];sync=backups._sync_directory
def crash(path):
    sync(path)
    if sync_phase(path,target)==phase:os._exit(76)
backups._sync_directory=crash
backups.restore_backup(sys.argv[1],target)
'''
        for phase in PHASES:
            target = self.root / ('crash-' + phase)
            with self.subTest(phase=phase):
                result = subprocess.run([sys.executable, '-c', program, str(self.archive), str(target), phase], capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 76, result.stderr)
                if phase == 'guard-removal':
                    self.assertFalse(backups.restore_incomplete(target))
                    self.assert_pair(target)
                    Runtime(target)
                else:
                    self.assert_blocked(target)
        fresh = self.root / 'fresh-after-crashes'
        backups.restore_backup(self.archive, fresh)
        self.assert_pair(fresh)
        self.assert_pair(self.source)


if __name__ == '__main__':
    unittest.main()
