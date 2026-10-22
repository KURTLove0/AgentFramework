"""Versioned, tenant-scoped Agent definitions, consumed by the selected CLI planner."""
from copy import deepcopy
import json
from pathlib import Path
import re
import shutil
import time
from urllib.parse import urlsplit
from uuid import uuid4

from .contracts import canonical
from .llm import CodexConfig, CursorConfig, LLMPlanner
from .runtime_config import ConfigConflict
from .store import Store


def text(value, label, maximum, empty=False):
    if not isinstance(value,str) or len(value)>maximum or (not empty and not value.strip()) or '\x00' in value:
        raise ValueError(label+' 格式或长度无效')
    return value.strip()


def string_list(value,label,maximum=32):
    if not isinstance(value,list) or len(value)>maximum:raise ValueError(label+' 必须为数组')
    return [text(v,label,2000) for v in value]


def validate_extensions(skills,servers):
    if not isinstance(skills,list) or len(skills)>8:raise ValueError('最多配置 8 个 Skill')
    normalized_skills=[];names=set()
    for skill in skills:
        if not isinstance(skill,dict) or set(skill)!={'name','instructions','enabled'} or type(skill['enabled']) is not bool:raise ValueError('Skill 字段无效')
        name=text(skill['name'],'Skill 名称',64)
        if name in names:raise ValueError('Skill 名称不能重复')
        names.add(name);normalized_skills.append({'name':name,'instructions':text(skill['instructions'],'Skill 内容',8000),'enabled':skill['enabled']})
    if not isinstance(servers,list) or len(servers)>8:raise ValueError('最多配置 8 个 MCP 服务')
    normalized_servers=[];names=set()
    for server in servers:
        fields={'name','transport','command','args','url','env_vars','bearer_env','tools','enabled'}
        if not isinstance(server,dict) or set(server)!=fields or type(server['enabled']) is not bool:raise ValueError('MCP 字段无效')
        name=server['name']
        if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,39}',name) or name in names:raise ValueError('MCP 名称需唯一，且仅包含字母、数字、下划线或连字符')
        names.add(name)
        transport=server['transport']
        if transport not in {'stdio','http'}:raise ValueError('MCP 仅支持 stdio 或 HTTP')
        command=text(server['command'],'MCP 命令',1000,empty=True)
        args=string_list(server['args'],'MCP 参数')
        url=text(server['url'],'MCP URL',2000,empty=True)
        env_vars=string_list(server['env_vars'],'环境变量名称')
        bearer=text(server['bearer_env'],'令牌环境变量名称',100,empty=True)
        for key in env_vars+([bearer] if bearer else []):
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,99}',key):raise ValueError('仅保存环境变量名称，不接收密钥值')
        tools=string_list(server['tools'],'MCP 工具白名单')
        if len(tools)!=len(set(tools)) or any(not re.fullmatch(r'[A-Za-z0-9_./-]{1,120}',tool) for tool in tools):raise ValueError('请填写明确的 MCP 工具名，不能使用通配符')
        if server['enabled']:
            if not tools:raise ValueError('启用 MCP 前需填写工具白名单')
            if transport=='stdio' and (not command or command.startswith('-')):raise ValueError('请填写 MCP 可执行命令')
            if transport=='http':
                parsed=urlsplit(url)
                if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:raise ValueError('MCP URL 必须为无内嵌凭据的 HTTP(S) 地址')
        normalized_servers.append({'name':name,'transport':transport,'command':command,'args':args,'url':url,'env_vars':env_vars,'bearer_env':bearer,'tools':tools,'enabled':server['enabled']})
    return normalized_skills,normalized_servers


