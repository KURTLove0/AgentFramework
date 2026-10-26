"""Loopback-only Web UI/API. Business actions still pass through the existing Runtime."""

import base64
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
import json
import logging
from pathlib import Path
import secrets
import shutil
import threading
import time
from urllib.parse import parse_qs, urlsplit, unquote

from . import __version__
from .contracts import Budget, LeaseBusy, LeaseLost, PolicyDenied, TERMINAL, TaskContract, canonical, identifier
from .llm import CodexConfig, LLMPlanner
from .mock_tools import SCENARIOS
from .runtime import CrashInjected, Runtime, registry_snapshot
from .runtime_config import ConfigConflict, RuntimeConfiguration
from .model_catalog import ModelCatalog
from .agents import AgentRegistry, agent_ref
from .structured import parse_json
from .workspaces import WorkspaceRegistry, DEFAULT_WORKSPACE


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


SCENARIO_LABELS = {
    "normal": ("正常流程", "完整执行变更评估、草稿创建与回读验收"),
    "response-lost": ("写入响应丢失", "写入已成功，通过幂等键核对并继续"),
    "crash-after-write": ("写后进程中断", "在保存回执前中断工作进程，可手动恢复"),
    "denied": ("缺少写入授权", "保留具体草稿提案，等待授权后继续"),
    "tampered-draft": ("草稿内容不一致", "回读发现内容变化，进入人工核对"),
    "read-transient": ("读取短暂失败", "有限退避重试后继续执行"),
    "read-fails": ("读取持续失败", "重试耗尽后停止，保留失败原因"),
    "unverifiable": ("无法核对写入", "写入结果不明且无法回读，停止再次创建"),
    "invalid-report": ("报告需要修正", "首次报告缺少章节，有限重规划修复"),
    "source-changed": ("变更版本更新", "条件写失败后重新读取并评估"),
    "missing-evidence": ("缺少测试证据", "停止生成报告并说明需要补充的材料"),
}
WAITING = {"WAITING_AUTH", "WAITING_INPUT", "NEEDS_REVIEW"}


