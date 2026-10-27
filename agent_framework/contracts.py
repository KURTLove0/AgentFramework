from dataclasses import asdict, dataclass, field
import hashlib
import json
import re
from typing import Any, Literal, Protocol


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def identifier(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value):
        raise ValueError(f"invalid identifier: {value!r}")
    return value


TOOLS = ("change.read@1.0.0", "standards.read@1.0.0", "report.draft.create@1.0.0", "report.read@1.0.0")
CHECKS = ("report-sections", "critical-claims-evidence", "draft-readback")
TERMINAL = {"SUCCEEDED", "FAILED", "NEEDS_REVIEW", "EXPIRED", "CANCELLED"}


@dataclass(frozen=True)
class Budget:
    max_steps: int = 24
    max_replans: int = 2
    max_retries: int = 2
    max_wall_seconds: float = 120
    max_model_calls: int = 24
    max_model_tokens: int = 200000

    def __post_init__(self):
        for name in ("max_steps", "max_replans", "max_retries", "max_model_calls", "max_model_tokens"):
            v = getattr(self, name)
            if type(v) is not int or v < (1 if name in ("max_steps", "max_model_calls", "max_model_tokens") else 0):
                raise ValueError(f"invalid {name}")
        if type(self.max_wall_seconds) not in (int, float) or not 0 < self.max_wall_seconds <= 3600:
            raise ValueError("max_wall_seconds must be in (0, 3600]")