class AgentRegistry:
    def __init__(self,data_dir,tenant,configuration,models,workspace_id='workspace-default'):
        self.store=Store(Path(data_dir)/'runtime.sqlite3');self.tenant=tenant
        self.configuration,self.models=configuration,models
        self.workspace_id=workspace_id
        with self.store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS agent_profiles (tenant TEXT, id TEXT, revision INTEGER, data TEXT, created REAL, updated REAL, archived INTEGER, PRIMARY KEY(tenant,id))')
            if 'workspace_id' not in {r[1] for r in db.execute('PRAGMA table_info(agent_profiles)')}:
                db.execute("ALTER TABLE agent_profiles ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace-default'")

    def list(self):
        with self.store.connect() as db:
            rows=db.execute('SELECT * FROM agent_profiles WHERE tenant=? AND workspace_id=? ORDER BY updated DESC',(self.tenant,self.workspace_id)).fetchall()
        return [self._row(row) for row in rows]

    @staticmethod
    def _row(row):
        return {**json.loads(row['data']),'id':row['id'],'revision':row['revision'],'created_at':row['created'],'updated_at':row['updated'],'archived':bool(row['archived'])}

    def get(self,identity):
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM agent_profiles WHERE tenant=? AND id=? AND workspace_id=?',(self.tenant,identity,self.workspace_id)).fetchone()
        if not row:raise KeyError('Agent not found')
        return self._row(row)

    def save(self,data,identity=None):
        fields={'name','description','runtime','model','options','prompt','skills','mcp_servers','revision'}
        if not isinstance(data,dict) or set(data) - (fields | {'definition'}) or not fields <= set(data):raise ValueError('Agent 配置字段不完整或包含未知字段')
        name=text(data['name'],'Agent 名称',80)
        description=text(data['description'],'Agent 描述',500,empty=True)
        provider=data['runtime']
        if provider not in {'mock','codex','cursor'}:raise ValueError('不支持的运行时')
        model=text(data['model'],'模型',120,empty=provider=='mock')
        options=data['options']
        expected=set() if provider=='mock' else {'timeout','max_attempts'}|({'reasoning_effort'} if provider=='codex' else set())
        if not isinstance(options,dict) or set(options)!=expected:raise ValueError('运行时选项无效')
        if provider!='mock':
            cls=CodexConfig if provider=='codex' else CursorConfig
            cls(model=model,**options)
            selected=self.models.require(provider,model)
            if provider=='codex' and selected.get('efforts') and options['reasoning_effort'] not in selected['efforts']:
                raise ValueError('所选模型不支持该推理强度，请从 CLI 返回的选项中选择')
        skills,servers=validate_extensions(data['skills'],data['mcp_servers'])
        if provider=='mock' and any(s['enabled'] for s in servers):raise ValueError('模拟运行时不启动外部 MCP，请选择 Codex 或 Cursor')
        for server in servers:
            if server['enabled'] and server['transport']=='stdio':
                executable=shutil.which(server['command'])
                if not executable:raise ValueError('找不到 MCP 可执行命令，请填写本机已安装命令的绝对路径')
                server['command']=str(Path(executable).resolve())
        profile={'name':name,'description':description,'runtime':provider,'model':model if provider!='mock' else 'builtin','options':options,
                 'prompt':text(data['prompt'],'Agent Prompt',8000),'skills':skills,'mcp_servers':servers}
        if len(canonical(profile).encode())>60000:raise ValueError('Agent 配置总大小超过 60 KB')
        from .definitions import normalize_definition
        # Old clients may omit the new structured field on edits. Preserve it.
        prior = self.get(identity) if identity else None
        source = data.get('definition', (prior or {}).get('definition'))
        if source is not None:
            source = deepcopy(source)
            if not isinstance(source, dict) or not isinstance(source.get('identity'), dict):
                raise ValueError('岗位 identity 必须是对象')
            source['identity']['name'] = name
        profile['definition'] = normalize_definition(source, name)
        if len(canonical(profile).encode()) > 60000:
            raise ValueError('Agent 配置总大小超过 60 KB')
        revision=data['revision']
        if type(revision) is not int or revision<0:raise ValueError('Agent 版本号无效')
        now=time.time()
        creating=identity is None
        if identity is None:
            if revision!=0:raise ConfigConflict('新 Agent 的版本应为 0')
            identity='agent-'+uuid4().hex[:16]
        with self.store.transaction() as db:
            row=db.execute('SELECT revision,created,archived FROM agent_profiles WHERE tenant=? AND id=? AND workspace_id=?',(self.tenant,identity,self.workspace_id)).fetchone()
            if (row['revision'] if row else 0)!=revision:raise ConfigConflict('Agent 已被其他页面更新，请重新加载')
            if not row and not creating:raise KeyError('Agent not found')
            db.execute('INSERT OR REPLACE INTO agent_profiles(tenant,id,revision,data,created,updated,archived,workspace_id) VALUES(?,?,?,?,?,?,?,?)',
                       (self.tenant,identity,revision+1,canonical(profile),row['created'] if row else now,now,row['archived'] if row else 0,self.workspace_id))
        return self.get(identity)

    def compile(self, identity, revision=None):
        from .definitions import AgentCompiler
        profile = self.get(identity)
        if revision is not None and (type(revision) is not int or revision != profile['revision']):
            raise ConfigConflict('Agent 已更新，请重新加载')
        if profile['archived']:
            raise ValueError('此 Agent 已归档')
        compiled = AgentCompiler().compile(profile)
        # Content-addressed, tenant-scoped receipt; never modifies historical runs.
        with self.store.transaction() as db:
            db.execute('CREATE TABLE IF NOT EXISTS compiled_agents (tenant TEXT, hash TEXT, data TEXT, PRIMARY KEY(tenant,hash))')
            db.execute('INSERT OR IGNORE INTO compiled_agents VALUES(?,?,?)', (self.tenant, compiled['hash'], canonical(compiled)))
        return compiled

    def archive(self,identity,revision,archived=True):
        if type(revision) is not int or type(archived) is not bool:raise ValueError('Agent 版本或归档状态无效')
        self.get(identity)
        with self.store.transaction() as db:
            row=db.execute('SELECT revision FROM agent_profiles WHERE tenant=? AND id=?',(self.tenant,identity)).fetchone()
            if not row:raise KeyError('Agent not found')
            if row['revision']!=revision:raise ConfigConflict('Agent 已更新，请重新加载')
            db.execute('UPDATE agent_profiles SET archived=?,revision=revision+1,updated=? WHERE tenant=? AND id=?',(int(archived),time.time(),self.tenant,identity))
        return self.get(identity)

    def planner(self,profile):
        if profile['archived']:raise ValueError('此 Agent 已归档，请选择其他 Agent')
        if profile['runtime']=='mock':return None
        cls=CodexConfig if profile['runtime']=='codex' else CursorConfig
        return LLMPlanner(cls(model=profile['model'],**profile['options']),agent_profile=deepcopy(profile))


def agent_ref(profile):return profile['id']+'@'+str(profile['revision'])


def public_agent_context(profile, legacy=False):
    if legacy:
        return {'name':profile['name'],'description':profile['description'],'prompt':profile['prompt'],
                'skills':[s for s in profile['skills'] if s['enabled']],
                'mcp_tools':[{'server':s['name'],'tools':s['tools']} for s in profile['mcp_servers'] if s['enabled']]}
    from .definitions import NATIVE_NAMES
    native = (profile.get('definition') or {}).get('native_read_refs', [])
    return {'definition': profile.get('definition'), 'name':profile['name'],'description':profile['description'],'prompt':profile['prompt'],
            'skills':[s for s in profile['skills'] if s['enabled']],
            'mcp_tools':([{'server':'governed','tools':[NATIVE_NAMES[ref] for ref in native]}] if native else [])}
