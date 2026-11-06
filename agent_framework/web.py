"""Loopback-only Web UI/API. Business actions still pass through the existing Runtime."""

import base64
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
import json
import logging
import re
from pathlib import Path
import secrets
import select
import shutil
import socket
import sqlite3
import threading
import time
from urllib.parse import parse_qs, urlsplit, unquote

from . import __version__
from .contracts import Budget, LeaseBusy, LeaseLost, PolicyDenied, TERMINAL, TaskContract, canonical, digest, identifier
from .llm import CodexConfig, LLMPlanner
from .mock_tools import SCENARIOS
from .runtime import CrashInjected, Runtime, registry_snapshot
from .runtime_config import ConfigConflict, RuntimeConfiguration
from .model_catalog import ModelCatalog
from .agents import AgentRegistry, agent_ref
from .structured import parse_json
from .workspaces import WorkspaceRegistry, WorkspaceDeleted, DEFAULT_WORKSPACE, assert_workspace_active
from .proposal_capacity import ProposalCapacity, ProposalCapacityBusy
from .stream_capacity import StreamCapacity, StreamCapacityBusy


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
WAITING = {"WAITING_AUTH", "WAITING_INPUT", "NEEDS_REVIEW", "INTERRUPTED"}


class Application:
    JOB_CAPACITY = 16
    JOB_HISTORY_LIMIT = 128
    STREAM_LIMIT = 4

    def __init__(self, data_dir=".agent-data", tenant="tenant-demo", *, lease_seconds=3, tool_timeout=1, principal="demo-user"):
        self.data_dir = Path(data_dir).resolve()
        self.tenant = identifier(tenant)
        self.principal = identifier(principal)
        self.lease_seconds, self.tool_timeout = lease_seconds, tool_timeout
        self.control_store=self.runtime().store  # Shared, connection-free control-plane access.
        self.configuration = RuntimeConfiguration(self.data_dir, self.tenant)
        self.models = ModelCatalog(self.data_dir, self.tenant)
        self.agents = AgentRegistry(self.data_dir, self.tenant, self.configuration, self.models)
        self.workspaces = WorkspaceRegistry(self.runtime().store,self.tenant)
        self.workspace = next(w for w in self.workspaces.list() if not w['deleted'])
        if self.workspace['id']!=DEFAULT_WORKSPACE:
            self.agents=AgentRegistry(self.data_dir,self.tenant,self.configuration,self.models,self.workspace['id'])
        self.token = secrets.token_urlsafe(32)
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="agent-web")
        self.cancellation_pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='agent-stop')
        self.lock = threading.RLock()
        # Request ordering must not hold the lock used by workers and stop signals.
        self.mutation_lock = threading.RLock()
        # Workspace views share this gate. Proposal generation uses its own
        # admission transactions and never occupies the ordinary command lock.
        self.proposal_capacity = ProposalCapacity()
        self.stream_capacity = StreamCapacity(self.STREAM_LIMIT)
        self.jobs = {}
        self.cancel_jobs={}
        # Shared by shallow workspace views, just like the executors and lock.
        self._job_history = {False: OrderedDict(), True: OrderedDict()}
        self._closed = threading.Event()
        from .workflows import schema as workflow_schema
        workflow_schema(self.runtime().store)
        from .workspace_scheduler import schema as scheduler_schema
        scheduler_schema(self.runtime().store)
        self.scheduler_stop = threading.Event()
        self.scheduler_thread = None
        from .task_conversations import schema as conversation_schema
        conversation_schema(self.runtime().store)
        from .task_archive import schema as archive_schema
        archive_schema(self.control_store)
        from .task_names import schema as names_schema
        names_schema(self.control_store)
        from .task_favorites import schema as favorites_schema
        favorites_schema(self.control_store)
        from .task_message_edits import schema as edits_schema
        edits_schema(self.control_store)
        from .task_cleanup import schema as cleanup_schema
        cleanup_schema(self.control_store)
        self.conversation_stop=threading.Event()
        self.conversation_thread=None

    @property
    def closed(self):
        # Scoped workspace views share the same executor and shutdown signal.
        return self._closed.is_set()

    def start_conversation_dispatcher(self):
        with self.lock:
            if self.conversation_thread or self.closed:return
            def loop():
                from .task_conversations import TaskConversations
                while not self.conversation_stop.is_set():
                    try:self.recover_cancellations()
                    except Exception:logging.getLogger(__name__).exception('Task cancellation recovery failed')
                    try:
                        from .task_permissions import TaskPermissions
                        TaskPermissions.tick(self)
                    except Exception:logging.getLogger(__name__).exception('Task authorization recovery failed')
                    try:TaskConversations.tick(self)
                    except Exception:logging.getLogger(__name__).exception('Task conversation dispatch failed')
                    try:
                        from .workflows import Workflows
                        Workflows.tick(self)
                    except Exception:logging.getLogger(__name__).exception('Workflow recovery failed')
                    self.conversation_stop.wait(1)
            self.conversation_thread=threading.Thread(target=loop,name='task-conversations',daemon=True)
            self.conversation_thread.start()

    def start_scheduler(self):
        with self.lock:
            if self.scheduler_thread or self.closed:
                return
            def loop():
                from .workspace_scheduler import tick
                while not self.scheduler_stop.is_set():
                    try:
                        with self.mutation_lock:
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
                    child=flows.accepted_child(item) if item['status']=='SUCCEEDED' else flows.current_child(item['run_id']);self.assert_run_access(child)
                    pending=next((a for a in child['actions'] if a['status']=='PREPARED' and a['tool_ref']=='report.draft.create@1.0.0'),None)
                    children[node]={'run_id':child['run_id'],'status':child['status'],'checks':child['checks'],
                                    'required_check_count':len(child['task']['acceptance']),
                                    'draft_count':len(self.runtime().external.stats(self.tenant,child['run_id'])['drafts']),
                                    'pending':pending,'proposal_token':flows.grant_token(identity,node,child,pending) if pending else None}
                except KeyError:pass
        return {'run':state,'children':children,'events':flows.events(identity),'job':self.job(identity),'queue':self.flow_queue(state,flows)}

    def flow_queue(self,state,flows=None):
        if state['status'] in TERMINAL:return None
        request=(flows or self.workflows()).dispatch_request(state['id'])
        if not request:return None
        job=self.job(state['id']) or {}
        executing=job.get('active') and job.get('state')=='RUNNING' and job.get('dispatch_generation')==request['generation']
        return {'state':'ERROR' if request['error'] else 'RUNNING' if executing else 'QUEUED',
                'reason':request['reason'],'requested_at':request['requested'],'error':request['error']}

    def flow_runs(self):
        flows=self.workflows()
        return [{**state,'queue':self.flow_queue(state,flows)} for state in flows.runs()]

    def schedule_flow(self,identity):
        with self.lock:
            if self.closed:raise APIError(503,'服务正在关闭')
            self.workflows().request_dispatch(identity)
            return self.enqueue_flow(identity)

    def enqueue_flow(self,identity):
        """Try a saved request; capacity and lease waits keep the durable receipt."""
        from .workflows import FLOW_TERMINAL
        flows=self.workflows();state=flows.run(identity)
        with self.lock:
            if self.closed:raise APIError(503,'服务正在关闭')
            if state['status'] in FLOW_TERMINAL:return False
            request=flows.dispatch_request(identity)
            if not request or request['error']:return False
            # Recovery can win the race with the original accepted start request.
            if self.jobs.get(identity,{}).get('active'):return False
            if state['lease_active'] or not self.has_job_capacity(replacing=identity):return False
            job={'active':True,'state':'QUEUED','cancel':threading.Event(),'started_at':time.time(),'error':None,'dispatch_generation':request['generation']}
            self.jobs[identity]=job
            def work():
                retain=False
                try:
                    job['state']='RUNNING';flows.execute(identity);job['state']='COMPLETED'
                except (LeaseBusy,LeaseLost):job.update(state='ERROR',error='任务租约尚未释放，请稍后恢复同一工作流。',retryable=True)
                except Exception:
                    job.update(state='ERROR',error='工作流执行意外中断，请检查原工作流后重试。')
                    retain=True
                    try:
                        flows.dispatch_error(identity,request['generation'],job['error']);retain=False
                    except Exception:logging.getLogger(__name__).exception('Workflow dispatch failure could not be persisted')
                finally:
                    self._finish_job(identity,job,retain=retain)
            try:self.pool.submit(work)
            except Exception:
                job.update(state='ERROR',error='工作流未能进入执行队列');retain=True
                try:
                    flows.dispatch_error(identity,request['generation'],job['error']);retain=False
                finally:self._finish_job(identity,job,retain=retain)
                raise
            return True

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
        return {"csrf_token": self.token, "version": __version__, "tenant": self.tenant,"principal":self.principal,"workspace":self.workspace,
                "model": self.model_info(), "agent": snapshot["agent"], "skill": snapshot["skill"],
                "domain_pack_ref": snapshot['compiled_agent']['domain_pack']['ref'],
                "compiled_agent_hash": snapshot['compiled_agent']['hash'],
                "capability_contracts": capability_definitions(),
                "domain_packs": [get_domain(ref).descriptor() for ref in ("general-assistant@1.0.0","change-assessment@2.0.0","knowledge-answer@1.0.0")],
                "scenarios": [{"id": key, "label": SCENARIO_LABELS[key][0], "description": SCENARIO_LABELS[key][1]} for key in SCENARIOS],
                "business_tools": "simulated", "max_workers": 4, "runtime_config": self.runtime_settings()}

    def runtime_settings(self):
        return {"settings": self.configuration.get(), "providers": self.configuration.catalog()}

    def save_agent(self,data,identity=None):
        request_id=identifier(data['request_id']) if 'request_id' in data else None
        return self.agents.save({key:value for key,value in data.items() if key!='request_id'},identity,request_id=request_id,principal=self.principal)

    def save_skill(self,data,identity=None):
        request_id=identifier(data['request_id']) if 'request_id' in data else None
        return self.skills().save({key:value for key,value in data.items() if key!='request_id'},identity,request_id=request_id,principal=self.principal)

    def assert_run_access(self, state):
        if state['task']['project_id']!=self.workspace['project_id']:raise PolicyDenied('run outside current workspace')
        # New contextual runs may contain private preferences, sources and episodes.
        # Historical runs retain their original tenant-workbench access semantics.
        if state['snapshot'].get('context_policy') and state['task']['principal']!=self.principal:
            raise PolicyDenied('run belongs to another principal')

    def _failure_is_recorded_or_superseded(self, identity, job, cancellation):
        """Only used for pinned failures; a failed read must retain the fallback."""
        try:
            with self.control_store.read_snapshot() as db:
                if 'execution_epoch' in job:
                    row=db.execute("SELECT epoch,json_extract(state,'$.status') AS status,json_extract(state,'$.interruption') AS interruption FROM runs WHERE tenant_id=? AND id=?",(self.tenant,identity)).fetchone()
                    if not row:return False
                    if row['epoch']!=job['execution_epoch'] or row['status'] in TERMINAL:return True
                    if not cancellation:return bool(row['interruption'])
                    request=self.control_store.cancellation(self.tenant,identity,db=db)
                    return bool(request and (not request['pending'] or request['error']))
                if 'dispatch_generation' in job:
                    row=db.execute('SELECT generation,error FROM workflow_dispatches WHERE tenant=? AND run_id=?',(self.tenant,identity)).fetchone()
                    return not row or bool(row['error']) or row['generation']>job['dispatch_generation']
        except (OSError,sqlite3.Error):pass
        return False

    def has_job_capacity(self, *, cancellation=False, replacing=None):
        # An unrecorded failure remains a bounded fallback until an explicit
        # retry replaces it. Never evict the only diagnostic to admit new work.
        with self.lock:
            registry=self.cancel_jobs if cancellation else self.jobs
            for key,job in list(registry.items()):
                if job.get('_retention_required') and self._failure_is_recorded_or_superseded(key,job,cancellation):
                    self._finish_job(key,job,cancellation=cancellation)
            return sum(bool(job.get('active') or (key!=replacing and job.get('_retention_required')))
                       for key,job in registry.items()) < self.JOB_CAPACITY

    def _finish_job(self, identity, job, *, cancellation=False, retain=False):
        with self.lock:
            job.update(active=False,ended_at=time.time(),_retention_required=retain)
            job.pop('future',None)
            registry=self.cancel_jobs if cancellation else self.jobs
            # A late completion may belong to an older attempt of the same run.
            if registry.get(identity) is not job:return
            history=self._job_history[cancellation]
            history.pop(identity,None)
            if retain:return
            history[identity]=job
            # Completion order, independent of wall-clock adjustments or reads.
            while len(history)>self.JOB_HISTORY_LIMIT:
                older,finished=history.popitem(last=False)
                if registry.get(older) is finished and not finished.get('active'):
                    del registry[older]

    def observe_jobs(self):
        # Freeze process-local hints before the durable read. Do not hold the
        # worker/stop lock while querying databases or building the response.
        with self.lock:
            selected={**self.jobs,**{key:job for key,job in self.cancel_jobs.items() if job.get('active')}}
            return {key:{k:v for k,v in job.items() if k not in {'cancel','future'} and not k.startswith('_')} for key,job in selected.items()}

    def job(self, run_id, *, db=None, observed=None):
        if observed is not None:
            result=dict(observed[run_id]) if run_id in observed else None
        else:
            with self.lock:
                job=self.cancel_jobs.get(run_id) if self.cancel_jobs.get(run_id,{}).get('active') else self.jobs.get(run_id)
                result={k: v for k, v in job.items() if k not in {'cancel','future'} and not k.startswith('_')} if job else None
        if result and not result['active'] and 'execution_epoch' in result and result['state'] in {'ERROR','CRASHED','SUPERSEDED'}:
            with self.control_store.read_snapshot(db) as connection:row=connection.execute('SELECT epoch FROM runs WHERE tenant_id=? AND id=?',(self.tenant,run_id)).fetchone()
            if not row or row['epoch']!=result['execution_epoch'] or result['state']=='SUPERSEDED':return None
        return result

    def lease(self, run_id, *, db=None):
        with self.control_store.read_snapshot(db) as connection:
            row = connection.execute("SELECT lease_until,owner FROM runs WHERE tenant_id=? AND id=?", (self.tenant, run_id)).fetchone()
        return {"active": bool(row and row["owner"] and row["lease_until"] > time.time()),
                "until": row["lease_until"] if row else 0}

    def summary(self, state, *, jobs=None):
        identity=state.get('_conversation_active_run',state['run_id'])
        job = jobs.get(identity) if jobs is not None else self.job(identity)
        return {k: state[k] for k in ("run_id", "status", "created_at", "deadline", "steps", "replans", "scenario", "last_error")} | {
            "goal": state["task"]["goal"], "change_id": state["task"]["change_id"],"archive":state.get('archive',{'archived':False,'revision':0,'updated_at':None}),
            'favorite':state.get('favorite',{'favorited':False,'revision':0,'updated_at':None}),
            'task_name':state.get('task_name',{'name':'','revision':0,'updated_at':None}),'title':state.get('task_name',{}).get('name') or state['task']['goal'],
            "project_id": state["task"]["project_id"], "planner_ref": state["snapshot"]["planner_ref"],
            "domain_pack_ref": state["task"]["domain_pack_ref"], "source_run_id": state["task"].get("source_run_id"),
            "execution_mode":state['task'].get('execution_mode'),
            "interruption":state.get('interruption'),'cancellation':state.get('cancellation'),"last_error":(state.get('cancellation') or {}).get('error') or (state.get('interruption') or {}).get('message') or state.get('last_error'),
            "processing_domain":{k:v for k,v in (state['snapshot'].get('agent_profile',{}).get('processing_domain') or {}).items() if k in ('id','name','revision')} or None,
            "updated_at": state.get("updated_at", state["created_at"]),
            "agent_id": state["snapshot"].get("agent_profile", {}).get("id"),
            "agent_name": state["snapshot"].get("agent_profile", {}).get("name") or state["snapshot"].get("agent", {}).get("identity", {}).get("name"),
            "agent_revision": state["snapshot"].get("agent_profile", {}).get("revision"),
            "model": state["snapshot"].get("planner", {}).get("config", {}).get("model"),
            "risk_level": (state["report"] or {}).get("risk_level"), "draft": state["draft"],
            "model_calls": state.get("model_calls", 0), "model_tokens": state.get("model_tokens", 0), "job": job}

    def accessible_run_states(self,*,compact=False,db=None):
        store = self.control_store
        from .run_catalog import accessible_roots
        from .task_conversations import TaskConversations
        with store.read_snapshot(db) as connection:
            states=accessible_roots(self,store,compact=compact,db=connection)
            return TaskConversations(self,store).summary_states(states,db=connection)

    def runs(self, params=None):
        from .run_catalog import HistoryQuery
        query=HistoryQuery(params or {},(self.tenant,self.workspace['id'],self.principal))
        observed=self.observe_jobs()
        with self.control_store.read_snapshot() as db:
            return self._runs(query,db,observed)

    def _runs(self,query,db,observed):
        states = self.accessible_run_states(compact=True,db=db)
        identities={s.get('_conversation_active_run',s['run_id']) for s in states}
        jobs={identity:self.job(identity,db=db,observed=observed) for identity in identities}
        domain_facets={}
        for state in states:
            domain=state['snapshot'].get('agent_profile',{}).get('processing_domain')
            if domain:domain_facets.setdefault(domain['id'],{'id':domain['id'],'name':domain['name']})
        counts = {"total": len(states), "running": 0, "waiting": 0, "succeeded": 0}
        for state in states:
            job = jobs.get(state.get('_conversation_active_run',state['run_id']))
            counts["running"] += bool(job and job["active"]) or state["status"] in {"RUNNING", "RECONCILING", "VERIFYING",'CANCELLING'}
            counts["waiting"] += state["status"] in WAITING
            counts["succeeded"] += state["status"] == "SUCCEEDED"
        search,status,agent,domain=query.search,query.status,query.agent,query.domain
        if query.favorites=='only':states=[s for s in states if s.get('favorite',{}).get('favorited')]
        if query.visibility!='all':states=[s for s in states if bool(s.get('archive',{}).get('archived'))==(query.visibility=='archived')]
        if search:
            headers = {s['run_id'] for s in states if search in ' '.join(str(v) for v in (
                s['task']['goal'],s.get('task_name',{}).get('name',''), s['task']['change_id'], s['run_id'], s['scenario'],
                SCENARIO_LABELS.get(s['scenario'], ('', ''))[0],
                s['snapshot'].get('agent_profile', {}).get('name', ''))).lower()}
            from .task_text_search import matches
            hits=matches(self,[s['run_id'] for s in states if s['run_id'] not in headers],search,store=self.control_store,db=db)
            states=[s for s in states if s['run_id'] in headers or s['run_id'] in hits]
            for state in states:
                if state['run_id'] in hits:state['_search_match']=hits[state['run_id']]
        if status == 'group:running':
            states = [s for s in states if (jobs.get(s.get('_conversation_active_run',s['run_id'])) or {}).get('active') or s['status'] in {'RUNNING','RECONCILING','VERIFYING','CANCELLING'}]
        elif status == 'group:waiting':
            states = [s for s in states if s['status'] in WAITING]
        elif status and status != 'all':
            states = [s for s in states if s['status'] == status]
        if agent:
            states = [s for s in states if s['snapshot'].get('agent_profile', {}).get('id') == agent]
        if domain:
            states = [s for s in states if (not s['snapshot'].get('agent_profile',{}).get('processing_domain') if domain=='none' else (s['snapshot'].get('agent_profile',{}).get('processing_domain') or {}).get('id')==domain or s['task']['domain_pack_ref']==domain)]
        if query.after is not None:states=[s for s in states if s['created_at']>=query.after]
        if query.before is not None:states=[s for s in states if s['created_at']<query.before]
        states.sort(key=query.key,reverse=query.reverse)
        filtered_total = len(states)
        states=query.following(states);limit=query.limit
        page, has_more = states[:limit], len(states) > limit
        next_cursor = query.cursor(page[-1]) if has_more and page else None
        return {"runs": [self.summary(s,jobs=jobs)|({'search_match':s['_search_match']} if '_search_match' in s else {}) for s in page], "counts": counts, "limit": limit,
                "filtered_total": filtered_total, "next_cursor": next_cursor, "sort": query.sort,"processing_domains":list(domain_facets.values())}

    def _attention_tasks(self,db,observed):
        kinds = {'CREATED':'start','WAITING_AUTH':'auth','WAITING_INPUT':'input','NEEDS_REVIEW':'review','FAILED':'failed','EXPIRED':'expired'}
        tasks = []
        states=[s for s in self.accessible_run_states(compact=True,db=db) if not s.get('archive',{}).get('archived')]
        from .run_catalog import active_leases
        resumable_states={'CREATED','RUNNING','RECONCILING','VERIFYING','INTERRUPTED'}
        candidates=[s.get('_conversation_active_run',s['run_id']) for s in states if s['status'] in resumable_states]
        leased=active_leases(self.control_store,self.tenant,candidates,db=db) if candidates else set()
        for state in states:
            active_id=state.get('_conversation_active_run',state['run_id'])
            status, job = state['status'], self.job(active_id,db=db,observed=observed)
            kind = kinds.get(status)
            cancellation=state.get('cancellation')
            if cancellation and cancellation['pending']:
                if cancellation['error']:tasks.append(self.summary(state,jobs={active_id:job})|{'attention_kind':'cancel'})
                continue
            resumable = status in resumable_states and not (job and job['active']) and active_id not in leased
            if status == 'CREATED' and not resumable:
                kind = None
            elif not kind and status in {'RUNNING','RECONCILING','VERIFYING','INTERRUPTED'} and resumable:
                kind = 'resume'
            if kind and (status != 'CREATED' or resumable):
                tasks.append(self.summary(state,jobs={active_id:job}) | {'attention_kind':kind})
        tasks.sort(key=lambda s:(s['deadline'],s['created_at'],s['run_id']))
        return tasks

    def attention(self):
        observed=self.observe_jobs()
        with self.control_store.read_snapshot() as db:
            tasks=self._attention_tasks(db,observed)
        flow_kinds = {'WAITING_AUTH':'auth','WAITING_INPUT':'input','INTERRUPTED':'resume','PAUSED':'resume','NEEDS_REVIEW':'review','FAILED':'failed','EXPIRED':'expired'}
        flows = [dict(r,attention_kind=flow_kinds.get(r['display_status'],'resume')) for r in self.workflows().attention()]
        flows.sort(key=lambda r:(r.get('deadline') or float('inf'),r.get('created_at') or 0,r['id']))
        from .workspace_scheduler import WorkspaceScheduler
        daily = WorkspaceScheduler(self).overview()
        plans = [p for p in daily['plans'] if p.get('dispatch',{}).get('state')=='FAILED'
                 or (p['day'] == daily['today'] and any(i['status'] == 'BLOCKED' for i in p['items']))]
        with self.runtime().store.connect() as db:
            alerts = db.execute('SELECT COUNT(*) FROM agent_alerts WHERE tenant=? AND project=? AND principal=? AND acknowledged IS NULL',
                                (self.tenant,self.workspace['project_id'],self.principal)).fetchone()[0]
        return {'tasks':tasks,'workflow_runs':flows,'daily_plans':plans,
                'counts':{'total':len(tasks)+len(flows)+len(plans),'tasks':len(tasks),'workflows':len(flows),'daily':len(plans)},'open_alert_count':alerts}

    def task_draft(self):
        with self.control_store.connect() as db:return self._task_draft(db)

    def _task_draft(self,db):
        row=db.execute('SELECT revision,data,updated FROM task_drafts WHERE tenant=? AND workspace=? AND principal=?',
                       (self.tenant,self.workspace['id'],self.principal)).fetchone()
        return {'draft':json.loads(row['data']) if row else None,'revision':row['revision'] if row else 0,'updated_at':row['updated'] if row else None}

    def _clear_task_draft(self,db,revision,*,strict):
        saved=self._task_draft(db)
        if saved['revision']!=revision:
            if not strict or (saved['draft'] is None and saved['revision']==revision+1):return saved
            raise ConfigConflict('任务草稿已在其他页面更新，请重新检查后再放弃')
        if saved['draft'] is None:return saved
        now=time.time()
        db.execute("UPDATE task_drafts SET revision=revision+1,data='null',updated=? WHERE tenant=? AND workspace=? AND principal=?",
                   (now,self.tenant,self.workspace['id'],self.principal))
        return {'draft':None,'revision':revision+1,'updated_at':now}

    @staticmethod
    def _validate_draft_cleanup(data):
        if data.get('clear_draft'):
            if type(data.get('draft_revision')) is not int or data['draft_revision']<0:raise ValueError('清理任务草稿需要已查看的草稿版本')
        elif 'draft_revision' in data:raise ValueError('草稿版本仅用于明确清理已查看的草稿')

    def save_task_draft(self, data):
        allowed = {'domain_pack_ref','goal','change_id','agent_id','planner','max_steps','max_wall_seconds','step','source_run_id'}
        if not isinstance(data,dict) or set(data) != {'revision','draft'} or type(data['revision']) is not int or data['revision']<0 or not isinstance(data['draft'],dict):
            raise ValueError('任务草稿需要 revision 和 draft')
        source = data['draft']
        if set(source) - allowed:
            raise ValueError('任务草稿包含不支持或许可字段')
        for key in {'goal','change_id','agent_id','source_run_id'} & set(source):
            if not isinstance(source[key],str) or len(source[key]) > (2000 if key == 'goal' else 100):
                raise ValueError('任务草稿文本字段无效')
        if source.get('domain_pack_ref') not in {None,'general-assistant@1.0.0','change-assessment@2.0.0','knowledge-answer@1.0.0'}:
            raise ValueError('任务草稿领域无效')
        if source.get('planner') not in {None,'mock','codex','cursor','qoder'}:
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
        with self.control_store.transaction() as db:
            assert_workspace_active(db,self.tenant,self.workspace['id'])
            row = db.execute('SELECT revision FROM task_drafts WHERE tenant=? AND workspace=? AND principal=?',
                             (self.tenant,self.workspace['id'],self.principal)).fetchone()
            current = row['revision'] if row else 0
            if current != data['revision']:
                raise ConfigConflict('任务草稿已在其他页面更新，请重新读取')
            revision = current + 1
            db.execute('INSERT OR REPLACE INTO task_drafts VALUES(?,?,?,?,?,?)',
                       (self.tenant,self.workspace['id'],self.principal,revision,canonical(clean),now))
        return {'draft':clean,'revision':revision,'updated_at':now}

    def discard_task_draft(self,data):
        if not isinstance(data,dict) or set(data)!={'revision'} or type(data['revision']) is not int or data['revision']<0:
            raise ValueError('放弃任务草稿需要已查看的整数版本')
        with self.control_store.transaction() as db:
            assert_workspace_active(db,self.tenant,self.workspace['id'])
            return self._clear_task_draft(db,data['revision'],strict=True)

    def run_export(self,run_id):
        from .exports import capture_run
        return capture_run(self.control_store,self.tenant,identifier(run_id),authorize=self.assert_run_access,principal=self.principal)

    def raw_detail(self, run_id):
        identifier(run_id)
        runtime=self.runtime();jobs=self.observe_jobs()
        with runtime.store.read_snapshot() as db:
            return self._raw_detail(run_id,runtime,db,jobs)

    def _raw_detail(self,run_id,runtime,db,jobs):
        job=self.job(run_id,db=db,observed=jobs)
        from .task_permissions import TaskPermissions
        result=runtime.store.result(self.tenant,run_id,db=db)
        self.assert_run_access(result)
        grant=runtime.store.get_grant(result,db=db)
        permissions=TaskPermissions(self).view(result,db=db)
        grant_valid = bool(grant and not grant["revoked"] and grant["expires_at"] > time.time())
        if permissions['request'] and not permissions['request']['error'] and job and job.get('active'):
            permissions['request']['state']='RUNNING' if job.get('state')=='RUNNING' else 'QUEUED'
        cancellation=result.get('cancellation')
        if job:job={**job,'cancel_requested':bool(cancellation and cancellation['pending']) or bool(job.get('cancel_requested'))}
        return {"run": result,'cancellation':cancellation,'permissions':permissions, "events": runtime.store.events(self.tenant,run_id,db=db),
                "evidence": runtime.store.evidence(result,db=db), "external": runtime.external.stats(self.tenant, run_id),
                "context_manifests": runtime.store.contexts(self.tenant,run_id,db=db) if result['task']['principal']==self.principal else [],
                "job": job, "lease": self.lease(run_id,db=db),
                "grant": {"valid": grant_valid, "expires_at": grant["expires_at"] if grant else None}}

    def detail(self,run_id,*,db=None):
        identifier(run_id);runtime=self.runtime();jobs=self.observe_jobs()
        with runtime.store.read_snapshot(db) as db:
            detail=self._raw_detail(run_id,runtime,db,jobs)
            if detail['run']['snapshot'].get('compiled_agent') and detail['run']['task']['principal']==self.principal:
                from .task_conversations import TaskConversations
                conversation=TaskConversations(self,runtime.store).view(run_id,db=db,jobs=jobs)
                current=detail if conversation['active_run_id']==run_id else self._raw_detail(conversation['active_run_id'],runtime,db,jobs)
                detail={**detail,'conversation':{**conversation,'current':current}}
            from .task_archive import read as read_archive
            detail['archive']=detail.get('conversation',{}).get('archive') or read_archive(self,runtime.store,run_id,db)
            from .task_names import read as read_name
            detail['task_name']=detail.get('conversation',{}).get('task_name') or read_name(self,runtime.store,run_id,db)
            from .task_favorites import read as read_favorite
            detail['favorite']=read_favorite(self,runtime.store,detail.get('conversation',{}).get('id',run_id),db)
            return detail

    def favorite_task(self,identity,data):
        from .task_favorites import update
        return update(self,identity,data)

    def rename_task(self,identity,data):
        from .task_names import update
        return update(self,identity,data)

    def archive_task(self,identity,data):
        from .task_archive import update
        return update(self,identity,data)

    def task_submission_id(self,request_id):
        return 'task-'+digest([self.tenant,self.workspace['id'],self.principal,identifier(request_id)])[:32]

    def task_submission(self,request_id):
        """Read a scoped accepted submission without starting or registering work."""
        identity=self.task_submission_id(request_id)
        state=self.control_store.load(self.tenant,identity)
        context=state['task'].get('conversation_context') or {}
        if (state['task']['principal']!=self.principal or state['task']['project_id']!=self.workspace['project_id']
                or state['task'].get('execution_mode')!='conversation' or context.get('task_id')!=identity or context.get('turn')!=1):
            raise KeyError('task submission unavailable')
        return {**self.detail(identity),'task_draft':self.task_draft(),'submission':{'request_id':request_id,'run_id':identity}}

    def start_task(self, data, *, run_id=None, start=True):
        """Start the selected agent; no business-write authorization is implied."""
        allowed={'goal','agent_id','agent_revision','request_id','source_run_id','clear_draft','draft_revision'}
        if not isinstance(data,dict) or set(data)-allowed:
            raise ValueError('新建任务只接受目标和执行智能体')
        goal=data.get('goal')
        if not isinstance(goal,str) or not 1<=len(goal.strip())<=2000:
            raise ValueError('请填写 1–2000 字的任务目标')
        agent_id=identifier(data.get('agent_id',''))
        request_id=identifier(data.get('request_id',''))
        if type(data.get('agent_revision')) is not int:
            raise ValueError('执行智能体版本无效，请重新选择')
        if 'clear_draft' in data and type(data['clear_draft']) is not bool:
            raise ValueError('clear_draft 必须为布尔值')
        self._validate_draft_cleanup(data)
        with self.lock:
            self.workspace=self.workspaces.get(self.workspace['id'])
            run_id=identifier(run_id) if run_id else self.task_submission_id(request_id)
            runtime=self.runtime()
            try:existing=runtime.store.load(self.tenant,run_id)
            except KeyError:existing=None
            if existing:
                return self._task_submission_receipt(existing,data,start=start)
            profile=self.agents.get(agent_id)
            domain=(profile.get('definition') or {}).get('domain_pack_ref','change-assessment@2.0.0')
            change_id=run_id
            if domain=='change-assessment@2.0.0':
                match=re.search(r'(?<![A-Za-z0-9_.-])(?:change|chg|cr)[-_][A-Za-z0-9][A-Za-z0-9_.-]{0,80}',goal,re.I)
                change_id=match.group(0) if match else run_id
            try:
                result=self._create({'goal':goal.strip(),'agent_id':agent_id,'agent_revision':data.get('agent_revision'),
                    'change_id':change_id,'source_run_id':data.get('source_run_id'),'clear_draft':data.get('clear_draft',False),
                    **({'draft_revision':data['draft_revision']} if data.get('clear_draft') else {}),
                    'grant':False,'consent':True,'mcp_consent':True,'start':False,'execution_mode':'conversation'},run_id=run_id,
                    conversation_context={'task_id':run_id,'turn':1,'goal':goal.strip(),'messages':[],'history_hash':digest([]),'omitted_messages':0},start_conversation=start)
            except sqlite3.IntegrityError as collision:
                # Another process may commit the same request after our first
                # read. Return its receipt only if the complete identity matches.
                try:existing=runtime.store.load(self.tenant,run_id)
                except KeyError:raise collision from None
                return self._task_submission_receipt(existing,data,start=start)
            from .task_conversations import TaskConversations
            if start:
                TaskConversations(self).dispatch(run_id)
            return {**self.detail(run_id),'task_draft':result['task_draft'],
                    'submission':{'request_id':request_id,'run_id':run_id}}

    def _task_submission_receipt(self,existing,data,*,start):
        self.assert_run_access(existing)
        profile=existing['snapshot'].get('agent_profile',{})
        if (existing['task']['principal']!=self.principal or existing['task']['goal']!=data['goal'].strip()
            or profile.get('id')!=data['agent_id'] or profile.get('revision')!=data.get('agent_revision')
            or existing['task'].get('source_run_id')!=data.get('source_run_id')):
            raise ConfigConflict('此提交编号已用于另一个任务，请重新提交')
        if start:
            from .task_conversations import TaskConversations
            service=TaskConversations(self);service.register(existing);service.dispatch(existing['run_id'])
        return {**self.detail(existing['run_id']),'task_draft':self.task_draft(),
                'submission':{'request_id':data['request_id'],'run_id':existing['run_id']}}

    def create(self, data, *, run_id=None):
        with self.lock:
            self.workspace=self.workspaces.get(self.workspace['id'])
            return self._create(data, run_id=run_id)

    def _create(self, data, *, run_id=None,conversation_context=None,start_conversation=False):
        allowed = {"goal", "change_id", "project_id", "domain_pack_ref", "planner", "runtime", "runtime_revision", "agent_id", "agent_revision", "mcp_consent", "scenario", "grant", "consent", "budget", "start", "source_run_id", "clear_draft", "draft_revision", "execution_mode"}
        if not isinstance(data, dict) or set(data) - allowed:
            raise ValueError("任务包含不支持的字段")
        if data.get('project_id',self.workspace['project_id'])!=self.workspace['project_id']:raise PolicyDenied('project outside current workspace')
        for name in ("grant", "consent", "mcp_consent", "start", "clear_draft"):
            if name in data and type(data[name]) is not bool:
                raise ValueError(name + " 必须为布尔值")
        self._validate_draft_cleanup(data)
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
        if planner_name not in {"mock", "codex", "cursor", "qoder"}:
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
                            principal=self.principal, agent_ref=agent_ref(profile) if profile else 'release-assistant@1.0.0', budget=Budget(**budget), source_run_id=source_run_id,execution_mode=data.get('execution_mode'),conversation_context=conversation_context)
        runtime = self.runtime(planner)
        draft_receipt=None
        def accept(db,state):
            nonlocal draft_receipt
            assert_workspace_active(db,self.tenant,self.workspace['id'])
            if profile:self.agents.assert_submission_current(db,profile)
            else:
                current=db.execute('SELECT revision FROM runtime_configuration WHERE tenant=?',(self.tenant,)).fetchone()
                if (current['revision'] if current else 0)!=settings['revision']:
                    raise ConfigConflict('运行时配置在提交期间已更新，请重新打开新建任务窗口核对后提交')
            runtime.store.event(db,self.tenant,state['run_id'],'runtime.config_selected',{'provider':planner_name,'revision':settings['revision']})
            if profile:
                runtime.store.event(db,self.tenant,state['run_id'],'agent.selected',{'id':profile['id'],'revision':profile['revision'],'mcp_consented':data.get('mcp_consent',False)})
            if planner_name != "mock":
                runtime.store.event(db,self.tenant,state['run_id'],'model.sharing_consented',{'source':'webui','scope':'task-simulated-evidence-and-scoped-library'})
            if start_conversation:
                from .task_conversations import TaskConversations
                TaskConversations(self,runtime.store).register(state,db=db)
            draft_receipt=self._clear_task_draft(db,data['draft_revision'],strict=False) if data.get('clear_draft') else self._task_draft(db)
        state=runtime.submit(task,scenario=data.get('scenario','normal'),grant=data.get('grant',True),agent_profile=profile,run_id=run_id,on_created=accept)
        if data.get("start", True):
            self.schedule(state["run_id"])
        return {**self.detail(state["run_id"]),'task_draft':draft_receipt}

    def schedule(self, run_id, *, automatic=False):
        identifier(run_id)
        store=self.runtime().store
        state = store.load(self.tenant, run_id)
        self.assert_run_access(state)
        if state["status"] in TERMINAL:
            raise APIError(409, "运行已结束；可以查看结果或创建新的任务")
        if state["status"] == "WAITING_INPUT" and not state["snapshot"].get("context_policy"):
            raise APIError(409, "请补充或修复来源后创建新任务；此版本暂不支持在线追加材料")
        with self.lock:
            if self.closed:
                raise APIError(503, "服务正在关闭")
            if automatic and self.jobs.get(run_id,{}).get('_retention_required'):
                raise APIError(409, '上次执行的失败记录尚未保存，请检查原任务后手动恢复')
            if self.jobs.get(run_id, {}).get("active") or self.lease(run_id)["active"]:
                raise APIError(409, "运行仍由工作进程持有，请等待当前动作或租约结束")
            if not self.has_job_capacity(replacing=run_id):
                raise APIError(429, "执行容量已满，请等待已有任务结束，或检查并恢复异常任务")
            try:epoch=store.begin_execution(self.tenant,run_id,automatic=automatic)
            except LeaseBusy as exc:raise APIError(409,str(exc)) from None
            job = {"active": True, "state": "QUEUED", "cancel_requested": False,
                   "cancel": threading.Event(), "started_at": time.time(), "error": None,"execution_epoch":epoch}
            self.jobs[run_id] = job
            try:job['future']=self.pool.submit(self._work, run_id, job,store)
            except Exception as exc:
                job.update(state='ERROR',error='任务未能进入执行队列');retain=True
                try:
                    store.interrupt_execution(self.tenant,run_id,epoch,kind='ERROR',code='executor_rejected',message=job['error'],exception_type=type(exc).__name__);retain=False
                finally:self._finish_job(run_id,job,retain=retain)
                raise

    def _work(self, run_id, job,store):
        with self.lock:
            job["state"] = "RUNNING"
        runtime=None;retain=False
        def interrupted(kind,code,message,exc):
            nonlocal retain
            epoch=runtime.execution_epoch if runtime and runtime.execution_epoch is not None else job['execution_epoch']
            job.update(state=kind,error=message,execution_epoch=epoch)
            retain=True
            try:
                if not store.interrupt_execution(self.tenant,run_id,epoch,kind=kind,code=code,message=message,exception_type=type(exc).__name__):
                    job.update(state='SUPERSEDED',error=None)
                retain=False
            except Exception:logging.getLogger(__name__).exception('Worker interruption could not be persisted')
        try:
            runtime = self.runtime()
            runtime.execution_epoch=job['execution_epoch']
            runtime.cancel_requested=job['cancel'].is_set
            while True:
                if job["cancel"].is_set():
                    request=store.cancellation(self.tenant,run_id)
                    if not request or not request['pending']:runtime.cancel(run_id,self.tenant)
                    elif not request['error']:runtime.cancel(run_id,self.tenant,requested=True)
                    break
                result = runtime.run(run_id, self.tenant, pause_after=1)
                if result["status"] in TERMINAL | {"WAITING_AUTH", "WAITING_INPUT"} or (result.get('cancellation') or {}).get('pending'):
                    break
            with self.lock:
                job["state"] = "COMPLETED"
        except CrashInjected as exc:
            interrupted('CRASHED','injected_crash','写入后执行进程已中断，租约释放后可恢复原任务核对。',exc)
        except (LeaseBusy, LeaseLost) as exc:
            interrupted('ERROR','lease_lost','执行进程失去运行租约，请检查后恢复原任务。',exc)
        except Exception as exc:
            interrupted('ERROR','worker_exception' if runtime else 'runtime_initialization_failed','执行进程意外退出，输入与已保存内容保留，请检查后恢复原任务。',exc)
        finally:
            try:
                from .task_permissions import TaskPermissions
                TaskPermissions(self).settle(run_id)
            except Exception:logging.getLogger(__name__).exception('Task authorization completion could not be recorded')
            self._finish_job(run_id,job,retain=retain)
            if not self.closed and job['state']=='COMPLETED':
                self._advance_conversation(run_id)

    def _advance_conversation(self,run_id):
        if self.closed:return
        from .task_conversations import TaskConversations
        row=None
        try:
            with self.control_store.connect() as db:
                row=db.execute('SELECT c.* FROM task_conversation_turns t JOIN task_conversations c ON c.tenant=t.tenant AND c.id=t.task_id WHERE t.tenant=? AND t.run_id=?',(self.tenant,run_id)).fetchone()
            if row:
                scoped=self.scoped(row['workspace']);TaskConversations(scoped).dispatch(row['id']);scoped.workflows().continue_after_reply(row['id'])
        except WorkspaceDeleted as exc:
            # Completion releases the execution lease before this best-effort
            # wakeup. Deletion can legitimately win that interval; it has
            # already checked for pending turns and unfinished parent flows.
            if row and (exc.tenant,exc.workspace_id)==(self.tenant,row['workspace']):return
            logging.getLogger(__name__).exception('Next conversation turn could not be dispatched for %s',run_id)
        except Exception:logging.getLogger(__name__).exception('Next conversation turn could not be dispatched for %s',run_id)

    def schedule_cancellation(self,run_id):
        store=self.control_store;state=store.load(self.tenant,run_id);self.assert_run_access(state)
        request=store.cancellation(self.tenant,run_id)
        if not request or not request['pending']:return False
        if state['status'] in TERMINAL:
            store.request_cancellation(self.tenant,run_id);return False
        if request['error']:return False
        with self.lock:
            if self.closed or self.cancel_jobs.get(run_id,{}).get('active'):return False
            job=self.jobs.get(run_id)
            if job and job.get('active'):
                job['cancel_requested']=True;job['cancel'].set()
                future=job.get('future')
                if future and future.cancel():
                    job['state']='SUPERSEDED';self._finish_job(run_id,job)
            if self.lease(run_id)['active'] or not self.has_job_capacity(cancellation=True,replacing=run_id):return False
            try:epoch=store.begin_execution(self.tenant,run_id,automatic=True,cancelling=True)
            except LeaseBusy:return False
            control={'active':True,'state':'QUEUED','purpose':'cancellation','cancel_requested':True,'error':None,'started_at':time.time(),'execution_epoch':epoch}
            self.cancel_jobs[run_id]=control
            try:control['future']=self.cancellation_pool.submit(self._cancel_work,run_id,control,request['generation'])
            except Exception:
                control.update(state='ERROR');retain=True
                try:
                    store.fail_cancellation(self.tenant,run_id,request['generation'],'停止处理暂时无法开始，请稍后重试停止。');retain=False
                finally:self._finish_job(run_id,control,cancellation=True,retain=retain)
            return True

    def _cancel_work(self,run_id,job,generation):
        runtime=None;retain=False
        try:
            with self.lock:job['state']='RUNNING'
            runtime=self.runtime();runtime.execution_epoch=job['execution_epoch']
            runtime.cancel(run_id,self.tenant,requested=True);job['state']='COMPLETED'
        except (LeaseBusy,LeaseLost):job['state']='SUPERSEDED'
        except Exception as exc:
            message='停止处理意外中断，请检查运行记录后重试停止。';job.update(state='ERROR',error=message)
            retain=True
            self.control_store.fail_cancellation(self.tenant,run_id,generation,message)
            epoch=runtime.execution_epoch if runtime and runtime.execution_epoch is not None else job['execution_epoch']
            self.control_store.interrupt_execution(self.tenant,run_id,epoch,kind='ERROR',code='cancellation_failed',message=message,exception_type=type(exc).__name__)
            retain=False
        finally:
            self._finish_job(run_id,job,cancellation=True,retain=retain)
            if job['state']=='COMPLETED':self._advance_conversation(run_id)

    def recover_cancellations(self):
        if self.closed:return
        with self.control_store.connect() as db:
            rows=db.execute('''SELECT q.run_id,w.id AS workspace FROM run_cancellations q
                JOIN runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id
                JOIN workspaces w ON w.tenant=r.tenant_id AND w.project=json_extract(r.state,'$.task.project_id')
                WHERE q.tenant_id=? AND q.completed_at IS NULL AND (json_extract(r.state,'$.task.principal')=? OR q.requested_by=?)
                AND (q.error IS NULL OR json_extract(r.state,'$.status') IN ('SUCCEEDED','FAILED','NEEDS_REVIEW','EXPIRED','CANCELLED'))
                AND (r.owner IS NULL OR r.lease_until<=?) ORDER BY q.requested_at,q.run_id LIMIT 64''',(self.tenant,self.principal,self.principal,time.time())).fetchall()
        for row in rows:
            if self.closed:return
            try:self.scoped(row['workspace']).schedule_cancellation(row['run_id'])
            except (KeyError,PolicyDenied):continue

    def mutate(self, run_id, action, data=None):
        identifier(run_id)
        data={} if data is None else data
        state = self.control_store.load(self.tenant, run_id)
        self.assert_run_access(state)
        if not isinstance(data,dict) or set(data)!=({'proof'} if action in ('grant','revoke') else set()):raise ValueError('请提交当前审查内容；其他运行操作不接受额外字段')
        if action == "cancel":
            request=self.control_store.request_cancellation(self.tenant,run_id,principal=self.principal,source='web',retry=True)
            with self.lock:
                job = self.jobs.get(run_id)
                if job and job["active"]:
                    job["cancel_requested"] = True
                    job["cancel"].set()
                    future=job.get('future')
                    if future and future.cancel():
                        job['state']='SUPERSEDED';self._finish_job(run_id,job)
            if request and request['pending']:
                if state['status']=='CREATED' and not self.lease(run_id)['active']:
                    try:self.runtime().cancel(run_id,self.tenant,requested=True);self._advance_conversation(run_id)
                    except (LeaseBusy,LeaseLost):pass
                    except Exception:self.control_store.fail_cancellation(self.tenant,run_id,request['generation'],'停止处理暂时不可用，请检查后重试停止。')
                self.schedule_cancellation(run_id)
        elif action == "resume":
            from .task_permissions import TaskPermissions
            permissions=TaskPermissions(self)
            if permissions.request(run_id):permissions.dispatch(run_id,retry=True)
            else:self.schedule(run_id)
        elif action in {"grant", "revoke"}:
            from .task_permissions import TaskPermissions
            permissions=TaskPermissions(self);permissions.change(run_id,action,data['proof'])
            if action=='grant':permissions.dispatch(run_id,proof=data['proof'])
        else:
            raise APIError(404, "未找到该操作")
        return self.detail(run_id)

    def close(self):
        self.scheduler_stop.set()
        self.conversation_stop.set()
        with self.lock:
            self._closed.set()
            for job in self.jobs.values():
                if job["active"]:
                    job["cancel"].set()
        if self.scheduler_thread:
            self.scheduler_thread.join(timeout=5)
        if self.conversation_thread:self.conversation_thread.join(timeout=2)
        self.pool.shutdown(wait=True, cancel_futures=False)
        self.cancellation_pool.shutdown(wait=True,cancel_futures=False)


class WebServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_timeout = 10
    stream_lifetime = 60

    def __init__(self, address, application):
        if address[0] not in {"127.0.0.1", "localhost"}:
            raise ValueError("Web UI 仅支持本机回环地址")
        self.application = application
        super().__init__(address, Handler)
        application.start_scheduler()
        application.start_conversation_dispatcher()


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentFramework"

    def setup(self):
        super().setup()
        self.connection.settimeout(self.server.request_timeout)

    def release_mutation_lock(self):
        lock=getattr(self,'_mutation_lock',None)
        if lock:
            self._mutation_lock=None
            lock.release()

    @staticmethod
    def is_stop_request(path):
        parts=path.strip('/').split('/')
        return (len(parts)==4 and parts[:2] in (['api','runs'],['api','workflow-runs']) and parts[3]=='cancel'
                or len(parts)==6 and parts[:2]==['api','tasks'] and parts[3]=='messages' and parts[5]=='cancel')

    @staticmethod
    def is_proposal_request(path):
        return path in ('/api/workflow-chat', '/api/learning-proposals')

    def read_json_body(self,path):
        lengths=self.headers.get_all('Content-Length',[])
        if self.headers.get_all('Transfer-Encoding') or len(lengths)>1:
            raise APIError(400,'请求正文长度不明确，请使用单个 Content-Length')
        length=int(lengths[0]) if lengths else 0
        limit=1_500_000 if path.startswith('/api/skills') or path.startswith('/api/agents') else 500000 if path.startswith(('/api/learning-proposals','/api/ontologies','/api/ontology-validate')) else 65536
        if not 0<length<=limit:raise APIError(413,'请求超过该接口的大小预算')
        # read1 returns available bytes so a trickling sender cannot keep resetting
        # an inactivity timeout indefinitely. No shared lock is held while reading.
        deadline=time.monotonic()+self.server.request_timeout
        chunks=[];remaining=length
        try:
            while remaining:
                timeout=deadline-time.monotonic()
                if timeout<=0:raise TimeoutError()
                self.connection.settimeout(timeout)
                chunk=self.rfile.read1(min(remaining,65536))
                if not chunk:raise APIError(400,'请求正文未完整接收，请重新提交')
                chunks.append(chunk);remaining-=len(chunk)
        except TimeoutError:
            self.close_connection=True
            raise APIError(408,'请求正文接收超时，请重新提交') from None
        finally:self.connection.settimeout(self.server.request_timeout)
        data=parse_json(b''.join(chunks).decode('utf-8'))
        if not isinstance(data,dict):raise ValueError('请求必须为 JSON 对象')
        return data

    def log_message(self, format, *args):
        pass

    def reply(self, status, body, content_type="application/json; charset=utf-8", filename=None):
        payload = json.dumps(body, ensure_ascii=False).encode() if content_type.startswith("application/json") else body.encode() if isinstance(body, str) else body
        # Freeze the response before allowing the next command, then release before
        # socket writes: a client which stops reading cannot stall other commands.
        self.release_mutation_lock()
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
        except (BrokenPipeError, ConnectionResetError,TimeoutError):
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

    def stream_task(self,app,identity):
        """Push persisted public snapshots; reconnect/reload replays the current text."""
        from .task_conversations import TaskConversations
        if app.closed or app.conversation_stop.is_set():raise APIError(503,'服务正在关闭')
        with app.stream_capacity.reserve():
            service=TaskConversations(app);initial=service.view(identity)
            self._stream_task(app,service,identity,initial)

    def _stream_peer_closed(self):
        # A quiet stream may not write for ten seconds. Notice peer EOF before
        # the next heartbeat so a closed/hidden tab promptly frees its slot.
        try:
            readable,_,_=select.select([self.connection],[],[],0)
            return bool(readable) and self.connection.recv(1,socket.MSG_PEEK)==b''
        except (OSError,ValueError):return True

    def _stream_task(self,app,service,identity,initial):
        last=None;heartbeat=0;deadline=time.monotonic()+self.server.stream_lifetime
        try:
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream; charset=utf-8')
            self.send_header('Cache-Control','no-cache, no-store')
            self.send_header('X-Accel-Buffering','no')
            self.send_header('Connection','close');self.end_headers();self.close_connection=True
            while not app.closed and not app.conversation_stop.is_set() and time.monotonic()<deadline:
                if self._stream_peer_closed():break
                view=initial if initial is not None else service.view(identity);initial=None
                payload=canonical(view)
                if payload!=last:
                    self.wfile.write(('event: conversation\ndata: '+payload+'\n\n').encode());self.wfile.flush()
                    last=payload;heartbeat=time.monotonic()
                elif time.monotonic()-heartbeat>=10:
                    self.wfile.write(b': keep-alive\n\n');self.wfile.flush();heartbeat=time.monotonic()
                if not view['can_reply'] or (view.get('interruption') and not (view.get('cancellation') or {}).get('pending')) or (view.get('cancellation') or {}).get('error') or (not view['active'] and not view['queued_count']):
                    self.wfile.write(b'event: settled\ndata: {}\n\n');self.wfile.flush();break
                app.conversation_stop.wait(.08)
        except (BrokenPipeError,ConnectionResetError,TimeoutError,OSError,KeyError,PolicyDenied,ValueError):pass
        except Exception:
            # Headers already selected SSE. End the stream; do not append a
            # second HTTP/JSON response to a partially delivered event stream.
            logging.getLogger(__name__).exception('Conversation stream ended unexpectedly')

    def dispatch(self, mutation=False):
        self._mutation_lock=None
        try:
            self.guard(mutation)
            app = self.server.application
            path = urlsplit(self.path).path
            query = parse_qs(urlsplit(self.path).query)
            data = None
            if mutation:
                data=self.read_json_body(path)
                if not (self.is_stop_request(path) or self.is_proposal_request(path)):
                    app.mutation_lock.acquire()
                    self._mutation_lock=app.mutation_lock
            assets = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/commands.js": ("commands.js", "text/javascript; charset=utf-8"),
                      "/run_view.js": ("run_view.js", "text/javascript; charset=utf-8"),
                      "/task_text_search.js": ("task_text_search.js", "text/javascript; charset=utf-8"),
                      "/task_message_history.js": ("task_message_history.js", "text/javascript; charset=utf-8"),
                      "/task_export.js": ("task_export.js", "text/javascript; charset=utf-8"),
                      "/task_reuse.js": ("task_reuse.js", "text/javascript; charset=utf-8"),
                      "/task_relations.js": ("task_relations.js", "text/javascript; charset=utf-8"),
                      "/runtime_settings.js": ("runtime_settings.js", "text/javascript; charset=utf-8"),
                      "/task_message_edit.js": ("task_message_edit.js", "text/javascript; charset=utf-8"),
                      "/task_message.js": ("task_message.js", "text/javascript; charset=utf-8"),
                      "/task_archive.js": ("task_archive.js", "text/javascript; charset=utf-8"),
                      "/task_cleanup.js": ("task_cleanup.js", "text/javascript; charset=utf-8"),
                      "/task_favorites.js": ("task_favorites.js", "text/javascript; charset=utf-8"),
                      "/task_names.js": ("task_names.js", "text/javascript; charset=utf-8"),
                      "/chat_draft.js": ("chat_draft.js", "text/javascript; charset=utf-8"),
                      "/run_inspector.js": ("run_inspector.js", "text/javascript; charset=utf-8"),
                      "/run_action.js": ("run_action.js", "text/javascript; charset=utf-8"),
                      "/run_view.css": ("run_view.css", "text/css; charset=utf-8"),
                      "/task_conversation.js": ("task_conversation.js", "text/javascript; charset=utf-8"),
                      "/task_dialog_return.js": ("task_dialog_return.js", "text/javascript; charset=utf-8"),
                      "/task_reply_copy.js": ("task_reply_copy.js", "text/javascript; charset=utf-8"),
                      "/task_conversation.css": ("task_conversation.css", "text/css; charset=utf-8"),
                      "/conversation_ui.css": ("conversation_ui.css", "text/css; charset=utf-8"),
                      "/agents.js": ("agents.js", "text/javascript; charset=utf-8"),
                      "/agent_draft.js": ("agent_draft.js", "text/javascript; charset=utf-8"),
                      "/form_controls.js": ("form_controls.js", "text/javascript; charset=utf-8"),
                      "/agent_experience.js": ("agent_experience.js", "text/javascript; charset=utf-8"),
                      "/library.js": ("library.js", "text/javascript; charset=utf-8"),
                      "/library_navigation.js": ("library_navigation.js", "text/javascript; charset=utf-8"),
                      "/asset_save.js": ("asset_save.js", "text/javascript; charset=utf-8"),
                      "/asset_draft.js": ("asset_draft.js", "text/javascript; charset=utf-8"),
                      "/workspaces.js": ("workspaces.js", "text/javascript; charset=utf-8"),
                      "/roles.js": ("roles.js", "text/javascript; charset=utf-8"),
                      "/agent_domains.js": ("agent_domains.js", "text/javascript; charset=utf-8"),
                      "/workflows.js": ("workflows.js", "text/javascript; charset=utf-8"),
                      "/workflow_chat_request.js": ("workflow_chat_request.js", "text/javascript; charset=utf-8"),
                      "/workflow_designer.js": ("workflow_designer.js", "text/javascript; charset=utf-8"),
                      "/workflow_save.js": ("workflow_save.js", "text/javascript; charset=utf-8"),
                      "/workflow_draft.js": ("workflow_draft.js", "text/javascript; charset=utf-8"),
                      "/workflow_start.js": ("workflow_start.js", "text/javascript; charset=utf-8"),
                      "/workflow_control.js": ("workflow_control.js", "text/javascript; charset=utf-8"),
                      "/workflow_grant.js": ("workflow_grant.js", "text/javascript; charset=utf-8"),
                      "/skills.js": ("skills.js", "text/javascript; charset=utf-8"),
                      "/skill_save.js": ("skill_save.js", "text/javascript; charset=utf-8"),
                      "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                      "/hig.css": ("hig.css", "text/css; charset=utf-8"),
                      "/ui_details.css": ("ui_details.css", "text/css; charset=utf-8"),
                      "/agents.css": ("agents.css", "text/css; charset=utf-8"),
                      "/domains.css": ("domains.css", "text/css; charset=utf-8"),
                      "/domains.js": ("domains.js", "text/javascript; charset=utf-8"),
                      "/form_controls.css": ("form_controls.css", "text/css; charset=utf-8"),
                      "/appearance.js": ("appearance.js", "text/javascript; charset=utf-8"),
                      "/help.js": ("help.js", "text/javascript; charset=utf-8"),
                      "/agent_directory_history.js": ("agent_directory_history.js", "text/javascript; charset=utf-8"),
                      "/journeys.js": ("journeys.js", "text/javascript; charset=utf-8"),
                      "/task_submission.js": ("task_submission.js", "text/javascript; charset=utf-8"),
                      "/learning_request.js": ("learning_request.js", "text/javascript; charset=utf-8"),
                      "/ontology_save.js": ("ontology_save.js", "text/javascript; charset=utf-8"),
                      "/markdown-it-15.0.3.min.js": ("markdown-it-15.0.3.min.js", "text/javascript; charset=utf-8"),
                      "/reply_markdown.js": ("reply_markdown.js", "text/javascript; charset=utf-8"),
                      "/reply_markdown.css": ("reply_markdown.css", "text/css; charset=utf-8"),
                      "/task_search.js": ("task_search.js", "text/javascript; charset=utf-8"),
                      "/task_search.css": ("task_search.css", "text/css; charset=utf-8"),
                      "/learning_review.js": ("learning_review.js", "text/javascript; charset=utf-8"),
                      "/learning.js": ("learning.js", "text/javascript; charset=utf-8"),
                      "/operations.js": ("operations.js", "text/javascript; charset=utf-8"),
                      "/evaluation_alerts.js": ("evaluation_alerts.js", "text/javascript; charset=utf-8"),
                      "/evaluation_history.js": ("evaluation_history.js", "text/javascript; charset=utf-8"),
                      "/run_history.js": ("run_history.js", "text/javascript; charset=utf-8"),
                      "/attention.js": ("attention.js", "text/javascript; charset=utf-8"),
                      "/ontology_model.js": ("ontology_model.js", "text/javascript; charset=utf-8"),
                      "/ontology_evidence.js": ("ontology_evidence.js", "text/javascript; charset=utf-8"),
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
                if not mutation and space_path[3]=='deletion-check':
                    return self.reply(200,app.workspaces.deletion_check(identity))
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
            if len(operations_path) == 3 and operations_path[:2] == ['api', 'daily-plans'] and not mutation:
                from .workspace_scheduler import WorkspaceScheduler
                return self.reply(200, WorkspaceScheduler(app).detail(identifier(operations_path[2])))
            if path == '/api/agent-evaluations' and not mutation:
                from .agent_evaluation import AgentEvaluations
                params=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                if 'view' in params:
                    if params.pop('view')!=['page'] or set(params)-{'search','agent_id','verdict','period','limit','cursor'} or any(len(v)!=1 for v in params.values()):raise ValueError('评测历史查询参数无效')
                    return self.reply(200,AgentEvaluations(app).page(**{k:v[0] for k,v in params.items()}))
                return self.reply(200, AgentEvaluations(app).overview())
            if path == '/api/agent-alerts' and not mutation:
                from .agent_evaluation import AgentEvaluations
                params=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                if any(len(params.get(key,[]))>1 for key in ('status','agent_id','limit','cursor')):raise ValueError('提醒查询参数重复')
                return self.reply(200,AgentEvaluations(app).alert_page(params.get('status',['open'])[0],agent_id=params.get('agent_id',[None])[0],limit=params.get('limit',['50'])[0],cursor=params.get('cursor',[None])[0]))
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
                return self.reply(200,app.discard_task_draft(data))
            if path == '/api/agent-evaluations/evaluate' and mutation:
                from .agent_evaluation import AgentEvaluations
                if set(data) - {'run_id'}:raise ValueError('评测参数无效')
                return self.reply(200, AgentEvaluations(app).evaluate(data.get('run_id')))
            if len(operations_path) == 3 and operations_path[:2] == ['api', 'agent-evaluations'] and not mutation:
                from .agent_evaluation import AgentEvaluations
                return self.reply(200, AgentEvaluations(app).get(identifier(operations_path[2])))
            if path == '/api/evaluation-policy':
                from .agent_evaluation import AgentEvaluations
                service = AgentEvaluations(app)
                return self.reply(200, service.save_policy(data) if mutation else service.settings())
            if len(operations_path) == 4 and operations_path[:2] == ['api', 'agent-alerts'] and operations_path[3] == 'acknowledge' and mutation:
                from .agent_evaluation import AgentEvaluations
                if data:raise ValueError('确认提醒不接受额外字段')
                return self.reply(200, AgentEvaluations(app).acknowledge(identifier(operations_path[2])))
            if path=='/api/knowledge-hub' and not mutation:
                from .knowledge_hub import hub
                query=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                if any(len(query.get(key,[]))>1 for key in ('query','memory_page','memory_cursor','memory_limit')):raise ValueError('知识库查询参数重复')
                mode=query.get('memory_page',['0'])[0]
                if mode not in ('0','1') or (mode!='1' and any(key in query for key in ('memory_cursor','memory_limit'))):raise ValueError('记忆分页参数无效')
                return self.reply(200,hub(app,query.get('query',[''])[0],memory_page=mode=='1',memory_cursor=query.get('memory_cursor',[None])[0],memory_limit=query.get('memory_limit',['50'])[0]))
            if path=='/api/learning-proposals':
                from .learning import Learning
                learning=Learning(app)
                return self.reply(201,learning.generate(data)) if mutation else self.reply(200,learning.page(query.get('run_id',[None])[0],query.get('purpose',[None])[0],limit=query.get('limit',['200'])[0],cursor=query.get('cursor',[None])[0]))
            learning_request_path=path.strip('/').split('/')
            if len(learning_request_path)==3 and learning_request_path[:2]==['api','learning-requests'] and not mutation:
                from .learning import Learning
                try:proposal=Learning(app).get_by_request(identifier(learning_request_path[2]))
                except KeyError:return self.reply(404,{'error':'尚未找到此次生成请求，可以稍后再次核对；暂未找到不代表在途生成已停止','code':'learning_request_not_found'})
                return self.reply(200,proposal)
            learning_path=path.strip('/').split('/')
            if len(learning_path)==3 and learning_path[:2]==['api','learning-writes'] and not mutation:
                from .learning import Learning
                from .learning_writes import status
                if len(query.get('proposal_id',[]))!=1:raise ValueError('核对写入需要原提案编号')
                return self.reply(200,status(Learning(app),identifier(learning_path[2]),query['proposal_id'][0]))
            if len(learning_path)==3 and learning_path[:2]==['api','ontology-saves'] and not mutation:
                from .ontology import save_status
                if len(query.get('base_ref',[]))!=1:raise ValueError('核对保存需要原本体版本引用')
                return self.reply(200,save_status(app.library(),app.library_access(),identifier(learning_path[2]),query['base_ref'][0]))
            if len(learning_path)==4 and learning_path[:3]==['api','learning','run'] and not mutation:
                from .learning import Learning
                return self.reply(200,Learning(app).run_context(identifier(learning_path[3])))
            if len(learning_path) in (3,4) and learning_path[:2]==['api','learning-proposals']:
                from .learning import Learning
                service=Learning(app);identity=identifier(learning_path[2])
                if len(learning_path)==3:
                    return self.reply(200,service.save(identity,data)) if mutation else self.reply(200,service.get(identity))
                if mutation and learning_path[3]=='deposit':return self.reply(200,service.deposit(identity,data))
                if mutation and learning_path[3]=='repair':return self.reply(201,service.repair(identity,data))
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
                if mutation and learning_path[3]=='activate':
                    from .ontology import activate
                    return self.reply(200,activate(app.library(),app.library_access(),ref,data))
                if mutation and learning_path[3]=='revise':return self.reply(201,revise(app.library(),app.library_access(),ref,data))
                if learning_path[3]=='evidence':
                    from .ontology_evidence import read,save
                    return self.reply(200,save(app.library(),app.library_access(),ref,data) if mutation else read(app.library(),app.library_access(),ref))
                if not mutation and learning_path[3]=='export':
                    from .ontology_evidence import records,jsonld
                    document=export_jsonld(asset)
                    document['@graph'].extend(jsonld(asset,records(app.library(),app.library_access(),asset)))
                    return self.reply(200,json.dumps(document,ensure_ascii=False),'application/ld+json; charset=utf-8','ontology.jsonld')
                if not mutation and learning_path[3]=='validate':
                    from .ontology_model import validation_report
                    from .ontology import sources_current
                    report=validation_report(asset['content'],{s['ref'] for s in asset['provenance']['sources']})
                    report['sources_current']=sources_current(app.library(),app.library_access(),asset)
                    report['effective']=asset['effective_at']<=time.time()<asset['effective_until']
                    if not report['effective']:
                        report['conforms']=False
                        report['results'].append({'focus_node':asset['ref'],'path':'effective_at/effective_until','constraint':'AssetEffectiveConstraint','severity':'Violation','message':'本体尚未生效或已过期','value':None})
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
                return self.reply(201,app.save_skill(data)) if mutation else self.reply(200,{'skills':app.skills().list(),'specification':'https://agentskills.io/specification'})
            receipt_path=path.strip('/').split('/')
            if len(receipt_path)==3 and receipt_path[:2]==['api','skill-saves'] and not mutation:
                from .skills import SkillSaveReceiptNotFound
                try:receipt=app.skills().save_request(identifier(receipt_path[2]),principal=app.principal)
                except SkillSaveReceiptNotFound:return self.reply(404,{'error':'尚未找到 Skill 保存回执','code':'skill_save_not_found'})
                return self.reply(200,receipt)
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
                if len(skill_path)==3:return self.reply(200,app.save_skill(data,identity)) if mutation else self.reply(200,registry.get(identity,version))
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
                if not mutation and query.get('view')==['definitions']:return self.reply(200,{'workflows':app.workflows().list()})
                return self.reply(201,app.workflows().save(data)) if mutation else self.reply(200,{'workflows':app.workflows().list(),'runs':app.flow_runs()})
            if len(receipt_path)==3 and receipt_path[:2]==['api','workflow-starts'] and not mutation:
                from .workflows import WorkflowStartReceiptNotFound
                key=identifier(receipt_path[2])
                try:run=app.workflows().start_request(key)
                except WorkflowStartReceiptNotFound:return self.reply(404,{'error':'尚未找到这次工作流启动的运行记录','code':'workflow_start_not_found'})
                return self.reply(200,{'request_id':key,**app.flow_detail(run['id'])})
            if len(receipt_path)==3 and receipt_path[:2]==['api','workflow-saves'] and not mutation:
                from .workflows import WorkflowSaveReceiptNotFound
                try:receipt=app.workflows().save_request(identifier(receipt_path[2]))
                except WorkflowSaveReceiptNotFound:return self.reply(404,{'error':'尚未找到工作流保存回执','code':'workflow_save_not_found'})
                return self.reply(200,receipt)
            if path=='/api/workflow-runs' and not mutation:
                params=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                if set(params)-{'search','status','limit','cursor'} or any(len(v)!=1 for v in params.values()):raise ValueError('流程查询参数无效')
                return self.reply(200,app.workflows().page(**{k:v[0] for k,v in params.items()}))
            if path=='/api/workflow-chat':
                from .workflow_chat import WorkflowChat
                from .workflow_chat_requests import WorkflowChatRequests
                return self.reply(200,WorkflowChatRequests(app).reply(data)) if mutation else self.reply(200,{'conversations':WorkflowChat(app).list()})
            route=path.strip('/').split('/')
            if len(route)==3 and route[:2]==['api','workflow-chat-requests'] and not mutation:
                from .workflow_chat_requests import WorkflowChatRequests,WorkflowChatRequestNotFound
                try:receipt=WorkflowChatRequests(app).get(identifier(route[2]))
                except WorkflowChatRequestNotFound:return self.reply(404,{'error':'尚未找到设计请求','code':'workflow_chat_request_not_found'})
                return self.reply(200,receipt)
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
                    app.enqueue_flow(run['id'])
                    return self.reply(202,app.flow_detail(run['id']))
            if len(route) in (3,4) and route[:2]==['api','workflow-runs']:
                identity=identifier(route[2]);flows=app.workflows()
                if not mutation and len(route)==3:return self.reply(200,app.flow_detail(identity))
                if mutation and len(route)==4:
                    if route[3]=='grant':
                        if set(data)!={'node_id','proposal_token'}:raise ValueError('请刷新运行详情并审查具体提案后授权')
                        flows.grant(identity,data['node_id'],data['proposal_token']);app.enqueue_flow(identity)
                    elif route[3]=='resume':
                        if data:raise ValueError('恢复不接受额外字段')
                        app.schedule_flow(identity)
                    elif route[3]=='cancel':
                        if data:raise ValueError('取消不接受额外字段')
                        flows.cancel(identity)
                        app.enqueue_flow(identity)
                    else:raise ValueError('未知工作流操作')
                    return self.reply(202,app.flow_detail(identity))
            if path.startswith('/api/runtime-config/requests/') and not mutation:
                request_id=path.removeprefix('/api/runtime-config/requests/')
                return self.reply(200,app.configuration.inspect_request(request_id,app.principal))
            if path == "/api/runtime-config":
                if mutation:
                    if isinstance(data,dict) and 'request_id' in data:return self.reply(200,app.configuration.accept(data,app.principal))
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
                           '/api/domain-packs': {'domain_packs': [get_domain('general-assistant@1.0.0').descriptor(),DOMAIN.descriptor(),get_domain('knowledge-answer@1.0.0').descriptor()]},
                           '/api/agent-definition-default': {'definition': default_definition(domain_ref=query.get('domain',['change-assessment@2.0.0'])[0])}}
                return self.reply(200, catalog[path])
            if path == '/api/agents':
                if mutation:return self.reply(201,app.save_agent(data))
                view=query.get('view',['full'])
                if len(view)!=1 or view[0] not in ('full','catalog'):raise ValueError('Agent 读取方式无效')
                return self.reply(200,{'agents':app.agents.catalog() if view[0]=='catalog' else app.agents.list()})
            if path == '/api/agent-domains':
                from .agent_domains import AgentDomains
                domains = AgentDomains(app.agents.store, app.tenant, app.workspace['id'])
                return self.reply(201, domains.create(data)) if mutation else self.reply(200, {
                    'domains': domains.catalog() if query.get('include_archived', ['0'])[0] == '1' else domains.list()})
            domain_path = path.strip('/').split('/')
            if len(domain_path) in (3, 4) and domain_path[:2] == ['api', 'agent-domains']:
                from .agent_domains import AgentDomains
                domains = AgentDomains(app.agents.store, app.tenant, app.workspace['id'])
                identity = identifier(domain_path[2])
                if len(domain_path) == 3:
                    return self.reply(200, domains.update(identity, data)) if mutation else self.reply(200, domains.get(identity, include_archived=True))
                if mutation and domain_path[3] == 'archive':
                    return self.reply(200, domains.archive(identity, data))
            agent_path = path.strip('/').split('/')
            if not mutation and len(agent_path)==4 and agent_path[:3]==['api','agents','save-requests']:
                try:receipt=app.agents.save_request(identifier(agent_path[3]),principal=app.principal)
                except KeyError:raise APIError(404,'未找到此次保存回执，请保留本页设置并重试保存') from None
                return self.reply(200,receipt)
            if len(agent_path) in (3,4) and agent_path[:2]==['api','agents']:
                identity=identifier(agent_path[2])
                if len(agent_path)==3:
                    return self.reply(200, app.save_agent(data,identity)) if mutation else self.reply(200, app.agents.get(identity))
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
                keyed='request_id' in payload;request_id=payload.pop('request_id',None)
                if keyed and request_id is None:raise ValueError('保存编号无效')
                return self.reply(201,app.library().create(scope,payload,request_id=request_id) if keyed else app.library().create(scope,payload))
            asset_save_path=path.strip('/').split('/')
            if len(asset_save_path)==3 and asset_save_path[:2]==['api','asset-saves'] and not mutation:
                from .knowledge import AssetSaveReceiptNotFound
                try:receipt=app.library().save_request(app.library_access(),identifier(asset_save_path[2]))
                except AssetSaveReceiptNotFound:return self.reply(404,{'error':'尚未找到资料保存回执；暂未找到不代表在途保存已停止','code':'asset_save_not_found'})
                return self.reply(200,receipt)
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
                from .memory import episodes,page
                query=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                if any(len(query.get(key,[]))>1 for key in ('query','project_id','view','cursor','limit')):raise ValueError('记忆查询参数重复')
                mode=query.get('view',[''])[0]
                if mode not in ('','page') or (mode!='page' and any(key in query for key in ('cursor','limit'))):raise ValueError('记忆分页参数无效')
                scope=app.library_access(query.get('project_id',[None])[0]);term=query.get('query',[''])[0]
                if mode=='page':return self.reply(200,page(app.runtime().store,scope,term,limit=query.get('limit',['50'])[0],cursor=query.get('cursor',[None])[0]))
                return self.reply(200,{'episodes':episodes(app.runtime().store,scope,term)})
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
            if path == '/api/tasks' and mutation:
                return self.reply(202, app.start_task(data))
            submission_path=path.strip('/').split('/')
            if not mutation and len(submission_path)==3 and submission_path[:2]==['api','task-submissions']:
                try:receipt=app.task_submission(identifier(submission_path[2]))
                except KeyError:raise APIError(404,'尚未找到此次提交的任务，可以沿用原编号重试；暂未找到不代表在途请求已停止') from None
                return self.reply(200,receipt)
            task_path=path.strip('/').split('/')
            if len(task_path)>=3 and task_path[:2]==['api','tasks']:
                from .task_conversations import TaskConversations
                service=TaskConversations(app);identity=identifier(task_path[2])
                if len(task_path)==3 and not mutation:return self.reply(200,app.detail(service.root_id(identity)))
                if len(task_path)==4 and task_path[3]=='stream' and not mutation:return self.stream_task(app,identity)
                if len(task_path)==4 and task_path[3]=='archive':
                    from .task_archive import inspect
                    return self.reply(200,app.archive_task(identity,data) if mutation else inspect(app,identity))
                if len(task_path)==4 and task_path[3]=='favorite':
                    from .task_favorites import inspect
                    return self.reply(200,app.favorite_task(identity,data) if mutation else inspect(app,identity))
                if len(task_path)==4 and task_path[3]=='name':
                    from .task_names import inspect
                    return self.reply(200,app.rename_task(identity,data) if mutation else inspect(app,identity))
                if len(task_path)==4 and task_path[3]=='cleanup-review':
                    from .task_cleanup import inspect,review
                    return self.reply(200,review(app,identity,data) if mutation else inspect(app,identity))
                if len(task_path)==4 and task_path[3]=='relations' and not mutation:
                    from .task_relations import relations
                    return self.reply(200,relations(app,identity,query))
                if len(task_path)==4 and task_path[3]=='export' and not mutation:
                    kind=query.get('kind',['markdown'])[0]
                    if kind not in {'json','markdown','bundle'}:raise ValueError('对话导出格式仅支持 json、markdown 或 bundle')
                    if kind=='bundle':
                        from .task_exports import zip_bundle
                        payload=zip_bundle(app,identity)
                        return self.reply(200,payload,'application/zip',service.root_id(identity)+'-task-export.zip')
                    conversation=service.export(identity)
                    if kind=='json':return self.reply(200,conversation,filename=conversation['id']+'-conversation.json')
                    from .exports import conversation_markdown
                    text=conversation_markdown(conversation)
                    return self.reply(200,text,'text/markdown; charset=utf-8',conversation['id']+'-conversation.md')
                if len(task_path)==4 and task_path[3]=='messages' and mutation:return self.reply(202,service.append(identity,data))
                if len(task_path)==5 and task_path[3]=='message-submissions' and not mutation:
                    try:receipt=service.message_submission(identity,task_path[4])
                    except KeyError:raise APIError(404,'暂未找到此次发送的消息；不代表在途请求已停止，请沿用原编号核对或重试') from None
                    return self.reply(200,receipt)
                if len(task_path)==6 and task_path[3]=='messages' and task_path[5]=='edits' and not mutation:
                    from .task_message_history import history
                    return self.reply(200,history(app,identity,int(task_path[4]),query))
                if len(task_path)==6 and task_path[3]=='messages' and task_path[5]=='edit':
                    from .task_message_edits import update,inspect
                    return self.reply(200,update(app,identity,int(task_path[4]),data) if mutation else inspect(app,identity,int(task_path[4]),query.get('request_id',[None])[0]))
                if len(task_path)==6 and task_path[3]=='messages' and task_path[5]=='cancel' and mutation:
                    return self.reply(200,service.cancel_queued(identity,int(task_path[4]),data))
                if len(task_path)==6 and task_path[3]=='messages' and task_path[5]=='retry':
                    number=int(task_path[4])
                    if mutation:return self.reply(202,service.retry(identity,number,data))
                    try:receipt=service.retry_submission(identity,number)
                    except KeyError:raise APIError(404,'暂未找到本轮重试；不代表在途请求已停止，可核对后重试同一轮') from None
                    return self.reply(200,receipt)
            if path == "/api/runs":
                return self.reply(202, app.create(data)) if mutation else self.reply(200, app.runs(query))
            pieces = path.strip("/").split("/")
            if len(pieces) in (3, 4) and pieces[:2] == ["api", "runs"]:
                run_id = identifier(pieces[2])
                if mutation and len(pieces) == 4:
                    return self.reply(202, app.mutate(run_id, pieces[3],data))
                if not mutation and len(pieces)==4 and pieces[-1]=='context-manifests':
                    runtime=app.runtime();run=runtime.store.load(app.tenant,run_id)
                    app.assert_run_access(run)
                    if run['task']['principal']!=app.principal:raise PolicyDenied('context belongs to another principal')
                    return self.reply(200,{'manifests':runtime.store.contexts(app.tenant,run_id)})
                if not mutation and len(pieces) == 3:
                    return self.reply(200, app.detail(run_id))
                if not mutation and pieces[-1] == "download":
                    detail = app.run_export(run_id)
                    kind = query.get("kind", ["result"])[0]
                    if kind=='bundle':
                        from .exports import zip_bundle
                        return self.reply(200,zip_bundle(detail),'application/zip',run_id+'-export.zip')
                    if kind == "result":
                        return self.reply(200, detail["run"], filename=run_id + ".json")
                    if kind == "events":
                        return self.reply(200, "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in detail["events"]), "application/x-ndjson; charset=utf-8", run_id + "-events.jsonl")
                    if kind == "report" and detail["run"]["report"]:
                        from .exports import report_markdown
                        text=report_markdown(detail['run'])
                        return self.reply(200, text, "text/markdown; charset=utf-8", run_id + "-report.md")
                    raise APIError(404, "所请求的导出内容尚不存在")
            raise APIError(404, "未找到该页面或接口")
        except PolicyDenied as exc:
            self.reply(403, {'error':str(exc)})
        except ConfigConflict as exc:
            self.reply(409, {"error": str(exc)})
        except ProposalCapacityBusy as exc:
            self.reply(503, {'error': str(exc), 'code': 'proposal_capacity_full'})
        except StreamCapacityBusy as exc:
            self.reply(503, {'error': str(exc), 'code': 'stream_capacity_full'})
        except APIError as exc:
            self.reply(exc.status, {"error": str(exc)})
        except KeyError as exc:
            message=('当前工作空间不存在或已删除，请在工作空间管理中检查或恢复后重试'
                     if exc.args==('workspace unavailable',) else '未找到该运行')
            self.reply(404, {"error": message})
        except (LeaseBusy, LeaseLost):
            self.reply(409, {"error": "运行正在执行或租约尚未释放，请稍后重试"})
        except (ValueError, TypeError, UnicodeDecodeError) as exc:
            self.reply(400, {"error": str(exc)})
        except Exception:
            logging.exception("Web API request failed")
            self.reply(500, {"error": "请求处理失败，请刷新页面并检查本地服务日志"})
        finally:
            self.release_mutation_lock()

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
