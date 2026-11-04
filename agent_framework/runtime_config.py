"""Tenant-scoped configuration of the cognition runtime. No credentials or shell commands."""

from dataclasses import asdict
import json
from pathlib import Path
import shutil
import time

from .contracts import canonical,digest,identifier
from .llm import CodexConfig, CursorConfig, QoderConfig, CONFIG_TYPES, LLMPlanner, ModelError, qoder_command
from .runtime_detection import RuntimeDetectionError, run_version_command
from .store import Store

PROVIDERS = {
    'mock': {'name': '模拟运行时', 'command': None, 'description': '确定性规划，离线演示与故障回归'},
    'codex': {'name': 'Codex CLI', 'command': 'codex', 'description': '使用本机 Codex 登录态和结构化输出'},
    'cursor': {'name': 'Cursor CLI', 'command': 'cursor-agent', 'description': '使用 Cursor Ask 模式和受限工具权限'},
    'qoder': {'name': 'Qoder CLI', 'command': 'qodercli', 'description': '使用本机 Qoder 登录态和非交互结构化输出'},
}


class ConfigConflict(ValueError):
    pass


class RuntimeConfiguration:
    def __init__(self, data_dir, tenant):
        self.store = Store(Path(data_dir) / 'runtime.sqlite3')
        self.tenant = tenant
        with self.store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS runtime_configuration (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS runtime_configuration_requests (tenant TEXT,principal TEXT,request_id TEXT,request_hash TEXT,receipt TEXT,PRIMARY KEY(tenant,principal,request_id))')

    def defaults(self):
        try:
            codex = asdict(CodexConfig.local())
        except (ValueError, TypeError, OSError):
            codex = {'model': '', 'reasoning_effort': 'medium', 'timeout': 60, 'max_attempts': 2}
        try:
            cursor = asdict(CursorConfig.local())
        except (ValueError, TypeError, OSError):
            cursor = {'model': '', 'timeout': 60, 'max_attempts': 2}
        try:
            qoder=asdict(QoderConfig.local())
        except (ValueError,TypeError,OSError):
            qoder={'model':'','timeout':60,'max_attempts':2}
        return {'default_runtime': 'mock', 'profiles': {'codex': codex, 'cursor': cursor, 'qoder':qoder}}

    def get(self,*,db=None):
        with self.store.read_snapshot(db) as db:
            row = db.execute('SELECT * FROM runtime_configuration WHERE tenant=?', (self.tenant,)).fetchone()
        if row:
            saved=json.loads(row['data'])
            profiles={**self.defaults()['profiles'],**saved['profiles']}
            return {**saved,'profiles':profiles,'revision': row['revision'], 'updated_at': row['updated']}
        return {**self.defaults(), 'revision': 0, 'updated_at': None}

    def _normalize(self,data,current):
        if not isinstance(data, dict) or set(data) != {'default_runtime', 'profiles', 'revision'}:
            raise ValueError('配置必须包含默认运行时、配置项与版本号')
        provider = data['default_runtime']
        if not isinstance(provider, str) or provider not in PROVIDERS:
            raise ValueError('不支持的运行时')
        revision = data['revision']
        if type(revision) is not int or revision < 0:
            raise ValueError('配置版本号无效')
        profiles = data['profiles']
        if not isinstance(profiles, dict) or set(profiles) not in ({'codex','cursor'},{'codex','cursor','qoder'}):
            raise ValueError('需提供 Codex、Cursor 和 Qoder 配置')
        # Older clients can still save without deleting an existing Qoder profile.
        profiles={**current['profiles'],**profiles}
        normalized = {}
        for key, cls in CONFIG_TYPES.items():
            if key not in profiles:profiles[key]={'model':'','timeout':60,'max_attempts':2}
            profile = profiles[key]
            fields = {'model', 'timeout', 'max_attempts'} | ({'reasoning_effort'} if key == 'codex' else set())
            if not isinstance(profile, dict) or set(profile) != fields:
                raise ValueError(key + ' 配置字段不完整或包含不支持的字段')
            if not isinstance(profile['model'], str):
                raise ValueError('模型 ID 必须为字符串')
            model = profile['model'].strip()
            if model.startswith('-') or any(ord(c) < 32 for c in model):
                raise ValueError('模型 ID 含无效字符')
            # Other providers may remain unconfigured while saving a valid default.
            value = {**profile, 'model': model}
            config = cls(**{**value, 'model': model or 'unconfigured-model'})
            normalized[key] = {**asdict(config), 'model': model}
        if provider != 'mock' and not normalized[provider]['model']:
            raise ValueError('请填写默认运行时的模型 ID')
        if current['revision']!=revision:raise ConfigConflict('配置已被其他页面更新；请核对当前配置后再保存')
        return {'default_runtime':provider,'profiles':normalized}

    def _write(self,db,saved,revision):
        now=time.time()
        db.execute('INSERT OR REPLACE INTO runtime_configuration VALUES(?,?,?,?)',(self.tenant,revision+1,canonical(saved),now))
        return {**saved,'revision':revision+1,'updated_at':now}

    def save(self,data):
        with self.store.transaction() as db:
            current=self.get(db=db);saved=self._normalize(data,current)
            return self._write(db,saved,current['revision'])

    def accept(self,data,principal):
        """Commit one settings version and its immutable receipt together."""
        identifier(principal)
        if not isinstance(data,dict) or set(data)!={'default_runtime','profiles','revision','request_id'}:raise ValueError('请提供配置、版本和保存编号')
        request_id=identifier(data['request_id']);payload={k:v for k,v in data.items() if k!='request_id'};fingerprint=digest(payload)
        with self.store.transaction() as db:
            existing=db.execute('SELECT request_hash,receipt FROM runtime_configuration_requests WHERE tenant=? AND principal=? AND request_id=?',(self.tenant,principal,request_id)).fetchone()
            if existing:
                if existing['request_hash']!=fingerprint:raise ConfigConflict('保存编号已用于其他配置，请先核对原保存')
                receipt=json.loads(existing['receipt'])
            else:
                current=self.get(db=db);saved=self._normalize(payload,current);committed=self._write(db,saved,current['revision'])
                receipt={'request_id':request_id,'tenant':self.tenant,'principal':principal,'request_hash':fingerprint,'base_revision':current['revision'],'settings':committed,'accepted_at':committed['updated_at']}
                db.execute('INSERT INTO runtime_configuration_requests VALUES(?,?,?,?,?)',(self.tenant,principal,request_id,fingerprint,canonical(receipt)))
            settings=self.get(db=db)
        return {'request_id':request_id,'found':True,'receipt':receipt,'settings':settings,'providers':self.catalog()}

    def inspect_request(self,request_id,principal):
        identifier(request_id);identifier(principal)
        with self.store.read_snapshot() as db:
            row=db.execute('SELECT receipt FROM runtime_configuration_requests WHERE tenant=? AND principal=? AND request_id=?',(self.tenant,principal,request_id)).fetchone()
            settings=self.get(db=db)
        return {'request_id':request_id,'found':row is not None,'receipt':json.loads(row['receipt']) if row else None,'settings':settings,'providers':self.catalog()}

    def catalog(self):
        return [{'id': key, **info,'command':qoder_command() if key=='qoder' else info['command'],
                 'installed':info['command'] is None or bool(shutil.which(qoder_command() if key=='qoder' else info['command']))}
                for key,info in PROVIDERS.items()]

    def detect(self, provider):
        if provider not in PROVIDERS:
            raise ValueError('不支持的运行时')
        command = qoder_command() if provider=='qoder' else PROVIDERS[provider]['command']
        if command is None:
            return {'provider': provider, 'installed': True, 'ok': True, 'version': 'built-in', 'message': '内置运行时可用，无需登录'}
        if not shutil.which(command):
            return {'provider': provider, 'installed': False, 'ok': False, 'message': '未找到 ' + command + '，请先安装 CLI'}
        try:
            result = run_version_command([command, '--version'])
            version = result.stdout.strip().splitlines()[0][:160] if result.returncode == 0 and result.stdout.strip() else None
            return {'provider': provider, 'installed': True, 'ok': result.returncode == 0, 'version': version,
                    'message': 'CLI 检测完成；登录态与模型权限将在执行时确认' if result.returncode == 0 else 'CLI 检测失败，请在终端检查安装'}
        except RuntimeDetectionError as error:
            message=str(error)
            if getattr(error,'cleanup_failure',None):message+='；检测进程清理未确认，请在终端检查残留进程'
            return {'provider': provider, 'installed': True, 'ok': False, 'message': message}
        except (OSError, ModelError) as error:
            message='检测进程清理未确认，请在终端检查残留进程' if getattr(error,'cleanup_failure',None) else 'CLI 检测未完成，请在终端检查安装后重试'
            return {'provider': provider, 'installed': True, 'ok': False, 'message': message}

    def planner(self, provider=None, settings=None):
        settings = settings if settings is not None else self.get()
        provider = provider or settings['default_runtime']
        if provider not in PROVIDERS:
            raise ValueError('不支持的运行时')
        if provider == 'mock':
            return None
        if not any(item['id'] == provider and item['installed'] for item in self.catalog()):
            raise ValueError('请先安装所选运行时的 CLI')
        cls = CONFIG_TYPES[provider]
        return LLMPlanner(cls(**settings['profiles'][provider]))
