"""Bounded state machine: durable intent -> dispatch -> observe -> verify/recover."""

from importlib.resources import files
from dataclasses import asdict
import json
from pathlib import Path
from contextlib import nullcontext
import threading
import time

from .contracts import AgentSpec, Decision, PolicyDenied, TERMINAL, TaskContract, ToolFailure, canonical, digest
from .gateway import Gateway
from .llm import CodexConfig, LLMPlanner, ModelError
from .mock_tools import MockSystem, SCENARIOS
from .planner import MockPlanner, context_bundle
from .store import Store
from .definitions import AgentCompiler, domain_for, resolve_capability, get_domain, domain_runtime_settings


class CrashInjected(BaseException):
    """Simulates process loss before the external receipt is checkpointed."""


def legacy_registry_snapshot(planner=None, agent_profile=None):
    root = files("agent_framework").joinpath("resources")
    agent = json.loads(root.joinpath("agent.json").read_text(encoding="utf-8"))
    if agent_profile:
        from .agents import agent_ref
        agent['ref'] = agent_ref(agent_profile)
        agent['identity'] = {**agent['identity'], 'name':agent_profile['name']}
    AgentSpec(**agent)
    skill = {"ref": "release-risk-analysis@1.0.0", "instructions": root.joinpath("change-assessment.md").read_text(encoding="utf-8"),
             "manifest": json.loads(root.joinpath("capability.json").read_text(encoding="utf-8"))}
    snapshot = {"agent": agent, "skill": skill, "planner_ref": "mock-planner@1.0.0", "verifier_ref": "release-verifier@1.0.0"}
    if agent_profile:
        snapshot['agent_profile'] = agent_profile
    if isinstance(planner, LLMPlanner):
        snapshot["planner_ref"] = planner.descriptor()["ref"]
        snapshot["planner"] = planner.descriptor()
    return {**snapshot, "hash": digest(snapshot)}


def registry_snapshot(planner=None, agent_profile=None, domain_ref="change-assessment@2.0.0",execution_mode=None):
    compiled = AgentCompiler().compile(agent_profile,domain_ref,execution_mode=execution_mode)
    definition = compiled['definition']
    snapshot = {'agent': {'ref': compiled['ref'], 'identity': definition['identity'],
                         'responsibilities': definition['responsibilities'], 'standards': definition['standard_refs'],
                         'capabilities': definition['capability_refs'], 'skill_ref': definition['skill_refs'][0],
                         'policy_ref': definition['policy_ref']},
                'skill': compiled['domain_pack']['skill'], 'schema_version': 2,
                'planner_ref': 'mock-planner@1.0.0', 'verifier_ref': compiled['domain_pack']['verifier_ref']}
    if agent_profile:
        snapshot['agent_profile'] = agent_profile
    if isinstance(planner, LLMPlanner):
        descriptor = planner.descriptor()
        snapshot.update(planner_ref=descriptor['ref'], planner=descriptor)
        if agent_profile and compiled['runtime'] != descriptor:
            raise ValueError('cognitive runtime does not match compiled Agent binding')
        compiled['runtime'] = descriptor
        compiled['hash'] = digest({k: v for k, v in compiled.items() if k != 'hash'})
    elif agent_profile and agent_profile['runtime'] != 'mock':
        raise ValueError('real-model Agent requires its compiled cognitive runtime')
    snapshot['compiled_agent'] = compiled
    return {**snapshot, 'hash': digest(snapshot)}


