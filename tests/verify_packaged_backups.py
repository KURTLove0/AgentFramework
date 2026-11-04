"""Exercise backup and export CLI commands from an isolated local wheel installation.

The caller's Python supplies dependencies; this is not a fresh-environment
dependency-resolution test. No network, live workspace or model is used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(wheel):
    wheel = wheel.resolve()
    with tempfile.TemporaryDirectory(prefix='packaged backup ') as directory:
        root = Path(directory).resolve()
        installed = root / 'installed'
        subprocess.run([sys.executable, '-I', '-m', 'pip', 'install', '--no-index', '--no-deps',
                        '--disable-pip-version-check', '--target', str(installed), str(wheel)],
                       cwd=root, capture_output=True, text=True, check=True, timeout=45)
        prefix = '''import sys
from pathlib import Path
sys.path.insert(0,sys.argv.pop(1))
import agent_framework
assert Path(agent_framework.__file__).resolve().is_relative_to(Path(sys.path[0]))
'''
        def python(code, *args, expected=0):
            result = subprocess.run([sys.executable, '-I', '-c', prefix + code, str(installed), *map(str, args)],
                                    cwd=root, capture_output=True, text=True, timeout=20)
            if result.returncode != expected:
                raise AssertionError(result.stdout + result.stderr)
            return result
        def cli(*args, expected=0):
            return python('from agent_framework.cli import main\nraise SystemExit(main(sys.argv[1:]))', *args, expected=expected)
        source, target, archive = root / '原始 数据', root / '恢复 数据', root / '备份 文件.zip'
        init = python('''import json,sqlite3
from agent_framework.runtime import Runtime
from agent_framework.contracts import TaskContract
from agent_framework.store import ClosingConnection
runtime=Runtime(sys.argv[1]);task=runtime.submit(TaskContract(principal='backup-user'))
for name in ('runtime.sqlite3','mock-business.sqlite3'):
 with sqlite3.connect(Path(sys.argv[1])/name,factory=ClosingConnection) as db:
  db.execute('CREATE TABLE packaged_backup_probe(value TEXT)')
  db.execute('INSERT INTO packaged_backup_probe VALUES(?)',(name,))
print(json.dumps({'run_id':task['run_id'],'tenant':task['tenant_id']}))
''', source)
        task = json.loads(init.stdout)
        before = {name: digest(source / name) for name in ('runtime.sqlite3', 'mock-business.sqlite3')}
        created = json.loads(cli('--data-dir', source, 'backup', archive).stdout)
        checked = json.loads(cli('verify-backup', archive).stdout)
        restored = json.loads(cli('restore-backup', archive, target).stdout)
        assert created['valid'] and checked['valid'] and restored['valid']
        assert before == {name: digest(source / name) for name in before}
        python('''import sqlite3
from agent_framework.runtime import Runtime
from agent_framework.backups import restore_incomplete
from agent_framework.store import ClosingConnection
assert not restore_incomplete(sys.argv[1])
Runtime(sys.argv[1])
for name in ('runtime.sqlite3','mock-business.sqlite3'):
 with sqlite3.connect(Path(sys.argv[1])/name,factory=ClosingConnection) as db:
  assert db.execute('SELECT value FROM packaged_backup_probe').fetchone()[0]==name
  assert db.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
''', target)
        shown = json.loads(cli('--data-dir', target, '--tenant', task['tenant'], 'show', task['run_id']).stdout)
        assert shown['run_id'] == task['run_id'] and shown['status'] == 'CREATED'
        exported = root / '任务 导出'
        cli('--data-dir', target, '--tenant', task['tenant'], 'export', task['run_id'], exported)
        export_manifest = json.loads(cli('verify-export', exported).stdout)['manifest']
        assert export_manifest['snapshot']['run_id'] == task['run_id']
        export_before = {path.name: digest(path) for path in exported.iterdir()}
        rejected_export = cli('--data-dir', target, '--tenant', task['tenant'], 'export', task['run_id'], exported, expected=1)
        assert '导出目录已存在' in rejected_export.stderr
        assert export_before == {path.name: digest(path) for path in exported.iterdir()}
        export_zip = root / 'export.zip'
        with zipfile.ZipFile(export_zip, 'w', compression=zipfile.ZIP_DEFLATED) as archive_file:
            for path in exported.iterdir():
                archive_file.write(path, path.name)
        assert json.loads(cli('verify-export', export_zip).stdout)['manifest'] == export_manifest
        with zipfile.ZipFile(export_zip) as archive_file:
            offset = archive_file.getinfo('result.json').header_offset
        raw = bytearray(export_zip.read_bytes())
        payload = offset + 30 + int.from_bytes(raw[offset + 26:offset + 28], 'little') + int.from_bytes(raw[offset + 28:offset + 30], 'little')
        raw[payload] = 7
        export_zip.write_bytes(raw)
        corrupted = cli('verify-export', export_zip, expected=1)
        assert '无法读取导出 ZIP' in corrupted.stderr and 'Traceback' not in corrupted.stderr
        existing = {name: digest(target / name) for name in before}
        rejected = cli('restore-backup', archive, target, expected=1)
        assert '不会覆盖' in rejected.stderr
        assert existing == {name: digest(target / name) for name in before}
        assert not (root / '.agent-data').exists()
        return {'artifact': str(wheel), 'artifact_sha256': digest(wheel), 'isolated_target_install': True,
                'fresh_environment': False, 'network_used': False, 'source_unchanged': True,
                'backup_verify_restore_cli': True, 'restored_pair_integrity': True,
                'restored_runtime_startup': True, 'historical_task_preserved': True,
                'existing_target_rejected': True, 'unrelated_default_data_created': False,
                'export_directory_and_zip_verified': True, 'export_existing_target_rejected': True,
                'corrupt_zip_controlled_error': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wheel', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        raise FileExistsError(args.report)
    result = verify(args.wheel)
    with args.report.open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