@dataclass(frozen=True)
class TaskContract:
    change_id: str = "change-demo-001"
    tenant_id: str = "tenant-demo"
    principal: str = "kurt"
    project_id: str = "project-demo"
    environment: str = "test"
    goal: str = "评估指定变更并创建一份评估草稿"
    domain_pack_ref: str = "change-assessment@2.0.0"
    agent_ref: str = "release-assistant@1.0.0"
    acceptance: tuple[str, ...] = CHECKS
    budget: Budget = field(default_factory=Budget)
    workflow_inputs: tuple = ()
    retrieval: dict | None = None
    source_run_id: str | None = None
    execution_mode: str | None = None
    conversation_context: dict | None = None

    def __post_init__(self):
        if self.retrieval is not None:
            from .workflow_rules import retrieval_config
            object.__setattr__(self,'retrieval',retrieval_config(self.retrieval))
        if self.source_run_id is not None:
            identifier(self.source_run_id)
        for name in ("change_id", "tenant_id", "principal", "project_id", "environment"):
            identifier(getattr(self, name))
        if not isinstance(self.workflow_inputs,(tuple,list)) or len(self.workflow_inputs)>11 or len(canonical(self.workflow_inputs).encode())>48000:
            raise ValueError('workflow inputs exceed scope/budget')
        for item in self.workflow_inputs:
            if not isinstance(item,dict) or set(item)!={'node_id','run_id','content_hash','artifact'} or not isinstance(item['artifact'],dict) or digest(item['artifact'])!=item['content_hash']:
                raise ValueError('invalid frozen workflow input')
            identifier(item['node_id']);identifier(item['run_id'])
        expected = CHECKS
        if self.domain_pack_ref == 'knowledge-answer@1.0.0':
            expected = ('answer-grounded','answer-scope','answer-current')
            if tuple(self.acceptance) == CHECKS:object.__setattr__(self,'acceptance',expected)
            if self.agent_ref == 'release-assistant@1.0.0':object.__setattr__(self,'agent_ref','knowledge-assistant@1.0.0')
        elif self.domain_pack_ref=='general-assistant@1.0.0':
            expected=('result-complete','result-evidence')
            if tuple(self.acceptance)==CHECKS:object.__setattr__(self,'acceptance',expected)
            if self.agent_ref=='release-assistant@1.0.0':object.__setattr__(self,'agent_ref','general-assistant@1.0.0')
        elif self.domain_pack_ref != 'change-assessment@2.0.0':
            raise ValueError('unsupported task domain')
        if self.execution_mode not in (None,'direct','conversation'):
            raise ValueError('unsupported execution mode')
        if self.execution_mode in ('direct','conversation'):
            if tuple(self.acceptance) in (CHECKS,expected):
                object.__setattr__(self,'acceptance',('result-complete','result-evidence'))
            expected=('result-complete','result-evidence')
        if self.conversation_context is not None:
            context=self.conversation_context
            if self.execution_mode!='conversation' or not isinstance(context,dict) or set(context)!={'task_id','turn','goal','messages','history_hash','omitted_messages'}:
                raise ValueError('invalid conversation context')
            identifier(context['task_id'])
            if type(context['turn']) is not int or context['turn']<1 or not isinstance(context['goal'],str) or not 1<=len(context['goal'])<=2000:
                raise ValueError('invalid conversation turn')
            if (not isinstance(context['messages'],list) or len(context['messages'])>200 or len(canonical(context).encode())>128000
                or type(context['omitted_messages']) is not int or context['omitted_messages']<0 or not isinstance(context['history_hash'],str)):
                raise ValueError('conversation history exceeds context budget')
            for message in context['messages']:
                if (not isinstance(message,dict) or set(message)!={'role','content','turn','run_id','status','citations'}
                    or message['role'] not in ('user','assistant') or not isinstance(message['content'],str)
                    or type(message['turn']) is not int or not 1<=message['turn']<context['turn']):
                    raise ValueError('invalid conversation history message')
                identifier(message['run_id'])
            object.__setattr__(self,'conversation_context',json.loads(canonical(context)))
        elif self.execution_mode=='conversation':raise ValueError('conversation context required')
        builtin = 'general-assistant@1.0.0' if self.domain_pack_ref=='general-assistant@1.0.0' else 'knowledge-assistant@1.0.0' if self.domain_pack_ref == 'knowledge-answer@1.0.0' else 'release-assistant@1.0.0'
        if (self.agent_ref != builtin and not re.fullmatch(r'agent-[a-f0-9]{16}@[1-9][0-9]*', self.agent_ref)) or tuple(self.acceptance) != expected:
            raise ValueError('unsupported Agent or acceptance contract')
        if self.environment != "test":
            raise ValueError("MVP permits only the test environment")

    def to_dict(self):
        result=asdict(self)
        if not self.workflow_inputs:result.pop('workflow_inputs',None)
        if self.retrieval is None:result.pop('retrieval',None)
        if self.source_run_id is None:result.pop('source_run_id',None)
        if self.execution_mode is None:result.pop('execution_mode',None)
        if self.conversation_context is None:result.pop('conversation_context',None)
        return result

    @classmethod
    def from_dict(cls, data):
        data = dict(data)
        data["budget"] = Budget(**data.get("budget", {}))
        data["acceptance"] = tuple(data.get("acceptance", CHECKS))
        return cls(**data)


@dataclass(frozen=True)
class AgentSpec:
    ref: str
    identity: dict
    responsibilities: list[str]
    standards: list[str]
    capabilities: list[str]
    skill_ref: str
    policy_ref: str

    def __post_init__(self):
        if (self.ref != "release-assistant@1.0.0" and not re.fullmatch(r'agent-[a-f0-9]{16}@[1-9][0-9]*', self.ref)) or set(self.capabilities) != set(TOOLS):
            raise ValueError("invalid Agent registry snapshot")


@dataclass(frozen=True)
class ActionProposal:
    tool_ref: str
    args: dict
    evidence_refs: list[str]
    expected_checks: list[str]
    decision_summary: str


@dataclass(frozen=True)
class Decision:
    kind: Literal["propose_action", "compose_report", "request_finish", "request_input"]
    summary: str
    action: ActionProposal | None = None


class Planner(Protocol):
    def plan(self, context: dict) -> list[dict]: ...
    def decide(self, context: dict) -> Decision: ...
    def compose(self, context: dict) -> dict: ...


class LeaseBusy(RuntimeError):
    pass


class LeaseLost(RuntimeError):
    pass


class PolicyDenied(RuntimeError):
    pass


class ToolFailure(RuntimeError):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category