class Application:
    def __init__(self, data_dir=".agent-data", tenant="tenant-demo", *, lease_seconds=3, tool_timeout=1, principal="demo-user"):
        self.data_dir = Path(data_dir).resolve()
        self.tenant = identifier(tenant)
        self.principal = identifier(principal)
        self.lease_seconds, self.tool_timeout = lease_seconds, tool_timeout
        self.runtime().store  # Initialize schema without starting any task or model call.
        self.configuration = RuntimeConfiguration(self.data_dir, self.tenant)
        self.models = ModelCatalog(self.data_dir, self.tenant)
        self.agents = AgentRegistry(self.data_dir, self.tenant, self.configuration, self.models)
        self.workspaces = WorkspaceRegistry(self.runtime().store,self.tenant)
        self.workspace = next(w for w in self.workspaces.list() if not w['deleted'])
        if self.workspace['id']!=DEFAULT_WORKSPACE:
            self.agents=AgentRegistry(self.data_dir,self.tenant,self.configuration,self.models,self.workspace['id'])
        self.token = secrets.token_urlsafe(32)
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="agent-web")
        self.lock = threading.RLock()
        self.jobs = {}
        self.closed = False
        from .workflows import schema as workflow_schema
        workflow_schema(self.runtime().store)
        from .workspace_scheduler import schema as scheduler_schema
        scheduler_schema(self.runtime().store)
        self.scheduler_stop = threading.Event()
        self.scheduler_thread = None

    def start_scheduler(self):
        with self.lock:
            if self.scheduler_thread or self.closed:
                return
            def loop():
                from .workspace_scheduler import tick
                while not self.scheduler_stop.is_set():
                    try:
                        with self.lock:
                            if self.closed:
                                break
                            tick(self)
                    except Exception:
                        logging.getLogger(__name__).exception('Workspace scheduler tick failed')
                    self.scheduler_stop.wait(15)
            self.scheduler_thread = threading.Thread(target=loop, name='workspace-scheduler', daemon=True)
            self.scheduler_thread.start()

    def runtime(self, planner=None):
        return Runtime(self.data_dir, planner=planner, lease_seconds=self.lease_seconds, tool_timeout=self.tool_timeout)

    def scoped(self, workspace_id):
        import copy
        app=copy.copy(self)
        app.workspace=self.workspaces.get(workspace_id)
        app.agents=AgentRegistry(self.data_dir,self.tenant,self.configuration,self.models,workspace_id)
        return app

    def library_access(self, project=None):
        from .knowledge import Access
        project=project or self.workspace['project_id']
        if project!=self.workspace['project_id']:raise PolicyDenied('project outside current workspace')
        # Local simulated identity policy. Request JSON cannot assign roles/principal.
        return Access(self.tenant,self.principal,identifier(project),roles=('curator','reviewer'))

    def library(self):
        from .knowledge import Library
        return Library(self.runtime().store)

    def skills(self):
        from .skills import SkillRegistry
        return SkillRegistry(self.runtime().store,self.tenant,self.workspace['id'])

    def workflows(self):
        from .workflows import Workflows
        return Workflows(self)

    def flow_detail(self,identity):
        flows=self.workflows();state=flows.run(identity);children={}
        for node,item in state['nodes'].items():
            if item['run_id']:
                try:
                    child=self.runtime().store.result(self.tenant,item['run_id']);self.assert_run_access(child)
                    children[node]={'run_id':child['run_id'],'status':child['status'],'checks':child['checks'],
                                    'required_check_count':len(child['task']['acceptance']),
                                    'draft_count':len(self.runtime().external.stats(self.tenant,child['run_id'])['drafts']),
                                    'pending':next((a for a in child['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0'),None)}
                except KeyError:pass
        return {'run':state,'children':children,'events':flows.events(identity),'job':self.job(identity)}

    def schedule_flow(self,identity):
        from .workflows import FLOW_TERMINAL
        flows=self.workflows();state=flows.run(identity)
        with self.lock:
            if self.closed:raise APIError(503,'服务正在关闭')
            if state['status'] in FLOW_TERMINAL:raise ConfigConflict('工作流已结束，请新建运行')
            if state['lease_active'] or self.jobs.get(identity,{}).get('active'):raise ConfigConflict('工作流正在执行')
            if sum(j['active'] for j in self.jobs.values())>=16:raise ConfigConflict('执行队列已满')
            job={'active':True,'state':'QUEUED','cancel':threading.Event(),'started_at':time.time(),'error':None}
            self.jobs[identity]=job
            def work():
                try:
                    job['state']='RUNNING';flows.execute(identity);job['state']='COMPLETED'
                except (LeaseBusy,LeaseLost):job.update(state='ERROR',error='任务租约尚未释放，请稍后恢复同一工作流。')
                except Exception as exc:job.update(state='ERROR',error=str(exc)[:300])
                finally:
                    with self.lock:job.update(active=False,ended_at=time.time())
            self.pool.submit(work)

    def model_info(self):
        try:
            config = CodexConfig.local()
            return {"available": bool(shutil.which("codex")), "model": config.model,
                    "reasoning_effort": config.reasoning_effort,
                    "note": "复用本机 Codex CLI 登录态；登录有效性会在执行时确认"}
        except (ValueError, OSError) as exc:
            return {"available": False, "model": None, "note": "请先配置并登录本机 Codex CLI"}

    def metadata(self):
        snapshot = registry_snapshot()
        from .definitions import capability_definitions, get_domain
        return {"csrf_token": self.token, "version": __version__, "tenant": self.tenant,"workspace":self.workspace,
                "model": self.model_info(), "agent": snapshot["agent"], "skill": snapshot["skill"],
                "domain_pack_ref": snapshot['compiled_agent']['domain_pack']['ref'],
                "compiled_agent_hash": snapshot['compiled_agent']['hash'],
                "capability_contracts": capability_definitions(),
                "domain_packs": [get_domain(ref).descriptor() for ref in ("change-assessment@2.0.0","knowledge-answer@1.0.0")],
                "scenarios": [{"id": key, "label": SCENARIO_LABELS[key][0], "description": SCENARIO_LABELS[key][1]} for key in SCENARIOS],
                "business_tools": "simulated", "max_workers": 4, "runtime_config": self.runtime_settings()}

    def runtime_settings(self):
        return {"settings": self.configuration.get(), "providers": self.configuration.catalog()}

    def assert_run_access(self, state):
        if state['task']['project_id']!=self.workspace['project_id']:raise PolicyDenied('run outside current workspace')
        # New contextual runs may contain private preferences, sources and episodes.
        # Historical runs retain their original tenant-workbench access semantics.
        if state['snapshot'].get('context_policy') and state['task']['principal']!=self.principal:
            raise PolicyDenied('run belongs to another principal')

    def job(self, run_id):
        with self.lock:
            job = self.jobs.get(run_id)
            return {k: v for k, v in job.items() if k != "cancel"} if job else None

    def lease(self, run_id):
        with self.runtime().store.connect() as db:
            row = db.execute("SELECT lease_until,owner FROM runs WHERE tenant_id=? AND id=?", (self.tenant, run_id)).fetchone()
        return {"active": bool(row and row["owner"] and row["lease_until"] > time.time()),
                "until": row["lease_until"] if row else 0}

    def summary(self, state):
        job = self.job(state["run_id"])
        return {k: state[k] for k in ("run_id", "status", "created_at", "deadline", "steps", "replans", "scenario", "last_error")} | {
            "goal": state["task"]["goal"], "change_id": state["task"]["change_id"],
            "project_id": state["task"]["project_id"], "planner_ref": state["snapshot"]["planner_ref"],
            "domain_pack_ref": state["task"]["domain_pack_ref"], "source_run_id": state["task"].get("source_run_id"),
            "updated_at": state.get("updated_at", state["created_at"]),
            "agent_id": state["snapshot"].get("agent_profile", {}).get("id"),
            "agent_name": state["snapshot"].get("agent_profile", {}).get("name") or state["snapshot"].get("agent", {}).get("identity", {}).get("name"),
            "agent_revision": state["snapshot"].get("agent_profile", {}).get("revision"),
            "model": state["snapshot"].get("planner", {}).get("config", {}).get("model"),
            "risk_level": (state["report"] or {}).get("risk_level"), "draft": state["draft"],
            "model_calls": state.get("model_calls", 0), "model_tokens": state.get("model_tokens", 0), "job": job}

    def accessible_run_states(self):
        store = self.runtime().store
        with store.connect() as db:
            rows = db.execute("SELECT state FROM runs WHERE tenant_id=? ORDER BY rowid DESC", (self.tenant,)).fetchall()
        states = [json.loads(row[0]) for row in rows]
        return [s for s in states if s['task']['project_id']==self.workspace['project_id'] and (not s['snapshot'].get('context_policy') or s['task']['principal']==self.principal)]

    def runs(self, params=None):
        params = params or {}
        def option(name, default=None):
            value = params.get(name, default)
            return value[0] if isinstance(value, list) else value
        states = self.accessible_run_states()
        counts = {"total": len(states), "running": 0, "waiting": 0, "succeeded": 0}
        for state in states:
            job = self.job(state["run_id"])
            counts["running"] += bool(job and job["active"]) or state["status"] in {"RUNNING", "RECONCILING", "VERIFYING"}
            counts["waiting"] += state["status"] in WAITING
            counts["succeeded"] += state["status"] == "SUCCEEDED"
        search = str(option('search', '') or '').strip().lower()
        status = option('status', 'all')
        agent = option('agent_id', '')
        domain = option('domain', '')
        if search:
            states = [s for s in states if search in ' '.join(str(v) for v in (
                s['task']['goal'], s['task']['change_id'], s['run_id'], s['scenario'],
                SCENARIO_LABELS.get(s['scenario'], ('', ''))[0],
                s['snapshot'].get('agent_profile', {}).get('name', ''))).lower()]
        if status == 'group:running':
            states = [s for s in states if (self.job(s['run_id']) or {}).get('active') or s['status'] in {'RUNNING','RECONCILING','VERIFYING'}]
        elif status == 'group:waiting':
            states = [s for s in states if s['status'] in WAITING]
        elif status and status != 'all':
            states = [s for s in states if s['status'] == status]
        if agent:
            states = [s for s in states if s['snapshot'].get('agent_profile', {}).get('id') == agent]
        if domain:
            states = [s for s in states if s['task']['domain_pack_ref'] == domain]
        after, before = option('created_after'), option('created_before')
        if after not in (None, ''):
            after = float(after);states = [s for s in states if s['created_at'] >= after]
        if before not in (None, ''):
            before = float(before);states = [s for s in states if s['created_at'] < before]
        sort = option('sort', 'created_desc')
        if sort not in {'created_desc','created_asc','updated_desc','updated_asc'}:
            raise ValueError('不支持的运行排序')
        field = 'created_at' if sort.startswith('created') else 'updated_at'
        states.sort(key=lambda s:(s.get(field, s['created_at']),s['run_id']),reverse=sort.endswith('_desc'))
        filtered_total = len(states)
        cursor = option('cursor')
        if cursor:
            try:
                cursor_id = base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)).decode()
                identifier(cursor_id)
                position = next(i for i,s in enumerate(states) if s['run_id'] == cursor_id)
            except Exception as exc:
                raise ValueError('运行分页游标无效或已变化，请返回第一页') from exc
            states = states[position + 1:]
        raw_limit = option('limit')
        limit = 200 if raw_limit in (None, '') else int(raw_limit)
        if not 1 <= limit <= 200:
            raise ValueError('运行分页大小须为 1–200')
        page, has_more = states[:limit], len(states) > limit
        next_cursor = base64.urlsafe_b64encode(page[-1]['run_id'].encode()).decode().rstrip('=') if has_more and page else None
        return {"runs": [self.summary(s) for s in page], "counts": counts, "limit": limit,
                "filtered_total": filtered_total, "next_cursor": next_cursor, "sort": sort}

    def attention(self):
        kinds = {'CREATED':'start','WAITING_AUTH':'auth','WAITING_INPUT':'input','NEEDS_REVIEW':'review','FAILED':'failed','EXPIRED':'expired'}
        tasks = []
        for state in self.accessible_run_states():
            status, job = state['status'], self.job(state['run_id'])
            kind = kinds.get(status)
            resumable = status in {'CREATED','RUNNING','RECONCILING','VERIFYING'} and not (job and job['active']) and not self.lease(state['run_id'])['active']
            if status == 'CREATED' and not resumable:
                kind = None
            elif not kind and status in {'RUNNING','RECONCILING','VERIFYING'} and resumable:
                kind = 'resume'
            if kind and (status != 'CREATED' or resumable):
                tasks.append(self.summary(state) | {'attention_kind':kind})
        tasks.sort(key=lambda s:(s['deadline'],s['created_at'],s['run_id']))
        flow_kinds = {'WAITING_AUTH':'auth','WAITING_INPUT':'input','INTERRUPTED':'resume','PAUSED':'resume','NEEDS_REVIEW':'review','FAILED':'failed','EXPIRED':'expired'}
        flows = [dict(r,attention_kind=flow_kinds[r['status']]) for r in self.workflows().runs() if r['status'] in flow_kinds]
        flows.sort(key=lambda r:(r.get('deadline') or float('inf'),r.get('created_at') or 0,r['id']))
        from .workspace_scheduler import WorkspaceScheduler
        daily = WorkspaceScheduler(self).overview()
        plans = [p for p in daily['plans'] if p['day'] == daily['today'] and any(i['status'] == 'BLOCKED' for i in p['items'])]
        with self.runtime().store.connect() as db:
            alerts = db.execute('SELECT COUNT(*) FROM agent_alerts WHERE tenant=? AND project=? AND principal=? AND acknowledged IS NULL',
                                (self.tenant,self.workspace['project_id'],self.principal)).fetchone()[0]
        return {'tasks':tasks,'workflow_runs':flows,'daily_plans':plans,
                'counts':{'total':len(tasks)+len(flows)+len(plans),'tasks':len(tasks),'workflows':len(flows),'daily':len(plans)},'open_alert_count':alerts}

    def task_draft(self):
        with self.runtime().store.connect() as db:
            row = db.execute('SELECT revision,data,updated FROM task_drafts WHERE tenant=? AND workspace=? AND principal=?',
                             (self.tenant,self.workspace['id'],self.principal)).fetchone()
        return {'draft':json.loads(row['data']) if row else None,'revision':row['revision'] if row else 0,'updated_at':row['updated'] if row else None}

    def save_task_draft(self, data):
        allowed = {'domain_pack_ref','goal','change_id','agent_id','planner','max_steps','max_wall_seconds','step','source_run_id'}
        if not isinstance(data,dict) or set(data) != {'revision','draft'} or type(data['revision']) is not int or not isinstance(data['draft'],dict):
            raise ValueError('任务草稿需要 revision 和 draft')
        source = data['draft']
        if set(source) - allowed:
            raise ValueError('任务草稿包含不支持或许可字段')
        for key in {'goal','change_id','agent_id','source_run_id'} & set(source):
            if not isinstance(source[key],str) or len(source[key]) > (2000 if key == 'goal' else 100):
                raise ValueError('任务草稿文本字段无效')
        if source.get('domain_pack_ref') not in {None,'change-assessment@2.0.0','knowledge-answer@1.0.0'}:
            raise ValueError('任务草稿领域无效')
        if source.get('planner') not in {None,'mock','codex','cursor'}:
            raise ValueError('任务草稿运行时无效')
        if source.get('agent_id'):
            identifier(source['agent_id'])
        if source.get('source_run_id'):
            identifier(source['source_run_id'])
        if 'step' in source and (type(source['step']) is not int or not 0 <= source['step'] <= 2):
            raise ValueError('任务草稿步骤无效')
        for key,maximum in (('max_steps',100),('max_wall_seconds',3600)):
            if key in source and (type(source[key]) is not int or not 1 <= source[key] <= maximum):
                raise ValueError('任务草稿预算无效')
        clean = {key:source[key] for key in allowed if key in source}
        now = time.time()
        with self.runtime().store.transaction() as db:
            row = db.execute('SELECT revision FROM task_drafts WHERE tenant=? AND workspace=? AND principal=?',
                             (self.tenant,self.workspace['id'],self.principal)).fetchone()
            current = row['revision'] if row else 0
            if current != data['revision']:
                raise ConfigConflict('任务草稿已在其他页面更新，请重新读取')
            revision = current + 1
            db.execute('INSERT OR REPLACE INTO task_drafts VALUES(?,?,?,?,?,?)',
                       (self.tenant,self.workspace['id'],self.principal,revision,canonical(clean),now))
        return {'draft':clean,'revision':revision,'updated_at':now}

    def discard_task_draft(self):
        with self.runtime().store.transaction() as db:
            db.execute('DELETE FROM task_drafts WHERE tenant=? AND workspace=? AND principal=?',
                       (self.tenant,self.workspace['id'],self.principal))
        return {'draft':None,'revision':0,'updated_at':None}

    def detail(self, run_id):
        identifier(run_id)
        # Sample job completion before reading its durable result. Otherwise a worker
        # can finish between these reads and pair a stale state with active=False.
        job = self.job(run_id)
        runtime = self.runtime()
        result = runtime.store.result(self.tenant, run_id)
        self.assert_run_access(result)
        grant = runtime.store.get_grant(result)
        grant_valid = bool(grant and not grant["revoked"] and grant["expires_at"] > time.time())
        return {"run": result, "events": runtime.store.events(self.tenant, run_id),
                "evidence": runtime.store.evidence(result), "external": runtime.external.stats(self.tenant, run_id),
                "context_manifests": runtime.store.contexts(self.tenant,run_id) if result['task']['principal']==self.principal else [],
                "job": job, "lease": self.lease(run_id),
                "grant": {"valid": grant_valid, "expires_at": grant["expires_at"] if grant else None}}

    def create(self, data, *, run_id=None):
        with self.lock:
            self.workspace=self.workspaces.get(self.workspace['id'])
            return self._create(data, run_id=run_id)

    def _create(self, data, *, run_id=None):
        allowed = {"goal", "change_id", "project_id", "domain_pack_ref", "planner", "runtime", "runtime_revision", "agent_id", "agent_revision", "mcp_consent", "scenario", "grant", "consent", "budget", "start", "source_run_id", "clear_draft"}
        if not isinstance(data, dict) or set(data) - allowed:
            raise ValueError("任务包含不支持的字段")
        if data.get('project_id',self.workspace['project_id'])!=self.workspace['project_id']:raise PolicyDenied('project outside current workspace')
        for name in ("grant", "consent", "mcp_consent", "start", "clear_draft"):
            if name in data and type(data[name]) is not bool:
                raise ValueError(name + " 必须为布尔值")
        if "runtime" in data and "planner" in data and data['runtime'] != data['planner']:
            raise ValueError("运行时与规划器选择不一致")
        settings = self.configuration.get()
        profile = self.agents.get(identifier(data['agent_id'])) if data.get('agent_id') else None
        if profile:self.agents.assert_skills_available(profile)
        if profile:
            if profile['archived']:
                raise ValueError('Agent 已归档')
            if type(data.get('agent_revision')) is not int or data['agent_revision'] != profile['revision']:
                raise ConfigConflict('Agent 已更新，请重新打开新建任务窗口')
            if (any(s['enabled'] for s in profile['mcp_servers']) or (profile.get('definition') or {}).get('native_read_refs')) and data.get('mcp_consent') is not True:
                raise APIError(400, '请确认允许启动此 Agent 配置的 MCP 服务并调用白名单工具')
        if 'runtime_revision' in data and not profile:
            if type(data['runtime_revision']) is not int:
                raise ValueError('运行时配置版本无效')
            if data['runtime_revision'] != settings['revision']:
                raise ConfigConflict('运行时配置已更新，请重新打开新建任务窗口')
        planner_name = profile['runtime'] if profile else data.get("runtime", data.get("planner", settings['default_runtime']))
        if profile and any(data.get(k, planner_name) != planner_name for k in ('runtime','planner')):
            raise ValueError('任务运行时与所选 Agent 不一致')
        if planner_name not in {"mock", "codex", "cursor"}:
            raise ValueError("不支持的规划器")
        goal = data.get("goal", "评估指定变更并创建一份评估草稿")
        if not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 2000:
            raise ValueError("任务说明须为 1–2000 个字符")
        if planner_name != "mock" and data.get("consent") is not True:
            raise APIError(400, "使用真实模型前，请确认允许发送任务和模拟工具证据")
        planner = self.agents.planner(profile) if profile else self.configuration.planner(planner_name, settings)
        if not isinstance(data.get("budget", {}), dict):
            raise ValueError("budget 必须为对象")
        budget = {"max_wall_seconds": 600 if planner else 120, **data.get("budget", {})}
        domain_ref=(profile.get('definition') or {}).get('domain_pack_ref','change-assessment@2.0.0') if profile else data.get('domain_pack_ref','change-assessment@2.0.0')
        if profile and data.get('domain_pack_ref',domain_ref)!=domain_ref:raise ValueError('domain differs from selected Agent')
        source_run_id = data.get('source_run_id')
        if source_run_id:
            identifier(source_run_id)
            self.assert_run_access(self.runtime().store.load(self.tenant,source_run_id))
        task = TaskContract(domain_pack_ref=domain_ref,goal=goal.strip(), change_id=data.get("change_id", "change-demo-001"),
                            project_id=self.workspace['project_id'], tenant_id=self.tenant,
                            principal=self.principal, agent_ref=agent_ref(profile) if profile else 'release-assistant@1.0.0', budget=Budget(**budget), source_run_id=source_run_id)
        runtime = self.runtime(planner)
        state = runtime.submit(task, scenario=data.get("scenario", "normal"), grant=data.get("grant", True), agent_profile=profile, run_id=run_id)
        lease = runtime.store.acquire(self.tenant, state["run_id"], self.lease_seconds)
        try:
            runtime.checkpoint(state, lease, 'runtime.config_selected', {'provider': planner_name, 'revision': settings['revision']})
            if profile:
                runtime.checkpoint(state, lease, 'agent.selected', {'id':profile['id'],'revision':profile['revision'], 'mcp_consented':data.get('mcp_consent',False)})
            if planner_name != "mock":
                runtime.checkpoint(state, lease, "model.sharing_consented", {"source": "webui", "scope": "task-simulated-evidence-and-scoped-library"})
        finally:
            runtime.store.release(state, lease)
        if data.get("start", True):
            self.schedule(state["run_id"])
        result = self.detail(state["run_id"])
        if data.get('clear_draft'):
            self.discard_task_draft()
        return result

    def schedule(self, run_id):
        identifier(run_id)
        state = self.runtime().store.load(self.tenant, run_id)
        self.assert_run_access(state)
        if state["status"] in TERMINAL:
            raise APIError(409, "运行已结束；可以查看结果或创建新的任务")
        if state["status"] == "WAITING_INPUT" and not state["snapshot"].get("context_policy"):
            raise APIError(409, "请补充或修复来源后创建新任务；此版本暂不支持在线追加材料")
        with self.lock:
            if self.closed:
                raise APIError(503, "服务正在关闭")
            if self.jobs.get(run_id, {}).get("active") or self.lease(run_id)["active"]:
                raise APIError(409, "运行仍由工作进程持有，请等待当前动作或租约结束")
            if sum(j["active"] for j in self.jobs.values()) >= 16:
                raise APIError(429, "执行队列已满，请等待已有任务结束")
            job = {"active": True, "state": "QUEUED", "cancel_requested": False,
                   "cancel": threading.Event(), "started_at": time.time(), "error": None}
            self.jobs[run_id] = job
            self.pool.submit(self._work, run_id, job)

    def _work(self, run_id, job):
        with self.lock:
            job["state"] = "RUNNING"
        runtime = self.runtime()
        try:
            while True:
                if job["cancel"].is_set():
                    runtime.cancel(run_id, self.tenant)
                    break
                result = runtime.run(run_id, self.tenant, pause_after=1)
                if result["status"] in TERMINAL | {"WAITING_AUTH", "WAITING_INPUT"}:
                    break
            with self.lock:
                job["state"] = "COMPLETED"
        except CrashInjected:
            with self.lock:
                job["state"], job["error"] = "CRASHED", "已模拟写后进程中断；租约到期后可恢复核对"
        except (LeaseBusy, LeaseLost):
            with self.lock:
                job["state"], job["error"] = "ERROR", "运行租约暂不可用，请刷新后重试"
        except Exception as exc:
            with self.lock:
                job["state"], job["error"] = "ERROR", "工作进程退出：" + type(exc).__name__
        finally:
            with self.lock:
                job["active"] = False
                job["ended_at"] = time.time()

    def mutate(self, run_id, action):
        identifier(run_id)
        runtime = self.runtime()
        state = runtime.store.load(self.tenant, run_id)
        self.assert_run_access(state)
        if action == "cancel":
            with self.lock:
                job = self.jobs.get(run_id)
                if job and job["active"]:
                    job["cancel_requested"] = True
                    job["cancel"].set()
                    return self.detail(run_id)
            runtime.cancel(run_id, self.tenant)
        elif action == "resume":
            self.schedule(run_id)
        elif action in {"grant", "revoke"}:
            if state["status"] in TERMINAL:
                raise APIError(409, "运行已结束，不能修改授权")
            pending = next((a for a in runtime.store.actions(state) if a["status"] == "PREPARED" and a["tool_ref"].startswith("report.draft.create")), None)
            if action == "grant" and (state["status"] != "WAITING_AUTH" or not pending):
                raise APIError(409, "当前没有等待授权的具体草稿提案")
            runtime.store.grant(state, pending["args_hash"] if pending else None, revoke=action == "revoke")
            if action == "grant":
                self.schedule(run_id)
        else:
            raise APIError(404, "未找到该操作")
        return self.detail(run_id)

    def close(self):
        self.scheduler_stop.set()
        with self.lock:
            self.closed = True
            for job in self.jobs.values():
                if job["active"]:
                    job["cancel"].set()
        if self.scheduler_thread:
            self.scheduler_thread.join(timeout=5)
        self.pool.shutdown(wait=True, cancel_futures=False)


class WebServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, application):
        if address[0] not in {"127.0.0.1", "localhost"}:
            raise ValueError("Web UI 仅支持本机回环地址")
        self.application = application
        super().__init__(address, Handler)
        application.start_scheduler()


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentFramework"

    def log_message(self, format, *args):
        pass

    def reply(self, status, body, content_type="application/json; charset=utf-8", filename=None):
        payload = json.dumps(body, ensure_ascii=False).encode() if content_type.startswith("application/json") else body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if filename:
            from urllib.parse import quote
            safe=filename.encode('ascii','ignore').decode().replace('"','').replace('\r','').replace('\n','') or 'download'
            self.send_header("Content-Disposition", f'attachment; filename="{safe}"; filename*=UTF-8\'\'{quote(filename)}')
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guard(self, mutation=False):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        if host not in hosts:
            raise APIError(403, "仅允许本机地址访问")
        origin = self.headers.get("Origin")
        if origin and origin not in {"http://" + h for h in hosts}:
            raise APIError(403, "不允许跨站访问此控制台")
        if mutation:
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise APIError(415, "请使用 JSON 请求")
            if not secrets.compare_digest(self.headers.get("X-Agent-Token", ""), self.server.application.token):
                raise APIError(403, "页面会话已失效，请刷新后重试")

    def dispatch(self, mutation=False):
        request_lock=self.server.application.lock if mutation else None
        if request_lock:request_lock.acquire()
        try:
            self.guard(mutation)
            app = self.server.application
            path = urlsplit(self.path).path
            query = parse_qs(urlsplit(self.path).query)
            data = None
            if mutation:
                length = int(self.headers.get("Content-Length", "0"))
                limit=1_500_000 if path.startswith('/api/skills') or path.startswith('/api/agents') else 500000 if path.startswith(('/api/learning-proposals','/api/ontologies','/api/ontology-validate')) else 65536
                if not 0 < length <= limit:
                    raise APIError(413, "请求超过该接口的大小预算")
                data = parse_json(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("请求必须为 JSON 对象")
            assets = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/agents.js": ("agents.js", "text/javascript; charset=utf-8"),
                      "/form_controls.js": ("form_controls.js", "text/javascript; charset=utf-8"),
                      "/agent_experience.js": ("agent_experience.js", "text/javascript; charset=utf-8"),
                      "/library.js": ("library.js", "text/javascript; charset=utf-8"),
                      "/workspaces.js": ("workspaces.js", "text/javascript; charset=utf-8"),
                      "/roles.js": ("roles.js", "text/javascript; charset=utf-8"),
                      "/agent_domains.js": ("agent_domains.js", "text/javascript; charset=utf-8"),
                      "/workflows.js": ("workflows.js", "text/javascript; charset=utf-8"),
                      "/workflow_designer.js": ("workflow_designer.js", "text/javascript; charset=utf-8"),
                      "/skills.js": ("skills.js", "text/javascript; charset=utf-8"),
                      "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                      "/hig.css": ("hig.css", "text/css; charset=utf-8"),
                      "/agents.css": ("agents.css", "text/css; charset=utf-8"),
                      "/form_controls.css": ("form_controls.css", "text/css; charset=utf-8"),
                      "/appearance.js": ("appearance.js", "text/javascript; charset=utf-8"),
                      "/journeys.js": ("journeys.js", "text/javascript; charset=utf-8"),
                      "/learning.js": ("learning.js", "text/javascript; charset=utf-8"),
                      "/operations.js": ("operations.js", "text/javascript; charset=utf-8"),
                      "/ontology_model.js": ("ontology_model.js", "text/javascript; charset=utf-8"),
                      "/operations.css": ("operations.css", "text/css; charset=utf-8"),
                      "/space-grotesk.ttf": ("space-grotesk.ttf", "font/ttf")}
            if not mutation and path in assets:
                name, content_type = assets[path]
                return self.reply(200, files("agent_framework").joinpath("webui", name).read_bytes(), content_type)
            if path=='/api/workspaces':
                return self.reply(201,app.workspaces.save(data)) if mutation else self.reply(200,{'workspaces':app.workspaces.list()})
            space_path=path.strip('/').split('/')
            if len(space_path) in (3,4) and space_path[:2]==['api','workspaces']:
                identity=identifier(space_path[2])
                if len(space_path)==3:
                    return self.reply(200,app.workspaces.save(data,identity)) if mutation else self.reply(200,app.workspaces.get(identity,True))
                if mutation and space_path[3] in ('delete','restore'):
                    if set(data)!={'revision'}:raise ValueError('工作空间操作需要当前版本')
                    return self.reply(200,app.workspaces.lifecycle(identity,data['revision'],space_path[3]=='delete'))
            selected=self.headers.get('X-Agent-Workspace') or query.get('workspace_id',[None])[0]
            if path.startswith('/api/'):
                if not selected:selected=next(w['id'] for w in app.workspaces.list() if not w['deleted'])
                app=app.scoped(selected)
            if path == "/api/session" and not mutation:
                return self.reply(200, app.metadata())
            if path == '/api/workspace-schedule':
                from .workspace_scheduler import WorkspaceScheduler
                service = WorkspaceScheduler(app)
                return self.reply(200, service.save(data)) if mutation else self.reply(200, service.overview())
            if path == '/api/daily-plans/generate' and mutation:
                from .workspace_scheduler import WorkspaceScheduler
                if data:raise ValueError('生成每日计划不接受额外字段')
                return self.reply(200, WorkspaceScheduler(app).generate())
            operations_path = path.strip('/').split('/')
            if len(operations_path) == 4 and operations_path[:2] == ['api', 'daily-plans'] and operations_path[3] == 'dispatch' and mutation:
                from .workspace_scheduler import WorkspaceScheduler
                if data:raise ValueError('派发每日计划不接受额外字段')
                return self.reply(200, WorkspaceScheduler(app).dispatch(identifier(operations_path[2])))
            if path == '/api/agent-evaluations' and not mutation:
                from .agent_evaluation import AgentEvaluations
                return self.reply(200, AgentEvaluations(app).overview())
            if path == '/api/operation-status' and not mutation:
                with app.runtime().store.connect() as db:
                    count = db.execute('SELECT COUNT(*) FROM agent_alerts WHERE tenant=? AND project=? AND principal=? AND acknowledged IS NULL',
                                       (app.tenant, app.workspace['project_id'], app.principal)).fetchone()[0]
                return self.reply(200, {'open_alert_count': count})
            if path == '/api/attention' and not mutation:
                return self.reply(200,app.attention())
            if path == '/api/task-draft':
                return self.reply(200,app.save_task_draft(data)) if mutation else self.reply(200,app.task_draft())
            if path == '/api/task-draft/discard' and mutation:
                if data:raise ValueError('放弃任务草稿不接受额外字段')
                return self.reply(200,app.discard_task_draft())
            if path == '/api/agent-evaluations/evaluate' and mutation:
                from .agent_evaluation import AgentEvaluations
                if set(data) - {'run_id'}:raise ValueError('评测参数无效')
                return self.reply(200, AgentEvaluations(app).evaluate(data.get('run_id')))
            if len(operations_path) == 3 and operations_path[:2] == ['api', 'agent-evaluations'] and not mutation:
                from .agent_evaluation import AgentEvaluations
                return self.reply(200, AgentEvaluations(app).get(identifier(operations_path[2])))
            if path == '/api/evaluation-policy' and mutation:
                from .agent_evaluation import AgentEvaluations
                return self.reply(200, AgentEvaluations(app).save_policy(data))
            if len(operations_path) == 4 and operations_path[:2] == ['api', 'agent-alerts'] and operations_path[3] == 'acknowledge' and mutation:
                from .agent_evaluation import AgentEvaluations
                if data:raise ValueError('确认提醒不接受额外字段')
                return self.reply(200, AgentEvaluations(app).acknowledge(identifier(operations_path[2])))
            if path=='/api/knowledge-hub' and not mutation:
                from .knowledge_hub import hub
                return self.reply(200,hub(app,query.get('query',[''])[0]))
            if path=='/api/learning-proposals':
                from .learning import Learning
                learning=Learning(app)
                return self.reply(201,learning.generate(data)) if mutation else self.reply(200,{'proposals':learning.list(query.get('run_id',[None])[0],query.get('purpose',[None])[0])})
            learning_path=path.strip('/').split('/')
            if len(learning_path)==4 and learning_path[:3]==['api','learning','run'] and not mutation:
                from .learning import Learning
                return self.reply(200,Learning(app).run_context(identifier(learning_path[3])))
            if len(learning_path) in (3,4) and learning_path[:2]==['api','learning-proposals']:
                from .learning import Learning
                service=Learning(app);identity=identifier(learning_path[2])
                if len(learning_path)==3:
                    return self.reply(200,service.save(identity,data)) if mutation else self.reply(200,service.get(identity))
                if mutation and learning_path[3]=='deposit':return self.reply(200,service.deposit(identity,data))
            if path=='/api/ontology-search' and not mutation:
                from .ontology import expand
                return self.reply(200,expand(app.library(),app.library_access(),query.get('query',[''])[0],
                                           max_hops=int(query.get('max_hops',['2'])[0]),predicates=query.get('predicate')))
            if path=='/api/ontology-validate' and mutation:
                from .ontology import source_context
                from .ontology_model import validation_report
                if set(data)!={'content','source_refs'}:raise ValueError('本体校验需要 content 和 source_refs')
                context=source_context(app.library(),app.library_access(),data['source_refs'])
                return self.reply(200,validation_report(data['content'],{s['ref'] for s in context['sources']}))
            if len(learning_path)==4 and learning_path[:2]==['api','ontologies']:
                from .ontology import revise,export_jsonld
                ref=unquote(learning_path[2]);asset=app.library().get(app.library_access(),ref)
                if asset['kind']!='ONTOLOGY':raise ValueError('不是本体资料')
                if mutation and learning_path[3]=='revise':return self.reply(201,revise(app.library(),app.library_access(),ref,data))
                if not mutation and learning_path[3]=='export':return self.reply(200,json.dumps(export_jsonld(asset),ensure_ascii=False),'application/ld+json; charset=utf-8','ontology.jsonld')
                if not mutation and learning_path[3]=='validate':
                    from .ontology_model import validation_report
                    from .ontology import sources_current
                    report=validation_report(asset['content'],{s['ref'] for s in asset['provenance']['sources']})
                    report['sources_current']=sources_current(app.library(),app.library_access(),asset)
                    if not report['sources_current']:
                        report['conforms']=False
                        report['results'].append({'focus_node':asset['ref'],'path':'source_refs','constraint':'SourceCurrentConstraint','severity':'Violation','message':'来源已撤回、过期、变化或不再可访问','value':None})
                    return self.reply(200,report)
                if not mutation and learning_path[3]=='objects':
                    from .ontology_model import object_set
                    return self.reply(200,object_set(app.library(),app.library_access(),asset,query.get('query',[''])[0],query.get('type_id',[None])[0],int(query.get('limit',['50'])[0])))
                if mutation and learning_path[3]=='action-preview':
                    from .ontology_model import object_set
                    if set(data)!={'action_id','object_id','agent_id','agent_revision'}:raise ValueError('请选择动作、对象和岗位版本')
                    object_set(app.library(),app.library_access(),asset)
                    model=asset['content'].get('model',{})
                    action=next((a for a in model.get('action_types',[]) if a['id']==data['action_id']),None)
                    instance=next((o for o in model.get('objects',[]) if o['id']==data['object_id']),None)
                    if not action or not instance or instance['type_id']!=action['target_type']:raise ValueError('动作与对象类型不匹配')
                    compiled=app.agents.compile(identifier(data['agent_id']),data['agent_revision'])
                    from .definitions import capability_definitions
                    capability=capability_definitions()[action['capability_ref']]
                    return self.reply(200,{'action':action,'object':instance,'agent_ref':compiled['ref'],
                                          'available_to_agent':action['capability_ref'] in compiled['capabilities'],
                                          'effect':capability['effect'],'input_schema':capability['input_schema'],
                                          'requires_task_authorization':capability['effect']=='WRITE','executed':False})
            if len(learning_path)==4 and learning_path[:2]==['api','capability-methods'] and learning_path[3]=='skill' and not mutation:
                from .learning import capability_skill_zip
                asset=app.library().get(app.library_access(),unquote(learning_path[2]))
                return self.reply(200,capability_skill_zip(asset),'application/zip','capability-method.zip')
            if path=='/api/skills':
                return self.reply(201,app.skills().save(data)) if mutation else self.reply(200,{'skills':app.skills().list(),'specification':'https://agentskills.io/specification'})
            if path=='/api/skills/validate' and mutation:
                from .skills import normalize_package
                if set(data)!={'folder','files'}:raise ValueError('校验需要 folder 和 files')
                package,warnings=normalize_package(data['folder'],data['files'])
                return self.reply(200,{'valid':True,'metadata':package['metadata'],'hash':package['hash'],'warnings':warnings})
            if path=='/api/skills/import' and mutation:
                from .skills import import_zip
                if set(data)!={'zip_base64','revision','skill_id'}:raise ValueError('导入参数无效')
                folder,entries=import_zip(data['zip_base64'])
                return self.reply(201,app.skills().save({'folder':folder,'files':entries,'revision':data['revision']},data['skill_id'] or None))
            if path=='/api/skills/migrate' and mutation:
                from .contracts import digest
                if set(data)!={'agent_id','agent_revision','index'} or type(data['index']) is not int:raise ValueError('请选择历史内联 Skill')
                p=app.agents.get(identifier(data['agent_id']))
                if p['revision']!=data['agent_revision']:raise ConfigConflict('Agent 已更新')
                if not 0<=data['index']<len(p['skills']):raise ValueError('历史 Skill 不存在')
                legacy=p['skills'][data['index']];name='migrated-method-'+digest(legacy)[:12];registry=app.skills()
                found=next((s for s in registry.list() if s['name']==name),None)
                if found:return self.reply(200,registry.get(found['id']))
                content='---\nname: '+name+'\ndescription: '+json.dumps('迁移自内联方法「'+legacy['name']+'」，用于该方法涉及的任务；请进一步完善适用条件。',ensure_ascii=False)+'\n---\n\n'+legacy['instructions']+'\n'
                skill=registry.save({'folder':name,'files':{'SKILL.md':{'encoding':'utf-8','content':content}},'revision':0})
                return self.reply(201,skill)
            skill_path=path.strip('/').split('/')
            if len(skill_path) in (3,4) and skill_path[:2]==['api','skills']:
                identity=identifier(skill_path[2]);version=query.get('version',[None])[0];version=int(version) if version is not None else None
                registry=app.skills()
                if len(skill_path)==3:return self.reply(200,registry.save(data,identity)) if mutation else self.reply(200,registry.get(identity,version))
                op=skill_path[3]
                if op=='export' and not mutation:
                    from .skills import export_zip
                    skill=registry.get(identity,version)
                    return self.reply(200,export_zip(skill['package']),'application/zip',skill['name']+'.zip')
                if op=='events' and not mutation:return self.reply(200,{'events':registry.events(identity)})
                if mutation and op in ('publish','withdraw','archive','restore'):
                    if set(data)!={'revision','version'}:raise ValueError('Skill 操作需要 revision 和 version')
                    return self.reply(200,registry.lifecycle(identity,data['revision'],op,data['version']))
            if path=='/api/workflows':
                return self.reply(201,app.workflows().save(data)) if mutation else self.reply(200,{'workflows':app.workflows().list(),'runs':app.workflows().runs()})
            if path=='/api/workflow-chat':
                from .workflow_chat import WorkflowChat
                return self.reply(200,WorkflowChat(app).reply(data)) if mutation else self.reply(200,{'conversations':WorkflowChat(app).list()})
            route=path.strip('/').split('/')
            if len(route)==3 and route[:2]==['api','workflow-chat'] and not mutation:
                from .workflow_chat import WorkflowChat
                return self.reply(200,WorkflowChat(app).get(identifier(route[2])))
            if len(route) in (3,4) and route[:2]==['api','workflows']:
                flows=app.workflows();identity=identifier(route[2])
                if len(route)==3:return self.reply(200,flows.save(data,identity)) if mutation else self.reply(200,flows.get(identity))
                if mutation and route[3]=='archive':
                    if set(data)!={'revision','archived'}:raise ValueError('归档字段无效')
                    return self.reply(200,flows.archive(identity,data['revision'],data['archived']))
                if mutation and route[3]=='start':
                    run=flows.start(identity,data)
                    if run['status'] not in {'SUCCEEDED','FAILED','NEEDS_REVIEW','CANCELLED','EXPIRED'} and not app.job(run['id']) and not run['lease_active']:app.schedule_flow(run['id'])
                    return self.reply(202,app.flow_detail(run['id']))
            if len(route) in (3,4) and route[:2]==['api','workflow-runs']:
                identity=identifier(route[2]);flows=app.workflows()
                if not mutation and len(route)==3:return self.reply(200,app.flow_detail(identity))
                if mutation and len(route)==4:
                    if route[3]=='grant':
                        if set(data)!={'node_id'}:raise ValueError('请选择待授权节点')
                        flows.grant(identity,data['node_id']);app.schedule_flow(identity)
                    elif route[3]=='resume':
                        if data:raise ValueError('恢复不接受额外字段')
                        app.schedule_flow(identity)
                    elif route[3]=='cancel':
                        if data:raise ValueError('取消不接受额外字段')
                        flows.cancel(identity)
                        if not app.job(identity) or not app.job(identity)['active']:app.schedule_flow(identity)
                    else:raise ValueError('未知工作流操作')
                    return self.reply(202,app.flow_detail(identity))
            if path == "/api/runtime-config":
                if mutation:
                    app.configuration.save(data)
                return self.reply(200, app.runtime_settings())
            if path == "/api/runtime-config/detect" and mutation:
                if set(data) != {"provider"} or not isinstance(data['provider'], str):
                    raise ValueError("请指定要检测的运行时")
                return self.reply(200, app.configuration.detect(data['provider']))
            if path == '/api/runtime-config/models' and not mutation:
                return self.reply(200, app.models.list(query.get('provider',[''])[0], query.get('refresh',['0'])[0]=='1'))
            if path in ('/api/capabilities', '/api/standards', '/api/domain-packs', '/api/agent-definition-default') and not mutation:
                from .definitions import capability_definitions, DOMAIN, STANDARDS, default_definition, get_domain
                catalog = {'/api/capabilities': {'capabilities': list(capability_definitions().values())},
                           '/api/standards': {'standards': [{'ref': r, 'verifier_refs': v} for r, v in STANDARDS.items()]},
                           '/api/domain-packs': {'domain_packs': [DOMAIN.descriptor(),get_domain('knowledge-answer@1.0.0').descriptor()]},
                           '/api/agent-definition-default': {'definition': default_definition(domain_ref=query.get('domain',['change-assessment@2.0.0'])[0])}}
                return self.reply(200, catalog[path])
            if path == '/api/agents':
                return self.reply(201, app.agents.save(data)) if mutation else self.reply(200, {'agents':app.agents.list()})
            if path == '/api/agent-domains':
                from .agent_domains import AgentDomains
                domains = AgentDomains(app.agents.store, app.tenant, app.workspace['id'])
                return self.reply(201, domains.create(data)) if mutation else self.reply(200, {'domains': domains.list()})
            agent_path = path.strip('/').split('/')
            if len(agent_path) in (3,4) and agent_path[:2]==['api','agents']:
                identity=identifier(agent_path[2])
                if len(agent_path)==3:
                    return self.reply(200, app.agents.save(data,identity)) if mutation else self.reply(200, app.agents.get(identity))
                if agent_path[3]=='evaluation-contract':
                    return self.reply(200,app.agents.save_evaluation_settings(identity,data)) if mutation else self.reply(200,app.agents.evaluation_settings(identity))
                if mutation and agent_path[3]=='compile':
                    if set(data) != {'revision'}:
                        raise ValueError('编译需要当前 Agent revision')
                    return self.reply(200, {'compiled_agent': app.agents.compile(identity, data['revision']), 'diagnostics': []})
                if mutation and agent_path[3]=='archive':
                    if set(data)!={'revision','archived'}:raise ValueError('归档参数无效')
                    return self.reply(200, app.agents.archive(identity,data['revision'],data['archived']))
            if path=='/api/library' and not mutation:
                scope=app.library_access(query.get('project_id',[None])[0])
                return self.reply(200,{'assets':app.library().list(scope,include_unpublished=True),
                                      'identity':{'principal':scope.principal,'roles':scope.roles,'mode':'local-simulation'}})
            if path=='/api/knowledge/search' and mutation:
                if set(data)-{'query','project_id','limit'}:raise ValueError('unsupported search fields')
                return self.reply(200,app.library().search(app.library_access(data.get('project_id')),data.get('query',''),limit=data.get('limit',12)))
            if path=='/api/knowledge/assets' and mutation:
                payload=dict(data);scope=app.library_access(payload.pop('project_id',None))
                return self.reply(201,app.library().create(scope,payload))
            library_path=path.strip('/').split('/')
            if len(library_path)==5 and library_path[:3]==['api','knowledge','assets'] and library_path[4]=='history' and not mutation:
                scope=app.library_access();asset=app.library().get(scope,unquote(library_path[3]))
                versions=[a for a in app.library().list(scope,include_unpublished=True) if a['id']==asset['id']]
                allowed_versions={a['version'] for a in versions}
                with app.runtime().store.connect() as db:
                    events=[dict(row) for row in db.execute('SELECT version,time,actor,event,data FROM asset_events WHERE tenant=? AND id=? ORDER BY rowid',(app.tenant,asset['id'])) if row['version'] in allowed_versions]
                return self.reply(200,{'versions':versions,'events':events})
            if len(library_path)==5 and library_path[:3]==['api','knowledge','assets'] and mutation:
                if set(data)-{'project_id'}:raise ValueError('unsupported asset lifecycle fields')
                target={'review':'REVIEW','publish':'PUBLISHED','withdraw':'WITHDRAWN'}.get(library_path[4])
                if not target:raise ValueError('unknown lifecycle action')
                return self.reply(200,app.library().transition(app.library_access(data.get('project_id')),unquote(library_path[3]),target))
            if path=='/api/memory' and not mutation:
                from .memory import episodes
                return self.reply(200,{'episodes':episodes(app.runtime().store,app.library_access(query.get('project_id',[None])[0]),query.get('query',[''])[0])})
            if path=='/api/experiences' and not mutation:
                from .experience import ExperienceService
                return self.reply(200,{'experiences':ExperienceService(app.runtime().store).list(app.library_access(query.get('project_id',[None])[0]))})
            if len(library_path)==4 and library_path[:2]==['api','experiences']:
                from .experience import ExperienceService
                service=ExperienceService(app.runtime().store)
                scope=app.library_access(data.get('project_id') if mutation else query.get('project_id',[None])[0])
                ref,action=library_path[2:];ref=unquote(ref)
                if mutation and action=='evaluate':
                    if set(data)-{'project_id'}:raise ValueError('unsupported evaluation fields')
                    return self.reply(200,service.evaluate(scope,ref))
                if mutation and action=='publish':
                    if set(data)-{'project_id','evaluation_id'}:raise ValueError('unsupported review fields')
                    return self.reply(200,service.publish(scope,ref,data.get('evaluation_id')))
                if not mutation and action=='evaluations':return self.reply(200,{'evaluations':service.evaluations(scope,ref)})
            if path == "/api/runs":
                return self.reply(202, app.create(data)) if mutation else self.reply(200, app.runs(query))
            pieces = path.strip("/").split("/")
            if len(pieces) in (3, 4) and pieces[:2] == ["api", "runs"]:
                run_id = identifier(pieces[2])
                if mutation and len(pieces) == 4:
                    if data:
                        raise ValueError("该操作不接受额外参数")
                    return self.reply(202, app.mutate(run_id, pieces[3]))
                if not mutation and len(pieces)==4 and pieces[-1]=='context-manifests':
                    runtime=app.runtime();run=runtime.store.load(app.tenant,run_id)
                    app.assert_run_access(run)
                    if run['task']['principal']!=app.principal:raise PolicyDenied('context belongs to another principal')
                    return self.reply(200,{'manifests':runtime.store.contexts(app.tenant,run_id)})
                if not mutation and len(pieces) == 3:
                    return self.reply(200, app.detail(run_id))
                if not mutation and pieces[-1] == "download":
                    detail = app.detail(run_id)
                    kind = query.get("kind", ["result"])[0]
                    if kind == "result":
                        return self.reply(200, detail["run"], filename=run_id + ".json")
                    if kind == "events":
                        return self.reply(200, "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in detail["events"]), "application/x-ndjson; charset=utf-8", run_id + "-events.jsonl")
                    if kind == "report" and detail["run"]["report"]:
                        from .cli import artifact_markdown
                        text=artifact_markdown(detail['run']['report'])
                        return self.reply(200, text, "text/markdown; charset=utf-8", run_id + "-report.md")
                    raise APIError(404, "所请求的导出内容尚不存在")
            raise APIError(404, "未找到该页面或接口")
        except PolicyDenied as exc:
            self.reply(403, {'error':str(exc)})
        except ConfigConflict as exc:
            self.reply(409, {"error": str(exc)})
        except APIError as exc:
            self.reply(exc.status, {"error": str(exc)})
        except KeyError:
            self.reply(404, {"error": "未找到该运行"})
        except (LeaseBusy, LeaseLost):
            self.reply(409, {"error": "运行正在执行或租约尚未释放，请稍后重试"})
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            self.reply(400, {"error": str(exc)})
        except Exception:
            logging.exception("Web API request failed")
            self.reply(500, {"error": "请求处理失败，请刷新页面并检查本地服务日志"})
        finally:
            if request_lock:request_lock.release()

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch(True)


def serve(data_dir=".agent-data", tenant="tenant-demo", host="127.0.0.1", port=8787, principal="demo-user"):
    app = Application(data_dir, tenant, principal=principal)
    try:
        server = WebServer((host, port), app)
        print(f"Agent Framework Web UI: http://{host}:{server.server_address[1]}", flush=True)
        print("Business tools: simulated | Local access only", flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
    finally:
        app.close()
