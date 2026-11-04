"""Paired SQLite snapshots and verified, non-overwriting maintenance restores."""
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile

from . import __version__
from .file_durability import sync_directory as _sync_directory
from .store import ClosingConnection
from .structured import parse_json


DATABASES = ('runtime.sqlite3', 'mock-business.sqlite3')
FORMAT = 'agent-framework-core-data'
RESTORE_MARKER = '.restore-in-progress'
MAX_DATABASE_BYTES = 512 * 1024 * 1024
MAX_MANIFEST_BYTES = 16384
WORKSPACE_PREVIEW_LIMIT = 100
CHUNK = 1024 * 1024
LEASE_TABLES = ('runs', 'workflow_runs', 'workspace_daily_plans')
ASSET_SEARCH_SCHEMA = 'createvirtualtableasset_searchusingfts5(tenantunindexed,idunindexed,versionunindexed,terms)'
REQUIRED = {
    'runtime.sqlite3': {'runs': {'tenant_id', 'id', 'state', 'owner', 'epoch', 'lease_until'},
                       'events': {'tenant_id', 'run_id', 'seq', 'kind', 'data'},
                       'actions': {'tenant_id', 'run_id', 'logical_id', 'status', 'data'},
                       'outbox': {'tenant_id', 'run_id', 'logical_id', 'status'}},
    'mock-business.sqlite3': {'changes': {'tenant', 'project', 'id', 'data'},
                             'drafts': {'tenant', 'project', 'key', 'data'},
                             'calls': {'tenant', 'run', 'tool', 'count'}},
}


class BackupError(ValueError):
    pass


def _utc():
    return datetime.now(timezone.utc).isoformat()


