"""Versioned, tenant-scoped Agent definitions, consumed by the selected CLI planner."""
from copy import deepcopy
import json
from pathlib import Path
import re
import shutil
import time
from urllib.parse import urlsplit
from uuid import uuid4

from .contracts import canonical, digest, identifier
from .llm import CONFIG_TYPES, LLMPlanner
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
            db.execute('''CREATE TABLE IF NOT EXISTS agent_save_requests(
                tenant TEXT,workspace TEXT,principal TEXT,request_id TEXT,request_hash TEXT,
                agent_id TEXT,revision INTEGER,created REAL,PRIMARY KEY(tenant,workspace,principal,request_id))''')
            if 'workspace_id' not in {r[1] for r in db.execute('PRAGMA table_info(agent_profiles)')}:
                db.execute("ALTER TABLE agent_profiles ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace-default'")

    def list(self):
        with self.store.connect() as db:
            rows=db.execute('SELECT * FROM agent_profiles WHERE tenant=? AND workspace_id=? ORDER BY updated DESC',(self.tenant,self.workspace_id)).fetchall()
        return [self._row(row) for row in rows]

    def catalog(self):
        """Directory profiles retain pinned methods, without frozen file bodies."""
        with self.store.connect() as db:
            rows=db.execute('''SELECT a.id,a.revision,a.created,a.updated,a.archived,
                json_remove(a.data,'$.skill_packages') AS data,
                (SELECT json_group_array(json_remove(p.value,'$.package.files'))
                 FROM json_each(a.data,'$.skill_packages') p) AS skill_summaries
                FROM agent_profiles a WHERE a.tenant=? AND a.workspace_id=? ORDER BY a.updated DESC,a.id''',
                (self.tenant,self.workspace_id))
            return [{**self._row(row),'catalog_only':True,'skill_summaries':json.loads(row['skill_summaries'])} for row in rows]

    @staticmethod
    def _row(row):
        return {**json.loads(row['data']),'id':row['id'],'revision':row['revision'],'created_at':row['created'],'updated_at':row['updated'],'archived':bool(row['archived'])}

    def get(self,identity):
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM agent_profiles WHERE tenant=? AND id=? AND workspace_id=?',(self.tenant,identity,self.workspace_id)).fetchone()
        if not row:raise KeyError('Agent not found')
        return self._row(row)

    def prepare(self,data,identity=None):
        """Normalize and validate a profile without creating an Agent record."""
        fields={'name','description','runtime','model','options','prompt','skills','mcp_servers','revision'}
        if not isinstance(data,dict) or set(data) - (fields | {'definition','skill_bindings','evaluation_config','processing_domain_id','processing_domain_revision'}) or not fields <= set(data):raise ValueError('Agent 配置字段不完整或包含未知字段')
        prior = self.get(identity) if identity else None
        name=text(data['name'],'Agent 名称',80)
        description=text(data['description'],'Agent 描述',500,empty=True)
        provider=data['runtime']
        if provider not in {'mock',*CONFIG_TYPES}:raise ValueError('不支持的运行时')
        model=text(data['model'],'模型',120,empty=provider=='mock')
        options=data['options']
        expected=set() if provider=='mock' else {'timeout','max_attempts'}|({'reasoning_effort'} if provider=='codex' else set())
        if not isinstance(options,dict) or set(options)!=expected:raise ValueError('运行时选项无效')
        if provider!='mock':
            cls=CONFIG_TYPES[provider]
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
        source = data.get('definition', (prior or {}).get('definition'))
        if source is not None:
            source = deepcopy(source)
            if not isinstance(source, dict) or not isinstance(source.get('identity'), dict):
                raise ValueError('岗位 identity 必须是对象')
            source['identity']['name'] = name
        profile['definition'] = normalize_definition(source, name)
        domain_selection = None
        if 'processing_domain_revision' in data:
            if not data.get('processing_domain_id') or type(data['processing_domain_revision']) is not int or data['processing_domain_revision'] < 1:
                raise ValueError('请选择有效的处理领域版本')
        if 'processing_domain_id' in data:
            domain_id = text(data['processing_domain_id'], '处理领域', 80, empty=True)
            if domain_id:
                from .agent_domains import AgentDomains
                prior_domain = (prior or {}).get('processing_domain')
                selected_revision = data.get('processing_domain_revision')
                if prior_domain and domain_id == prior_domain['id'] and selected_revision == prior_domain['revision']:
                    profile['processing_domain'] = deepcopy(prior_domain)
                else:
                    selected = AgentDomains(self.store,self.tenant,self.workspace_id).get(domain_id)
                    if selected_revision is not None and selected['revision'] != selected_revision:
                        raise ConfigConflict('处理领域已更新，请重新选择领域后保存智能体')
                    profile['processing_domain'] = selected
                    domain_selection = selected
        elif (prior or {}).get('processing_domain'):
            profile['processing_domain'] = deepcopy(prior['processing_domain'])
        from .evaluation_contract import normalize_config
        if 'evaluation_config' in data or (prior or {}).get('evaluation_config'):
            profile['evaluation_config'] = normalize_config(data.get('evaluation_config', (prior or {}).get('evaluation_config')),
                                                          profile['definition'], reconcile='evaluation_config' not in data)
        if len(canonical(profile).encode()) > 60000:
            raise ValueError('Agent 配置总大小超过 60 KB')
        bindings=data.get('skill_bindings',(prior or {}).get('skill_bindings',[]))
        if not isinstance(bindings,list) or len(bindings)+len(skills)>8:raise ValueError('最多绑定 8 个 Skill（含兼容方法）')
        if bindings:
            from .skills import SkillRegistry
            registry=SkillRegistry(self.store,self.tenant,self.workspace_id);packages=[];seen=set();names={s['name'] for s in skills}
            for binding in bindings:
                frozen=next((s for s in (prior or {}).get('skill_packages',[]) if isinstance(binding,dict) and s['skill_id']==binding.get('skill_id') and s['version']==binding.get('version')),None)
                if frozen and binding.get('enabled') is False and set(binding)=={'skill_id','version','enabled'}:
                    resolved={**deepcopy(frozen),'enabled':False}
                else:resolved=registry.resolve(binding)
                if resolved['skill_id'] in seen or resolved['package']['name'] in names:raise ValueError('Skill 绑定与包名称不能重复')
                seen.add(resolved['skill_id']);names.add(resolved['package']['name']);packages.append(resolved)
            if len(canonical(packages).encode())>512000:raise ValueError('已选 Skill 总大小超过 512 KB')
            profile.update(skill_bindings=deepcopy(bindings),skill_packages=packages)
        revision=data['revision']
        if type(revision) is not int or revision<0:raise ValueError('Agent 版本号无效')
        return profile,domain_selection,revision

    def _assert_workspace_active(self,db):
        # Standalone registries may predate workspace registration.
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'").fetchone():
            from .workspaces import assert_workspace_active
            assert_workspace_active(db,self.tenant,self.workspace_id)

    def _save_receipt(self,db,request_id,principal,request_hash=None):
        receipt=db.execute('SELECT * FROM agent_save_requests WHERE tenant=? AND workspace=? AND principal=? AND request_id=?',
            (self.tenant,self.workspace_id,principal,request_id)).fetchone()
        if not receipt:return None
        if request_hash is not None and receipt['request_hash']!=request_hash:
            raise ConfigConflict('此保存编号已用于另一份配置，请先核对此次保存结果')
        row=db.execute('SELECT * FROM agent_profiles WHERE tenant=? AND workspace_id=? AND id=?',(self.tenant,self.workspace_id,receipt['agent_id'])).fetchone()
        if not row:raise KeyError('saved Agent no longer available')
        return {**self._row(row),'save_receipt':{'request_id':request_id,'revision':receipt['revision'],'at':receipt['created'],'replayed':True}}

    def save_request(self,request_id,*,principal):
        identifier(request_id);identifier(principal)
        with self.store.read_snapshot() as db:
            self._assert_workspace_active(db)
            receipt=self._save_receipt(db,request_id,principal)
            if receipt is None:raise KeyError('Agent save receipt not found')
            return receipt

    def save(self,data,identity=None,*,request_id=None,principal=None):
        data=deepcopy(data);request_hash=None
        if request_id is not None:
            identifier(request_id);identifier(principal)
            request_hash=digest({'agent_id':identity,'data':data})
        with self.store.read_snapshot() as db:
            self._assert_workspace_active(db)
            if request_id is not None:
                receipt=self._save_receipt(db,request_id,principal,request_hash)
                if receipt:return receipt
        profile,domain_selection,revision=self.prepare(data,identity)
        creating=identity is None
        if creating and revision!=0:raise ConfigConflict('新 Agent 的版本应为 0')
        with self.store.transaction() as db:
            self._assert_workspace_active(db)
            if request_id is not None:
                receipt=self._save_receipt(db,request_id,principal,request_hash)
                if receipt:return receipt
            if creating:identity='agent-'+uuid4().hex[:16]
            now=time.time()
            if domain_selection:
                selected = db.execute('SELECT data,archived FROM agent_domains WHERE tenant=? AND workspace=? AND id=?',
                                      (self.tenant, self.workspace_id, domain_selection['id'])).fetchone()
                if not selected or selected['archived'] or json.loads(selected['data']) != domain_selection:
                    raise ConfigConflict('处理领域已更新或归档，请重新选择后保存智能体')
            row=db.execute('SELECT revision,created,archived FROM agent_profiles WHERE tenant=? AND id=? AND workspace_id=?',(self.tenant,identity,self.workspace_id)).fetchone()
            if (row['revision'] if row else 0)!=revision:raise ConfigConflict('Agent 已被其他页面更新，请重新加载')
            if not row and not creating:raise KeyError('Agent not found')
            if row and row['archived']:raise ConfigConflict('此智能体已归档，请恢复后再编辑，或另建副本')
            db.execute('INSERT OR REPLACE INTO agent_profiles(tenant,id,revision,data,created,updated,archived,workspace_id) VALUES(?,?,?,?,?,?,?,?)',
                       (self.tenant,identity,revision+1,canonical(profile),row['created'] if row else now,now,row['archived'] if row else 0,self.workspace_id))
            saved={**profile,'id':identity,'revision':revision+1,'created_at':row['created'] if row else now,'updated_at':now,'archived':False}
            if request_id is not None:
                db.execute('INSERT INTO agent_save_requests VALUES(?,?,?,?,?,?,?,?)',(self.tenant,self.workspace_id,principal,request_id,request_hash,identity,revision+1,now))
                saved['save_receipt']={'request_id':request_id,'revision':revision+1,'at':now,'replayed':False}
        return saved

    def compile(self, identity, revision=None):
        from .definitions import AgentCompiler
        profile = self.get(identity)
        if revision is not None and (type(revision) is not int or revision != profile['revision']):
            raise ConfigConflict('Agent 已更新，请重新加载')
        if profile['archived']:
            raise ValueError('此 Agent 已归档')
        self.assert_skills_available(profile)
        compiled = AgentCompiler().compile(profile)
        # Content-addressed, tenant-scoped receipt; never modifies historical runs.
        with self.store.transaction() as db:
            self._assert_workspace_active(db)
            current=db.execute('SELECT revision,archived FROM agent_profiles WHERE tenant=? AND workspace_id=? AND id=?',(self.tenant,self.workspace_id,identity)).fetchone()
            if not current or current['archived'] or current['revision']!=profile['revision']:raise ConfigConflict('Agent 已更新或归档，请核对后重新编译')
            db.execute('CREATE TABLE IF NOT EXISTS compiled_agents (tenant TEXT, hash TEXT, data TEXT, PRIMARY KEY(tenant,hash))')
            db.execute('INSERT OR IGNORE INTO compiled_agents VALUES(?,?,?)', (self.tenant, compiled['hash'], canonical(compiled)))
        return compiled

    def evaluation_settings(self, identity):
        return self._evaluation_settings(self.get(identity))

    def _evaluation_settings(self, profile):
        from .evaluation_contract import normalize_config, compile_contract
        config = normalize_config(profile.get('evaluation_config'), profile['definition'])
        return {'agent_id': profile['id'], 'agent_name': profile['name'], 'revision': profile['revision'],
                'config': config, 'contract': compile_contract(profile['definition'], config, processing_domain=profile.get('processing_domain'))}

    def save_evaluation_settings(self, identity, data):
        if not isinstance(data,dict) or set(data) != {'revision','config'}:
            raise ValueError('岗位评测保存需要 revision 和 config')
        profile = self.get(identity)
        if profile['archived']:raise ValueError('此 Agent 已归档')
        payload = {k: profile[k] for k in ('name','description','runtime','model','options','prompt','skills','mcp_servers','definition')}
        payload.update(revision=data['revision'],evaluation_config=data['config'])
        # Return this committed revision, even if another editor saves immediately.
        return self._evaluation_settings(self.save(payload,identity))

    def assert_skills_available(self,profile):
        if not profile.get('skill_packages'):return
        from .skills import SkillRegistry
        registry=SkillRegistry(self.store,self.tenant,self.workspace_id)
        for item in profile['skill_packages']:
            if item['enabled'] and registry.resolve({k:item[k] for k in ('skill_id','version','enabled')})!=item:
                raise ValueError('Skill 版本内容已改变，请重新绑定')

    def assert_submission_current(self,db,profile):
        """Recheck a new task or generation in its acceptance transaction.

        Accepted tasks/proposals, follow-up turns and workflow children use frozen
        profiles instead. This method performs no schema setup or external I/O.
        """
        self._assert_workspace_active(db)
        current=db.execute('SELECT revision,archived FROM agent_profiles WHERE tenant=? AND workspace_id=? AND id=?',
                           (self.tenant,self.workspace_id,profile['id'])).fetchone()
        if not current or current['archived'] or current['revision']!=profile['revision']:
            raise ConfigConflict('智能体在提交期间已更新或归档，请核对当前配置后重新提交')
        for item in profile.get('skill_packages',[]):
            if not item['enabled']:continue
            skill=db.execute('''SELECT h.archived,v.status,v.hash,v.data FROM skill_heads h JOIN skill_versions v
                ON v.tenant=h.tenant AND v.workspace=h.workspace AND v.id=h.id
                WHERE h.tenant=? AND h.workspace=? AND h.id=? AND v.version=?''',
                (self.tenant,self.workspace_id,item['skill_id'],item['version'])).fetchone()
            if (not skill or skill['archived'] or skill['status']!='PUBLISHED'
                    or skill['hash']!=item['package']['hash'] or json.loads(skill['data'])!=item['package']):
                raise ConfigConflict('已启用的 Skill 在提交期间已撤回、归档或变化，请检查智能体配置后重新提交')

    def archive(self,identity,revision,archived=True):
        if type(revision) is not int or type(archived) is not bool:raise ValueError('Agent 版本或归档状态无效')
        self.get(identity)
        with self.store.transaction() as db:
            self._assert_workspace_active(db)
            row=db.execute('SELECT revision FROM agent_profiles WHERE tenant=? AND id=? AND workspace_id=?',(self.tenant,identity,self.workspace_id)).fetchone()
            if not row:raise KeyError('Agent not found')
            if row['revision']!=revision:raise ConfigConflict('Agent 已更新，请重新加载')
            db.execute('UPDATE agent_profiles SET archived=?,revision=revision+1,updated=? WHERE tenant=? AND id=?',(int(archived),time.time(),self.tenant,identity))
        return self.get(identity)

    def planner(self,profile):
        if profile['archived']:raise ValueError('此 Agent 已归档，请选择其他 Agent')
        if profile['runtime']=='mock':return None
        cls=CONFIG_TYPES[profile['runtime']]
        return LLMPlanner(cls(model=profile['model'],**profile['options']),agent_profile=deepcopy(profile))


def agent_ref(profile):return profile['id']+'@'+str(profile['revision'])


def public_agent_context(profile, legacy=False):
    if legacy:
        return {'name':profile['name'],'description':profile['description'],'prompt':profile['prompt'],
                'skills':[s for s in profile['skills'] if s['enabled']],
                'mcp_tools':[{'server':s['name'],'tools':s['tools']} for s in profile['mcp_servers'] if s['enabled']]}
    from .definitions import NATIVE_NAMES
    native = (profile.get('definition') or {}).get('native_read_refs', [])
    result={'definition': profile.get('definition'), 'name':profile['name'],'description':profile['description'],'prompt':profile['prompt'],
            'skills':[s for s in profile['skills'] if s['enabled']],
            'mcp_tools':([{'server':'governed','tools':[NATIVE_NAMES[ref] for ref in native]}] if native else [])}
    if profile.get('processing_domain'):
        result['processing_domain'] = deepcopy(profile['processing_domain'])
        method=profile['processing_domain'].get('work_method','')
        if method:
            result['prompt']+='\n\n领域工作方式（在已配置能力、任务范围与验收要求内执行）：\n'+method
    if profile.get('skill_packages'):
        from .skills import package_catalog
        result['available_skills']=package_catalog(profile)
    return result