class Runtime:
    def __init__(self, data_dir=".agent-data", planner=None, lease_seconds=10, tool_timeout=2):
        self.data_dir = Path(data_dir).resolve()
        if lease_seconds <= tool_timeout:
            raise ValueError("lease duration must exceed the worker timeout")
        self.store = Store(self.data_dir / "runtime.sqlite3")
        self.external = MockSystem(self.data_dir / "mock-business.sqlite3")
        self.gateway = Gateway(self.store, self.external.path, tool_timeout)
        self.planner = planner or MockPlanner()
        self._explicit_planner = planner is not None
        self._domain_mock = planner is None or type(planner) is MockPlanner
        self.lease_seconds = lease_seconds
        self._state_lock = threading.RLock()

    @staticmethod
    def is_write(state, action):
        return resolve_capability(state['snapshot'], action['tool_ref'])['effect'] == 'WRITE'

    def submit(self, task=None, scenario="normal", grant=True, agent_profile=None, run_id=None):
        task = task or TaskContract()
        if agent_profile:
            from .agents import agent_ref
            if task.agent_ref != agent_ref(agent_profile):
                raise ValueError('Agent reference does not match frozen definition')
        elif task.agent_ref not in ('release-assistant@1.0.0','knowledge-assistant@1.0.0','general-assistant@1.0.0'):
            raise ValueError('custom Agent requires a registered profile')
        if scenario not in SCENARIOS:
            raise ValueError("unknown fault scenario")
        if agent_profile and (agent_profile.get('definition') or {}).get('domain_pack_ref','change-assessment@2.0.0') != task.domain_pack_ref:
            raise ValueError('task domain differs from compiled Agent')
        domain = get_domain(task.domain_pack_ref)
        settings = domain_runtime_settings(domain.ref)
        if scenario not in settings['scenarios']:
            raise ValueError('scenario is not supported by this DomainPack')
        if isinstance(self.planner,LLMPlanner):
            self.planner.domain_pack_ref=settings['cognitive_domain_ref']
            self.planner.execution_mode=task.execution_mode
        if task.execution_mode in ('direct','conversation') and scenario!='normal':raise ValueError('normal tasks do not use fault scenarios')
        if task.execution_mode is None and task.change_id!='unresolved-change' and any(resolve_capability({},ref)['effect']=='WRITE' for ref in domain.capabilities):
            self.external.seed(task.to_dict())
        snapshot = registry_snapshot(self.planner, agent_profile,task.domain_pack_ref,execution_mode=task.execution_mode)
        from .knowledge import Library
        snapshot.pop('hash')
        snapshot['context_policy'] = Library(self.store).binding(task.to_dict(), snapshot['compiled_agent']['definition']['knowledge_spaces'], snapshot['compiled_agent']['definition']['standard_refs'])
        snapshot['hash'] = digest(snapshot)
        return self.store.create(task, snapshot, scenario, grant=grant and task.execution_mode is None and scenario != "denied", run_id=run_id)

    def checkpoint(self, state, lease, kind, data=None, **kwargs):
        with self._state_lock:
            self.store.checkpoint(state, lease, kind, data, **kwargs)

    def cognize(self, state, lease, method):
        """Heartbeat while inference blocks; only the fenced runtime may apply its output."""
        stopped, failures = threading.Event(), []

        def heartbeat():
            while not stopped.wait(min(self.lease_seconds / 3, 1)):
                try:
                    with self._state_lock:
                        self.store.renew(state, lease, self.lease_seconds)
                except Exception as exc:
                    failures.append(exc)
                    return

        def observe(kind, data):
            if failures:
                raise failures[0]
            if kind == "model.requested":
                if state.get("model_calls", 0) >= state["task"]["budget"].get("max_model_calls", 24):
                    raise ModelError("model_call_budget")
                state["model_calls"] = state.get("model_calls", 0) + 1
            if kind == "model.responded":
                usage = data.get("usage", {})
                tokens = sum(usage.get(k, 0) for k in ("input_tokens", "output_tokens") if type(usage.get(k, 0)) is int and usage.get(k, 0) >= 0)
                state["model_tokens"] = state.get("model_tokens", 0) + tokens
            self.checkpoint(state, lease, kind, data)
            if state.get("model_tokens", 0) > state["task"]["budget"].get("max_model_tokens", 200000):
                raise ModelError("model_token_budget")

        if isinstance(self.planner, LLMPlanner):
            self.planner.observer = observe
        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        try:
            if isinstance(self.planner, LLMPlanner):
                from .read_proxy import ReadCapabilityProxy
                scope = ReadCapabilityProxy(self.data_dir).session(state, lease)
            else:
                scope = nullcontext(None)
            with scope as proxy_profile:
                if isinstance(self.planner, LLMPlanner):
                    # Refuse legacy raw MCP before cognition; pending business writes
                    # have already been reconciled by the main loop.
                    if any(s['enabled'] for s in (self.planner.agent_profile or {}).get('mcp_servers', [])):
                        raise ModelError('legacy_mcp_effect_unclassified')
                    self.planner.transport.governed_profile = proxy_profile
                    self.planner.transport.should_cancel=getattr(self,'cancel_requested',None) if state['task'].get('execution_mode') in ('direct','conversation') else None
                from .context_builder import build, enrich_mock
                context,manifest = build(self.store,state,method,self.context(state))
                if manifest:
                    with self._state_lock:self.store.save_context(state,lease,manifest)
                if state['snapshot'].get('agent_profile',{}).get('skill_packages'):
                    from .skill_context import prepare
                    context=prepare(self.planner,context,state['snapshot']['agent_profile'],
                                    lambda kind,data:self.checkpoint(state,lease,kind,data),isinstance(self.planner,LLMPlanner))
                result = getattr(self.planner, method)(context)
                if not isinstance(self.planner,LLMPlanner):result = enrich_mock(result,context,method)
            if failures:
                raise failures[0]
            if time.time() >= state["deadline"]:
                raise ModelError("task_deadline")
            with self._state_lock:
                self.store.renew(state, lease, self.lease_seconds)
            return result
        finally:
            stopped.set()
            thread.join()
            if isinstance(self.planner, LLMPlanner):
                self.planner.observer = None
                self.planner.transport.governed_profile = None
                self.planner.transport.progress=None
                self.planner.transport.should_cancel=None

    def cognition_failed(self, state, lease, exc):
        from .contracts import LeaseLost
        if isinstance(exc, LeaseLost):
            raise exc
        from .knowledge import KnowledgeUnavailable
        if isinstance(exc,KnowledgeUnavailable):
            effects = any(self.is_write(state,a) and a['status'] in ('DISPATCHED','UNKNOWN','RECONCILING','OBSERVED') for a in self.store.actions(state))
            self.stop(state,lease,'NEEDS_REVIEW' if effects else 'WAITING_INPUT',str(exc))
            return
        has_effect = any(self.is_write(state, a) and a["status"] in ("DISPATCHED", "UNKNOWN", "RECONCILING", "OBSERVED") for a in self.store.actions(state))
        code = exc.code if isinstance(exc, ModelError) else type(exc).__name__
        if code=='task_cancelled':
            self.stop(state,lease,'CANCELLED','任务已取消。')
            return
        if isinstance(exc,ModelError) and time.time()>=state["deadline"]:code="task_deadline"
        status = "NEEDS_REVIEW" if has_effect or code == "legacy_mcp_effect_unclassified" else "EXPIRED" if code in ("model_call_budget", "model_token_budget", "task_deadline") else "FAILED"
        self.stop(state, lease, status, "认知调用失败：" + code)

    def stop(self, state, lease, status, reason, action=None):
        state["status"], state["last_error"] = status, reason
        self.checkpoint(state, lease, "run." + status.lower(), {"reason": reason}, action=action)

    def charge(self, state, lease, *, reconciling=False):
        budget = state["task"]["budget"]
        if time.time() >= state["deadline"] or state["steps"] + self.store.native_read_count(state) >= budget["max_steps"]:
            has_effect = any(self.is_write(state, a) and a["status"] in ("DISPATCHED", "UNKNOWN", "RECONCILING", "OBSERVED", "NEEDS_REVIEW") for a in self.store.actions(state))
            self.stop(state, lease, "NEEDS_REVIEW" if has_effect or reconciling else "EXPIRED", "执行预算或截止时间已耗尽")
            return False
        state["steps"] += 1
        self.checkpoint(state, lease, "budget.charged", {"steps": state["steps"]})
        return True

    def context(self, state):
        return context_bundle(state, self.store.evidence(state))

    def observe(self, state, lease, action, result, *, reconciled=False):
        if not domain_for(state["snapshot"]).validate_observation(action["tool_ref"], result, state["task"]):
            if self.is_write(state, action):
                action["status"] = "UNKNOWN"
                state["status"] = "RECONCILING"
                self.checkpoint(state, lease, "action.unknown", {"reason": "invalid write receipt"}, action=action)
            else:
                action["status"] = "FAILED"
                self.stop(state, lease, "NEEDS_REVIEW" if action["tool_ref"] == domain_for(state["snapshot"]).readback_ref else "FAILED", "工具输出未通过结构或范围校验", action)
            return
        ref = "evidence-" + digest([action["logical_id"], result])[:20]
        evidence = {"id": ref, "source": action["tool_ref"], "observed_at": time.time(), "data": result,
                    "content_hash": digest(result), "tenant_id": state["tenant_id"], "run_id": state["run_id"]}
        if self.is_write(state, action):
            state["draft"] = result
            # A prior authoritative 'not found' is not evidence for this new attempt.
            state["observations"].pop("draft_readback", None)
            action["status"] = "OBSERVED"
        else:
            key = resolve_capability(state["snapshot"], action["tool_ref"])["observation_key"]
            state["observations"][key] = evidence
            action["status"] = "VERIFIED"
        action["result"] = result
        state["status"] = "RUNNING"
        self.checkpoint(state, lease, "action.reconciled" if reconciled else "action.observed", {"logical_id": action["logical_id"], "evidence_ref": ref}, action=action, evidence=evidence)
        if action["tool_ref"] == domain_for(state["snapshot"]).readback_ref and not reconciled:
            self.verify_readback_now(state, lease)

    def invalid_readback(self, state):
        return bool(state.get("draft") and state["observations"].get("draft_readback")
                    and not all(check["passed"] for check in domain_for(state["snapshot"]).task_checks(state, self.store.evidence(state), store=self.store).values()))

    def verify_readback_now(self, state, lease):
        # A model may request input, repeat a read or avoid requesting finish. None may defer objective checks.
        if self.invalid_readback(state):
            self.finish(state, lease)

    def replan(self, state, lease, reason, *, refresh=False):
        if state["replans"] >= state["task"]["budget"]["max_replans"]:
            self.stop(state, lease, "FAILED", f"重规划预算已耗尽：{reason}")
            return False
        state["replans"] += 1
        state["report_revision"] += 1
        state["report"], state["checks"] = None, {}
        if refresh:
            for key in domain_runtime_settings(domain_for(state['snapshot']).ref)['refresh_keys']:
                state['observations'].pop(key,None)
        try:
            state["plan"] = self.cognize(state, lease, "plan")
        except Exception as exc:
            self.cognition_failed(state, lease, exc)
            return False
        self.checkpoint(state, lease, "plan.replanned", {"reason": reason, "revision": state["replans"], "plan": state["plan"]})
        return True

    def dispatch(self, state, lease, action):
        if action["attempts"] >= state["task"]["budget"]["max_retries"] + 1:
            action["status"] = "FAILED"
            self.stop(state, lease, "FAILED", "工具重试预算已耗尽", action)
            return
        try:
            action["authorization"] = self.gateway.authorize(state, action)
        except PolicyDenied as exc:
            from .knowledge import KnowledgeUnavailable
            self.stop(state, lease, 'WAITING_INPUT' if isinstance(exc,KnowledgeUnavailable) else "WAITING_AUTH", str(exc), action)
            return
        # Durable intent + pending outbox already exist. Recheck grant at dispatch time.
        action["status"], action["attempts"] = "DISPATCHED", action["attempts"] + 1
        self.checkpoint(state, lease, "action.dispatched", {"logical_id": action["logical_id"], "attempt": action["attempts"], "authorization": action["authorization"]}, action=action)
        self.store.renew(state, lease, self.lease_seconds)
        try:
            result = self.gateway.invoke(state, action)
        except PolicyDenied as exc:
            # invoke rechecks policy before the adapter; this denial proves no call occurred.
            action['status'] = 'PREPARED'
            action['attempts'] -= 1
            from .knowledge import KnowledgeUnavailable
            self.stop(state, lease, 'WAITING_INPUT' if isinstance(exc,KnowledgeUnavailable) else 'WAITING_AUTH', str(exc), action)
            return
        except ToolFailure as exc:
            action["last_error"] = {"category": exc.category, "message": str(exc)}
            write = self.is_write(state, action)
            if write and exc.category in ("unknown", "transient"):
                action["status"], state["status"] = "UNKNOWN", "RECONCILING"
                self.checkpoint(state, lease, "action.unknown", action["last_error"], action=action)
            elif write and exc.category == "precondition":
                action["status"] = "CONFIRMED_NOT_APPLIED"
                self.checkpoint(state, lease, "action.precondition_failed", action["last_error"], action=action)
                self.replan(state, lease, str(exc), refresh=True)
            elif not write and exc.category == "transient" and action["attempts"] <= state["task"]["budget"]["max_retries"]:
                action["status"] = "PREPARED"
                self.checkpoint(state, lease, "action.retry_scheduled", {**action["last_error"], "delay_seconds": min(0.05 * 2 ** (action["attempts"] - 1), 0.2)}, action=action)
                time.sleep(min(0.05 * 2 ** (action["attempts"] - 1), 0.2))
            else:
                action["status"] = "FAILED"
                self.stop(state, lease, "NEEDS_REVIEW" if action["tool_ref"] == domain_for(state["snapshot"]).readback_ref else "FAILED", str(exc), action)
            return
        if state["scenario"] == "crash-after-write" and self.is_write(state, action):
            # Intentionally leave DISPATCHED and its lease in the database.
            raise CrashInjected()
        self.observe(state, lease, action, result)

    def reconcile(self, state, lease, action):
        if action["reconcile_attempts"] >= state["task"]["budget"]["max_retries"] + 1:
            action["status"] = "NEEDS_REVIEW"
            self.stop(state, lease, "NEEDS_REVIEW", "无法确认外部写入结果，禁止再次创建；请按幂等键人工核对", action)
            return
        action["status"] = "RECONCILING"
        action["reconcile_attempts"] += 1
        state["status"] = "RECONCILING"
        self.checkpoint(state, lease, "action.reconciling", {"logical_id": action["logical_id"], "idempotency_key": action["args"]["idempotency_key"]}, action=action)
        try:
            read = self.gateway.prepare(state, self._read_proposal(state, action), self.store.evidence(state))
            read['logical_id'] = action['logical_id'] + f":reconcile:{action['reconcile_attempts']}"
            read['authorization'] = self.gateway.authorize(state, read)
        except PolicyDenied as exc:
            self.stop(state, lease, 'NEEDS_REVIEW', '核对能力被当前策略拒绝：' + str(exc), action)
            return
        read["status"], read["attempts"] = "DISPATCHED", 1
        self.checkpoint(state, lease, "reconcile.read_dispatched", {"logical_id": read["logical_id"]}, action=read)
        self.store.renew(state, lease, self.lease_seconds)
        try:
            result = self.gateway.invoke(state, read)
        except PolicyDenied as exc:
            read['status'] = 'REJECTED'
            self.checkpoint(state, lease, 'reconcile.read_rejected', {'reason': str(exc)}, action=read)
            self.stop(state, lease, 'NEEDS_REVIEW', '核对能力被当前策略拒绝', action)
            return
        except ToolFailure as exc:
            read["status"] = "FAILED"
            self.checkpoint(state, lease, "reconcile.read_failed", {"category": exc.category, "message": str(exc)}, action=read)
            return
        if not domain_for(state["snapshot"]).validate_observation(domain_for(state["snapshot"]).readback_ref, result, state["task"]):
            read["status"] = "FAILED"
            self.checkpoint(state, lease, "reconcile.invalid_readback", action=read)
            return
        self.observe(state, lease, read, result, reconciled=True)
        if result["found"]:
            draft = result["draft"]
            state["draft"] = {"id": draft.get("id"), "version": draft.get("version")}
            action["status"], action["result"] = "OBSERVED", state["draft"]
            self.checkpoint(state, lease, "action.effect_confirmed", {"logical_id": action["logical_id"], "draft_id": draft.get("id")}, action=action)
            self.verify_readback_now(state, lease)
        else:
            action["status"] = "CONFIRMED_NOT_APPLIED"
            self.checkpoint(state, lease, "action.not_applied", {"logical_id": action["logical_id"]}, action=action)
            action["status"] = "PREPARED"
            self.checkpoint(state, lease, "action.retry_after_reconcile", action=action)

    @staticmethod
    def _read_proposal(state, action):
        from .contracts import ActionProposal
        return ActionProposal(resolve_capability(state["snapshot"], action["tool_ref"])["reconcile_ref"], {"project_id": action["args"]["project_id"], "idempotency_key": action["args"]["idempotency_key"]}, [], ["draft-readback"], "核对未决外部副作用")

    def finish(self, state, lease):
        state["status"] = "VERIFYING"
        checks = domain_for(state["snapshot"]).task_checks(state, self.store.evidence(state), store=self.store)
        state["checks"] = checks
        actions = self.store.actions(state)
        unresolved = [a for a in actions if a["status"] in ("DISPATCHED", "UNKNOWN", "RECONCILING", "NEEDS_REVIEW")]
        passed = all(checks[k]["passed"] for k in state["task"]["acceptance"]) and not unresolved
        state["status"] = "SUCCEEDED" if passed else "NEEDS_REVIEW"
        state["last_error"] = None if passed else "独立验收未通过或存在未决副作用，保留已创建草稿供人工核对"
        experience = {"skill_ref": state["snapshot"]["skill"]["ref"], "outcome": state["status"],
                      "evidence_refs": list(self.store.evidence(state)), "replans": state["replans"],
                      "lesson": "写入状态不明确时先按幂等键核对；结论以独立回读为准。", "auto_publish": False}
        self.checkpoint(state, lease, "task.verified", {"checks": checks, "unresolved_actions": [a["logical_id"] for a in unresolved]}, checks=checks, experience=experience)
        if passed:
            for action in actions:
                if action["status"] == "OBSERVED":
                    action["status"] = "VERIFIED"
                    self.checkpoint(state, lease, "action.verified", {"logical_id": action["logical_id"]}, action=action)

    def execute_model_task(self,state,lease):
        """No model-authored plan/decide/review calls for ordinary tasks."""
        from .model_execution import MockExecution,SCHEMA
        from .structured import validate
        if not isinstance(self.planner,LLMPlanner) and self._domain_mock:self.planner=MockExecution()
        if state['status']=='CREATED' and not state['steps']:
            state['deadline']=time.time()+state['task']['budget']['max_wall_seconds']
        state['status']='RUNNING';state['last_error']=None
        self.checkpoint(state,lease,'execution.started',{'runtime':state['snapshot']['planner_ref']})
        if not self.charge(state,lease):return self.store.result(state['tenant_id'],state['run_id'])
        try:
            output=self.cognize(state,lease,'execute');validate(output,SCHEMA)
            if (output['kind']=='result')!=(output['result'] is not None):raise ModelError('inconsistent_execution_result')
        except Exception as exc:
            self.cognition_failed(state,lease,exc)
            return self.store.result(state['tenant_id'],state['run_id'])
        self.checkpoint(state,lease,'execution.summary',{'text':output['summary'],'source':'model' if isinstance(self.planner,LLMPlanner) else 'offline'})
        if output['kind']=='request_input':
            self.stop(state,lease,'WAITING_INPUT',output['summary'])
            return self.store.result(state['tenant_id'],state['run_id'])
        state['report']=output['result']
        checks=domain_for(state['snapshot']).task_checks(state,self.store.evidence(state),store=self.store)
        state['checks']=checks
        evidence={'id':'result-'+digest([state['run_id'],state['report']])[:20],'source':'model.result',
                  'observed_at':time.time(),'data':state['report'],'content_hash':digest(state['report']),
                  'tenant_id':state['tenant_id'],'run_id':state['run_id']}
        cancelled=callable(getattr(self,'cancel_requested',None)) and self.cancel_requested()
        state['status']='CANCELLED' if cancelled else 'SUCCEEDED' if all(c['passed'] for c in checks.values()) else 'NEEDS_REVIEW'
        state['last_error']='结果中的引用未通过来源核对，请查看运行记录。' if state['status']=='NEEDS_REVIEW' else None
        self.checkpoint(state,lease,'run.'+state['status'].lower(),{'summary':output['summary']},evidence=evidence,checks=checks)
        return self.store.result(state['tenant_id'],state['run_id'])

    def run(self, run_id, tenant="tenant-demo", pause_after=None):
        state = self.store.load(tenant, run_id)
        if state["status"] in TERMINAL or (state["status"] == "WAITING_INPUT" and not state["snapshot"].get("context_policy") and not self.invalid_readback(state)):
            return self.store.result(tenant, run_id)
        lease = self.store.acquire(tenant, run_id, self.lease_seconds)
        crashed, calls = False, 0
        try:
            state = self.store.load(tenant, run_id)
            snapshot = dict(state["snapshot"])
            expected = snapshot.pop("hash")
            if digest(snapshot) != expected:
                self.stop(state, lease, "FAILED", "版本快照摘要不一致")
                return self.store.result(tenant, run_id)
            try:
                domain_for(snapshot)
                if snapshot.get('compiled_agent'):
                    AgentCompiler.validate(snapshot['compiled_agent'])
            except (ValueError, PolicyDenied) as exc:
                self.stop(state, lease, 'NEEDS_REVIEW', str(exc))
                return self.store.result(tenant, run_id)
            descriptor = snapshot.get("planner")
            if descriptor:
                restored = LLMPlanner.restore(descriptor)
                if descriptor != restored.descriptor() or (self._explicit_planner and
                    (not isinstance(self.planner, LLMPlanner) or self.planner.descriptor() != descriptor)):
                    self.stop(state, lease, "FAILED", "模型、提示词或 schema 与冻结快照不一致")
                    return self.store.result(tenant, run_id)
                if not self._explicit_planner:
                    self.planner = restored
            elif isinstance(self.planner, LLMPlanner):
                self.stop(state, lease, "FAILED", "不能在已有模拟运行中替换规划器")
                return self.store.result(tenant, run_id)
            direct=bool(snapshot.get('compiled_agent',{}).get('execution_protocol'))
            if direct!=(state['task'].get('execution_mode') in ('direct','conversation')):
                self.stop(state,lease,'FAILED','执行协议与任务快照不一致')
                return self.store.result(tenant,run_id)
            if direct:return self.execute_model_task(state,lease)
            if not isinstance(self.planner,LLMPlanner) and self._domain_mock:
                requested_type=domain_runtime_settings(domain_for(snapshot).ref)['planner_type']
                registered_types={domain_runtime_settings(ref)['planner_type'] for ref in ('change-assessment@2.0.0','knowledge-answer@1.0.0','general-assistant@1.0.0')}
                if type(self.planner) in registered_types and type(self.planner) is not requested_type:
                    self.planner=requested_type()
            # Supplementing sources is an explicit resume. Keep fixed intents intact;
            # otherwise use a new read/compose revision under the existing bounded budget.
            if state['status']=='WAITING_INPUT' and state['snapshot'].get('context_policy') and state['plan']:
                saved_actions=self.store.actions(state)
                fixed=any(self.is_write(state,a) and a['status'] in ('PREPARED','DISPATCHED','UNKNOWN','RECONCILING','OBSERVED') for a in saved_actions)
                if not fixed:
                    for read in saved_actions:
                        if not self.is_write(state,read) and read['status']=='PREPARED':
                            read['status']='REJECTED'
                            self.checkpoint(state,lease,'read.invalidated_after_input',{'logical_id':read['logical_id']},action=read)
                    if not self.replan(state,lease,'补充资料后重新检索与评估',refresh=True):
                        return self.store.result(tenant,run_id)
            if state['task']['change_id']=='unresolved-change' and domain_for(snapshot).ref=='change-assessment@2.0.0':
                self.stop(state,lease,'WAITING_INPUT','此历史智能体需要具体变更编号。请在任务目标中补充 change-… 编号后重新创建，或将智能体切换为通用执行配置。')
                return self.store.result(tenant,run_id)
            state["status"] = "RUNNING"
            self.checkpoint(state, lease, "run.resumed")
            for action in self.store.actions(state):
                if not self.is_write(state, action) and action["status"] == "DISPATCHED":
                    action["status"] = "FAILED" if ":reconcile:" in action["logical_id"] else "PREPARED"
                    self.checkpoint(state, lease, "read.recovered_after_restart", {"logical_id": action["logical_id"]}, action=action)
            if self.invalid_readback(state):
                self.finish(state, lease)
                return self.store.result(tenant, run_id)
            if not state["plan"]:
                try:
                    state["plan"] = self.cognize(state, lease, "plan")
                except Exception as exc:
                    self.cognition_failed(state, lease, exc)
                    return self.store.result(tenant, run_id)
                self.checkpoint(state, lease, "plan.created", {"plan": state["plan"]})
            while state["status"] not in TERMINAL | {"WAITING_AUTH", "WAITING_INPUT"}:
                self.store.renew(state, lease, self.lease_seconds)
                if not self.charge(state, lease):
                    break
                actions = self.store.actions(state)
                pending = next((a for a in actions if self.is_write(state, a) and a["status"] in ("DISPATCHED", "UNKNOWN", "RECONCILING")), None)
                if pending:
                    self.reconcile(state, lease, pending)
                    calls += 1
                elif prepared := next((a for a in actions if a["status"] == "PREPARED"), None):
                    # A durable proposal is already fixed. Do not ask a stochastic planner to rewrite it.
                    self.dispatch(state, lease, prepared)
                    calls += 1
                else:
                    try:
                        decision = self.cognize(state, lease, "decide")
                    except Exception as exc:
                        self.cognition_failed(state, lease, exc)
                        break
                    if not isinstance(decision, Decision) or decision.kind not in {"propose_action", "compose_report", "request_finish", "request_input"}:
                        self.stop(state, lease, "FAILED", "规划器返回非法决策")
                        break
                    self.checkpoint(state, lease, "decision.proposed", asdict(decision))
                    if decision.kind == "request_finish":
                        self.finish(state, lease)
                    elif decision.kind == "request_input":
                        self.stop(state, lease, "WAITING_INPUT", decision.summary)
                    elif decision.kind == "compose_report":
                        try:
                            state["report"] = json.loads(canonical(self.cognize(state, lease, "compose")))
                        except Exception as exc:
                            self.cognition_failed(state, lease, exc)
                            break
                        if state["scenario"] == "invalid-report" and state["replans"] == 0 and isinstance(state["report"], dict):
                            state["report"]["sections"].pop("rollback")
                        checks = domain_for(state["snapshot"]).local_checks(state, self.store.evidence(state))
                        state["checks"] = checks
                        self.checkpoint(state, lease, "report.validated", {"checks": checks}, checks=checks)
                        if not all(c["passed"] for c in checks.values()):
                            self.replan(state, lease, "报告本地验收失败")
                    else:
                        try:
                            prepared = self.gateway.prepare(state, decision.action, self.store.evidence(state))
                        except (ValueError, TypeError, KeyError, PolicyDenied) as exc:
                            self.stop(state, lease, "FAILED", f"动作提案被拒绝：{exc}")
                            break
                        existing = next((a for a in actions if a["logical_id"] == prepared["logical_id"]), None)
                        action = existing or prepared
                        if existing and existing["args_hash"] != prepared["args_hash"]:
                            self.stop(state, lease, "FAILED", "同一逻辑动作参数发生变化")
                            break
                        if not existing:
                            self.checkpoint(state, lease, "action.prepared", {"logical_id": action["logical_id"], "args_hash": action["args_hash"]}, action=action)
                        elif existing["status"] in {"VERIFIED", "OBSERVED", "FAILED", "REJECTED"}:
                            self.stop(state, lease, "FAILED", "检测到重复决策且无进展，终止自动执行")
                            break
                        self.dispatch(state, lease, action)
                        calls += 1
                if pause_after and calls >= pause_after and state["status"] == "RUNNING":
                    self.checkpoint(state, lease, "run.paused_for_demo", {"calls": calls})
                    break
            return self.store.result(tenant, run_id)
        except CrashInjected:
            crashed = True
            raise
        finally:
            if not crashed:
                self.store.release(state, lease)

    def cancel(self, run_id, tenant="tenant-demo"):
        state = self.store.load(tenant, run_id)
        if state["status"] in TERMINAL:
            return state
        lease = self.store.acquire(tenant, run_id, self.lease_seconds)
        try:
            pending = [a for a in self.store.actions(state) if self.is_write(state, a) and a["status"] in ("DISPATCHED", "UNKNOWN", "RECONCILING")]
            for action in pending:
                while action["status"] in ("DISPATCHED", "UNKNOWN", "RECONCILING"):
                    self.store.renew(state, lease, self.lease_seconds)
                    if not self.charge(state, lease, reconciling=True):
                        return state
                    self.reconcile(state, lease, action)
            if state["status"] != "NEEDS_REVIEW":
                self.stop(state, lease, "CANCELLED", "已停止后续调度；已创建草稿予以保留，未执行补偿")
            return state
        finally:
            self.store.release(state, lease)