def _sha256(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as source:
        while block := source.read(CHUNK):
            value.update(block)
    return value.hexdigest()


def _restore_guard(directory):
    directory = Path(directory).resolve()
    identity = hashlib.sha256(str(directory).encode('utf-8')).hexdigest()
    return directory.parent / ('.agent-restore-' + identity + '.in-progress')


def restore_incomplete(directory):
    directory = Path(directory).resolve()
    return any(path.exists() or path.is_symlink() for path in (directory / RESTORE_MARKER, _restore_guard(directory)))


def _connect(path, mode='ro', timeout=2):
    connection = sqlite3.connect(Path(path).as_uri() + '?mode=' + mode, uri=True, timeout=timeout, factory=ClosingConnection)
    connection.execute('PRAGMA trusted_schema=OFF')
    return connection


def _check_database(path, name):
    with _connect(path) as db:
        result = db.execute('PRAGMA integrity_check').fetchall()
        if result != [('ok',)]:
            raise BackupError(name + ' 完整性检查未通过')
        structures = db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
        for kind, table, sql in structures:
            virtual = bool(re.match(r'CREATE\s+VIRTUAL\s+TABLE', sql or '', re.I))
            known_search = (name == 'runtime.sqlite3' and table == 'asset_search'
                            and re.sub(r'\s+', '', sql or '').lower() == ASSET_SEARCH_SCHEMA)
            if kind in ('trigger', 'view') or (virtual and not known_search):
                raise BackupError(name + ' 包含不支持的数据库结构')
        tables = {table for kind, table, _ in structures if kind == 'table'}
        required_tables = dict(REQUIRED[name])
        if name == 'runtime.sqlite3':
            required_tables.update({table: {'owner', 'lease_until'} for table in LEASE_TABLES[1:] if table in tables})
            if 'workflow_chat_requests' in tables:required_tables['workflow_chat_requests']={'owner','lease_until','state'}
            if 'learning_proposals' in tables:required_tables['learning_proposals']={'status','data'}
        for table, required in required_tables.items():
            if table not in tables:
                raise BackupError(name + ' 缺少必需的数据表：' + table)
            columns = {row[1] for row in db.execute('PRAGMA table_info(' + table + ')')}
            if not required <= columns:
                raise BackupError(name + ' 数据结构不兼容：' + table)


def _ensure_idle(db):
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'learning_proposals' in tables:
        from .learning_generation import DEADLINE_SQL
        if db.execute("SELECT 1 FROM learning_proposals WHERE status='GENERATING' AND "+DEADLINE_SQL+">? LIMIT 1",(time.time(),)).fetchone():
            raise BackupError('仍有复盘或本体正在生成，请等待结束后备份')
    if 'workflow_chat_requests' in tables and db.execute("SELECT 1 FROM workflow_chat_requests WHERE state='RUNNING' AND lease_until>? LIMIT 1",(time.time(),)).fetchone():
        raise BackupError('仍有流程设计请求正在处理，请等待结束后备份')
    for table in LEASE_TABLES:
        if table in tables and db.execute('SELECT 1 FROM ' + table + ' WHERE owner IS NOT NULL AND lease_until>? LIMIT 1', (time.time(),)).fetchone():
            raise BackupError('仍有任务或流程正在执行，请等待结束后备份')


@contextmanager
def _snapshots(data_dir, timeout):
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 30:
        raise BackupError('备份等待时间须为 0–30 秒之间的正数')
    root = Path(data_dir).expanduser().resolve()
    if restore_incomplete(root):
        raise BackupError('数据恢复尚未完成，请先将备份恢复到新的目录')
    for name in DATABASES:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise BackupError('数据目录须包含两个完整的普通数据库文件，缺少：' + name)
        if path.stat().st_size > MAX_DATABASE_BYTES:
            raise BackupError('单个数据库超过备份大小上限（512 MiB）')
    with tempfile.TemporaryDirectory(prefix='agent-backup-snapshot-') as temporary:
        staging = Path(temporary)
        try:
            with ExitStack() as guards:
                connections = []
                for name in DATABASES:
                    connection = _connect(root / name, 'rw', timeout)
                    guards.callback(connection.close)
                    connection.execute('BEGIN IMMEDIATE')
                    connections.append(connection)
                _ensure_idle(connections[0])
                # Holding both write reservations gives the two copies one common
                # durable state, including committed WAL records and in-flight intents.
                for name in DATABASES:
                    target = staging / name
                    with target.open('xb'):
                        os.chmod(target, 0o600)
                    with _connect(root / name) as source, sqlite3.connect(target, factory=ClosingConnection) as copy:
                        source.backup(copy)
                        copy.execute('PRAGMA journal_mode=DELETE')
                # Closing the reservation connections rolls back the empty guards.
            for name in DATABASES:
                if (staging / name).stat().st_size > MAX_DATABASE_BYTES:
                    raise BackupError('单个数据库超过备份大小上限（512 MiB）')
                _check_database(staging / name, name)
        except sqlite3.Error as exc:
            raise BackupError('数据库不可用或正在写入，请稍后重试或停止服务后备份') from exc
        yield staging


def _new_target(path):
    requested = Path(path).expanduser().absolute()
    if os.path.lexists(requested):
        raise BackupError('目标已存在，不会覆盖：' + str(requested))
    target = requested.resolve()
    if not target.parent.is_dir():
        raise BackupError('目标的上级目录不存在：' + str(target.parent))
    return target


def create_backup(data_dir, destination, *, timeout=2):
    destination = _new_target(destination)
    _sync_directory(destination.parent)
    with _snapshots(data_dir, timeout) as staging:
        manifest = {'format': FORMAT, 'format_version': 1, 'application_version': __version__,
                    'created_at': _utc(), 'files': {name: {'size': (staging / name).stat().st_size,
                                                         'sha256': _sha256(staging / name)} for name in DATABASES}}
        with tempfile.NamedTemporaryFile(prefix='.agent-backup-', suffix='.tmp', dir=destination.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
        published = False
        try:
            with zipfile.ZipFile(temporary_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
                for name in DATABASES:
                    archive.write(staging / name, name)
            verify_backup(temporary_path)
            with temporary_path.open('rb') as completed:
                os.fsync(completed.fileno())
            # An exclusive hard link publishes the finished archive without a
            # check/replace race that could overwrite somebody else's file.
            os.link(temporary_path, destination)
            published = True
            temporary_path.unlink()
            _sync_directory(destination.parent)
        except FileExistsError as exc:
            raise BackupError('目标已存在，不会覆盖：' + str(destination)) from exc
        except OSError as exc:
            if published:
                raise BackupError('备份文件已生成，但未能确认发布完成；请校验现有文件，并使用新文件名重试：' + str(destination)) from exc
            raise
        finally:
            temporary_path.unlink(missing_ok=True)
    return {'backup': str(destination), 'valid': True, 'scope': 'all-local-core-data', **manifest}


def _manifest(value):
    fields = {'format', 'format_version', 'application_version', 'created_at', 'files'}
    if not isinstance(value, dict) or set(value) != fields or value['format'] != FORMAT:
        raise BackupError('文件不是受支持的 Agent Framework 核心数据备份')
    if type(value['format_version']) is not int or value['format_version'] != 1:
        raise BackupError('备份格式版本不受支持')
    version = value['application_version']
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}', version):
        raise BackupError('备份中的应用版本无效')
    if tuple(map(int, version.split('.'))) > tuple(map(int, __version__.split('.'))):
        raise BackupError('备份来自更新版本，请先升级应用再恢复')
    try:
        if not isinstance(value['created_at'], str) or datetime.fromisoformat(value['created_at']).utcoffset() is None:
            raise ValueError()
    except (ValueError, OverflowError):
        raise BackupError('备份时间无效') from None
    files = value['files']
    if not isinstance(files, dict) or set(files) != set(DATABASES):
        raise BackupError('备份必须包含配对的运行库和模拟业务库')
    for description in files.values():
        if (not isinstance(description, dict) or set(description) != {'size', 'sha256'}
                or type(description['size']) is not int or not 0 < description['size'] <= MAX_DATABASE_BYTES
                or not isinstance(description['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', description['sha256'])):
            raise BackupError('备份文件清单无效或超过大小上限')
    return value


@contextmanager
def _validated(backup):
    with tempfile.TemporaryDirectory(prefix='agent-backup-verify-') as temporary:
        staging = Path(temporary)
        try:
            with zipfile.ZipFile(backup) as archive:
                members = archive.infolist()
                if len(members) != 3 or {item.filename for item in members} != {'manifest.json', *DATABASES}:
                    raise BackupError('备份包含重复、缺失或不支持的文件')
                for item in members:
                    mode = (item.external_attr >> 16) & 0o170000
                    if item.is_dir() or mode not in (0, 0o100000) or item.flag_bits & 1 or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                        raise BackupError('备份包含不支持的文件类型或加密内容')
                    limit = MAX_MANIFEST_BYTES if item.filename == 'manifest.json' else MAX_DATABASE_BYTES
                    if not 0 < item.file_size <= limit:
                        raise BackupError('备份文件超过大小上限')
                manifest = _manifest(parse_json(archive.read('manifest.json').decode('utf-8')))
                for name in DATABASES:
                    description = manifest['files'][name]
                    if archive.getinfo(name).file_size != description['size']:
                        raise BackupError(name + ' 大小与清单不一致')
                    value = hashlib.sha256()
                    size = 0
                    with archive.open(name) as source, (staging / name).open('xb') as target:
                        os.fchmod(target.fileno(), 0o600)
                        while block := source.read(CHUNK):
                            size += len(block)
                            if size > description['size']:
                                raise BackupError(name + ' 解压大小超过清单')
                            value.update(block)
                            target.write(block)
                    if size != description['size'] or value.hexdigest() != description['sha256']:
                        raise BackupError(name + ' 校验不匹配，备份可能已损坏')
                    _check_database(staging / name, name)
        except BackupError:
            raise
        except (zipfile.BadZipFile, sqlite3.Error, UnicodeError, RuntimeError, EOFError, ValueError, RecursionError) as exc:
            raise BackupError('备份损坏、不可读取或数据库无效') from exc
        yield manifest, staging


def _contents(staging,workspace_offset):
    """Describe only the validated snapshot, without loading an application."""
    counts={}
    with _connect(staging/'runtime.sqlite3') as db:
        tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        # Count stored records, including archived/deleted history. Execution
        # records and registered conversations are intentionally distinct.
        for key,table in (('execution_records','runs'),('conversations','task_conversations'),
                          ('agents','agent_profiles'),('workspaces','workspaces'),
                          ('workflows','workflows'),('workflow_runs','workflow_runs'),
                          ('runtime_configurations','runtime_configuration')):
            counts[key]=db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] if table in tables else 0
        counts['saved_task_drafts']=(db.execute("SELECT COUNT(*) FROM task_drafts WHERE json_type(data)='object'").fetchone()[0]
                                    if 'task_drafts' in tables else 0)
        items=[]
        if 'workspaces' in tables:
            rows=db.execute('''SELECT tenant,id,project,json_extract(data,'$.name'),deleted
                FROM workspaces ORDER BY tenant,id LIMIT ? OFFSET ?''',(WORKSPACE_PREVIEW_LIMIT,workspace_offset)).fetchall()
            for tenant,identity,project,name,deleted in rows:
                items.append({'tenant':tenant,'id':identity,'project_id':project,'name':name,'deleted':bool(deleted)})
    with _connect(staging/'mock-business.sqlite3') as db:
        counts['business_drafts']=db.execute('SELECT COUNT(*) FROM drafts').fetchone()[0]
    next_offset=workspace_offset+len(items)
    more=next_offset<counts['workspaces']
    return {'version':1,'counts':counts,'workspaces':{'total':counts['workspaces'],'offset':workspace_offset,
        'limit':WORKSPACE_PREVIEW_LIMIT,'has_more':more,'next_offset':next_offset if more else None,'items':items}}


def verify_backup(backup,*,workspace_offset=0):
    if type(workspace_offset) is not int or not 0<=workspace_offset<=9223372036854775807:
        raise BackupError('工作空间起始位置须为有效的非负整数')
    with _validated(backup) as (manifest, staging):
        try:contents=_contents(staging,workspace_offset)
        except sqlite3.Error as exc:
            raise BackupError('备份内容摘要无法读取，数据库结构或记录不兼容') from exc
        return {'valid': True, 'scope': 'all-local-core-data', **manifest,'contents':contents}


def _clear_leases(path):
    cleared = {}
    with sqlite3.connect(path, factory=ClosingConnection) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'workflow_chat_requests' in tables:
            cleared['workflow_chat_requests']=db.execute("UPDATE workflow_chat_requests SET owner='',lease_until=0 WHERE state='RUNNING'").rowcount
        if 'learning_proposals' in tables:
            cleared['learning_proposals']=db.execute("UPDATE learning_proposals SET data=json_set(data,'$.generation_claim.owner','','$.generation_claim.expires_at',0) WHERE status='GENERATING'").rowcount
        for table in LEASE_TABLES:
            if table in tables:
                extra = ',epoch=epoch+1' if table == 'runs' else ''
                count = db.execute('UPDATE ' + table + ' SET owner=NULL,lease_until=0' + extra +
                                   ' WHERE owner IS NOT NULL OR lease_until!=0').rowcount
                cleared[table] = count
    return cleared


def _unlink_created(path, inode):
    try:
        current = path.lstat()
    except FileNotFoundError:
        return True
    if current.st_ino != inode:
        return False
    path.unlink()
    return True


def _rollback_restore(destination, created, directory_inode):
    if not created:
        return
    if directory_inode is not None:
        try:
            current = destination.lstat()
        except FileNotFoundError:
            current = None
        if current is not None:
            if current.st_ino != directory_inode:
                return  # A replacement directory is not ours to clean.
            for path, inode in reversed(created[1:]):
                if not _unlink_created(path, inode):
                    return  # Keep the guard if an owned file was replaced.
            _sync_directory(destination)
            destination.rmdir()  # Unrelated files also keep the path guarded.
        _sync_directory(destination.parent)
    # Retire the guard only after the removal of partial data is durable.
    if _unlink_created(*created[0]):
        _sync_directory(destination.parent)


def restore_backup(backup, destination):
    destination = _new_target(destination)
    created = []
    data_durable = False
    directory_inode = None
    with _validated(backup) as (manifest, staging):
        try:
            cleared = _clear_leases(staging / 'runtime.sqlite3')
        except sqlite3.Error as exc:
            raise BackupError('恢复准备失败，无法清理旧进程占用状态') from exc
        # Validation finishes before the destination is created; mkdir and each
        # file creation are exclusive, so an existing workspace is never replaced.
        try:
            guard = _restore_guard(destination)
            try:
                with guard.open('xb') as target:
                    created.append((guard, os.fstat(target.fileno()).st_ino))
                    os.fchmod(target.fileno(), 0o600)
                    target.write(b'Restore has reserved this data-directory path.\n')
                    target.flush()
                    os.fsync(target.fileno())
            except FileExistsError as exc:
                raise BackupError('此目标已有未完成的恢复，请选择新的数据目录') from exc
            _sync_directory(destination.parent)
            destination.mkdir(mode=0o700)
            directory_inode = destination.stat().st_ino
            marker = destination / RESTORE_MARKER
            with marker.open('xb') as target:
                created.append((marker, os.fstat(target.fileno()).st_ino))
                os.fchmod(target.fileno(), 0o600)
                target.write(b'Restore is incomplete until this marker is removed.\n')
                target.flush()
                os.fsync(target.fileno())
            _sync_directory(destination)
            for name in DATABASES:
                with (staging / name).open('rb') as source, (destination / name).open('xb') as target:
                    created.append((destination / name, os.fstat(target.fileno()).st_ino))
                    os.fchmod(target.fileno(), 0o600)
                    shutil.copyfileobj(source, target, CHUNK)
                    target.flush()
                    os.fsync(target.fileno())
            receipt = {'backup_created_at': manifest['created_at'], 'source_version': manifest['application_version'],
                       'restored_at': _utc(), 'leases_cleared': cleared}
            with (destination / 'restore-receipt.json').open('xb') as target:
                created.append((destination / 'restore-receipt.json', os.fstat(target.fileno()).st_ino))
                os.fchmod(target.fileno(), 0o600)
                target.write(json.dumps(receipt, ensure_ascii=False, indent=2).encode('utf-8'))
                target.flush()
                os.fsync(target.fileno())
            _sync_directory(destination)
            _sync_directory(destination.parent)
            # After this boundary, a reader may observe a completed restore.
            # Errors during marker retirement must never delete these databases.
            data_durable = True
            marker.unlink()
            _sync_directory(destination)
            guard.unlink()
            _sync_directory(destination.parent)
        except BaseException:
            if not data_durable:
                try:
                    _rollback_restore(destination, created, directory_inode)
                except OSError:
                    pass  # A failed rollback keeps the durable path guard.
            raise
    return {'directory': str(destination), 'valid': True, 'scope': 'all-local-core-data', **receipt}
