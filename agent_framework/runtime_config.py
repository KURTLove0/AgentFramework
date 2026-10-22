"""Tenant-scoped configuration of the cognition runtime. No credentials or shell commands."""

from dataclasses import asdict
import json
from pathlib import Path
import shutil
import subprocess
import time

from .contracts import canonical
from .llm import CodexConfig, CursorConfig, LLMPlanner
from .store import Store

PROVIDERS = {
    'mock': {'name': '模拟运行时', 'command': None, 'description': '确定性规划，离线演示与故障回归'},
    'codex': {'name': 'Codex CLI', 'command': 'codex', 'description': '使用本机 Codex 登录态和结构化输出'},
    'cursor': {'name': 'Cursor CLI', 'command': 'cursor-agent', 'description': '使用 Cursor Ask 模式和受限工具权限'},
}


class ConfigConflict(ValueError):
    pass


class RuntimeConfiguration:
    def __init__(self, data_dir, tenant):
        self.store = Store(Path(data_dir) / 'runtime.sqlite3')
        self.tenant = tenant
        with self.store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS runtime_configuration (tenant TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL)')

    def defaults(self):
        try:
            codex = asdict(CodexConfig.local())
        except (ValueError, TypeError, OSError):
            codex = {'model': '', 'reasoning_effort': 'medium', 'timeout': 60, 'max_attempts': 2}
        try:
            cursor = asdict(CursorConfig.local())
        except (ValueError, TypeError, OSError):
            cursor = {'model': '', 'timeout': 60, 'max_attempts': 2}
        return {'default_runtime': 'mock', 'profiles': {'codex': codex, 'cursor': cursor}}

    def get(self):
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM runtime_configuration WHERE tenant=?', (self.tenant,)).fetchone()
        if row:
            return {**json.loads(row['data']), 'revision': row['revision'], 'updated_at': row['updated']}
        return {**self.defaults(), 'revision': 0, 'updated_at': None}

    def save(self, data):
        if not isinstance(data, dict) or set(data) != {'default_runtime', 'profiles', 'revision'}:
            raise ValueError('配置必须包含默认运行时、配置项与版本号')
        provider = data['default_runtime']
        if not isinstance(provider, str) or provider not in PROVIDERS:
            raise ValueError('不支持的运行时')
        revision = data['revision']
        if type(revision) is not int or revision < 0:
            raise ValueError('配置版本号无效')
        profiles = data['profiles']
        if not isinstance(profiles, dict) or set(profiles) != {'codex', 'cursor'}:
            raise ValueError('需提供 Codex 和 Cursor 配置')
        normalized = {}
        for key, cls in [('codex', CodexConfig), ('cursor', CursorConfig)]:
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
        saved = {'default_runtime': provider, 'profiles': normalized}
        with self.store.transaction() as db:
            current = db.execute('SELECT revision FROM runtime_configuration WHERE tenant=?', (self.tenant,)).fetchone()
            if (current['revision'] if current else 0) != revision:
                raise ConfigConflict('配置已被其他页面更新；请重新加载后再保存')
            db.execute('INSERT OR REPLACE INTO runtime_configuration VALUES(?,?,?,?)',
                       (self.tenant, revision + 1, canonical(saved), time.time()))
        return self.get()

    def catalog(self):
        return [{'id': key, **info, 'installed': info['command'] is None or bool(shutil.which(info['command']))}
                for key, info in PROVIDERS.items()]

    def detect(self, provider):
        if provider not in PROVIDERS:
            raise ValueError('不支持的运行时')
        command = PROVIDERS[provider]['command']
        if command is None:
            return {'provider': provider, 'installed': True, 'ok': True, 'version': 'built-in', 'message': '内置运行时可用，无需登录'}
        if not shutil.which(command):
            return {'provider': provider, 'installed': False, 'ok': False, 'message': '未找到 ' + command + '，请先安装 CLI'}
        try:
            result = subprocess.run([command, '--version'], capture_output=True, text=True, timeout=5)
            version = result.stdout.strip().splitlines()[0][:160] if result.stdout.strip() else None
            return {'provider': provider, 'installed': True, 'ok': result.returncode == 0, 'version': version,
                    'message': 'CLI 检测完成；登录态与模型权限将在执行时确认' if result.returncode == 0 else 'CLI 检测失败，请在终端检查安装'}
        except (OSError, subprocess.TimeoutExpired):
            return {'provider': provider, 'installed': True, 'ok': False, 'message': 'CLI 检测超时或无法启动'}

    def planner(self, provider=None, settings=None):
        settings = settings if settings is not None else self.get()
        provider = provider or settings['default_runtime']
        if provider not in PROVIDERS:
            raise ValueError('不支持的运行时')
        if provider == 'mock':
            return None
        if not any(item['id'] == provider and item['installed'] for item in self.catalog()):
            raise ValueError('请先安装所选运行时的 CLI')
        cls = CodexConfig if provider == 'codex' else CursorConfig
        return LLMPlanner(cls(**settings['profiles'][provider]))
