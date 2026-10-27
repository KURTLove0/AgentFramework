"""Published P0 registries and deterministic Agent compilation.

Registries are trusted code, not user/model supplied executables. Legacy snapshots
are interpreted through a versioned bridge; they are never rewritten.
"""
from copy import deepcopy
from importlib.resources import files
import json

from .contracts import CHECKS, TOOLS, PolicyDenied, digest
from .structured import ARGUMENTS, REPORT, SCHEMAS, validate

DOMAIN_REF = 'change-assessment@2.0.0'
POLICY_REF = 'release-reviewer-policy@1.0.0'
SKILL_REF = 'release-risk-analysis@1.0.0'
STANDARDS = {'report-evidence@1.0.0': list(CHECKS[:2]),
             'release-review-rubric@1.0.0': list(CHECKS),
             'knowledge-source-evidence@1.0.0': ['answer-grounded','answer-scope','answer-current'],
             'goal-driven-delivery@1.0.0':['result-complete','result-evidence']}
ADAPTERS = ('mock-worker@1.0.0', 'mock-cli@1.0.0', 'mock-mcp@1.0.0')
KNOWLEDGE = 'simulated-change-context@1.0.0'
NATIVE_NAMES = {TOOLS[0]: 'change_read', TOOLS[1]: 'standards_read', TOOLS[3]: 'report_read',
                'knowledge.search@1.0.0':'knowledge_search','knowledge.read@1.0.0':'knowledge_read'}


def capability_definitions():
    definitions = {}
    for i, ref in enumerate(TOOLS):
        write = i == 2
        definitions[ref] = {
            'ref': ref, 'version': '1.0.0',
            'phase': 'EXECUTE' if write else 'VERIFY' if i == 3 else 'PERCEIVE',
            'effect': 'WRITE' if write else 'READ',
            'input_schema_ref': ref + ':input', 'input_schema': deepcopy(ARGUMENTS[ref]),
            'output_schema_ref': ref + ':output',
            'output_validator_ref': 'release-observation@1.0.0',
            'resource_resolver_ref': 'task-project-change@1.0.0',
            'adapter_ref': ADAPTERS[0], 'allowed_adapter_refs': list(ADAPTERS),
            'timeout': 2, 'credential_scope_ref': 'simulated-business-only@1.0.0',
            'idempotency': 'runtime-report-key@1.0.0' if write else 'none',
            'precondition': 'source-version@1.0.0' if write else 'task-scope@1.0.0',
            'reconcile_ref': TOOLS[3] if write else None,
            'verifier_refs': list(CHECKS) if write else ['schema-and-scope'],
            'approval_policy_ref': POLICY_REF, 'compensation_policy_ref': 'retain-draft@1.0.0',
            'observation_key': ('change', 'standards', None, 'draft_readback')[i],
        }
    from .domains.knowledge_answer import capability_definitions as knowledge_capabilities
    definitions.update(knowledge_capabilities())
    return definitions


class ChangeDomain:
    ref = DOMAIN_REF
    capabilities = tuple(TOOLS)
    checks = tuple(CHECKS)
    write_ref, readback_ref = TOOLS[2], TOOLS[3]
    skill_ref = SKILL_REF
    policy_ref = POLICY_REF
    deliverable_refs = ('release-report@1.0.0','release-draft@1.0.0')

    def descriptor(self):
        root = files('agent_framework').joinpath('resources')
        return {'ref': self.ref, 'task_schema_ref': 'change-task@1.0.0',
                'artifact_schema_ref': 'release-report@1.0.0', 'artifact_schema': deepcopy(REPORT),
                'capability_refs': list(self.capabilities), 'check_refs': list(self.checks),
                'skill': {'ref': SKILL_REF, 'instructions': root.joinpath('change-assessment.md').read_text(),
                          'manifest': json.loads(root.joinpath('capability.json').read_text())},
                'context_provider_ref': 'change-context@1.0.0',
                'verifier_ref': 'release-verifier@1.0.0', 'cognition_schema_hash': digest(SCHEMAS),
                'implementation_hashes': {name: digest(files('agent_framework').joinpath(name).read_text())
                                          for name in ('domains/change_assessment.py', 'domains/change_verifier.py',
                                                       'adapters.py', 'worker.py')}}

    @staticmethod
    def local_checks(state, evidence):
        from .domains.change_verifier import local_checks
        return local_checks(state, evidence)

    @staticmethod
    def task_checks(state, evidence, store=None):
        from .domains.change_verifier import task_checks
        return task_checks(state, evidence)

    @staticmethod
    def validate_observation(ref, result, task):
        from .domains.change_verifier import validate_observation
        return validate_observation(ref, result, task)

    def prepare_args(self, state, ref, args, evidence):
        from .planner import write_key
        task = state['task']
        if 'compiled_agent' in state['snapshot']:
            validate(args, ARGUMENTS[ref])
        elif set(args) != set(ARGUMENTS[ref]['required']):
            raise ValueError('argument schema mismatch')
        if args['project_id'] != task['project_id']:
            raise PolicyDenied('project outside task scope')
        if 'change_id' in args and args['change_id'] != task['change_id']:
            raise PolicyDenied('change outside task scope')
        if ref == self.write_ref:
            if args['report'] != state['report'] or not all(c['passed'] for c in self.local_checks(state, evidence).values()):
                raise PolicyDenied('write requires an independently validated report')
            if type(args['source_version']) is not int or args['source_version'] != state['observations']['change']['data']['version']:
                raise ValueError('invalid source precondition')
            args['idempotency_key'] = write_key(state)
        if ref == self.readback_ref and args['idempotency_key'] != write_key(state):
            raise PolicyDenied('draft read outside task scope')
        return args


DOMAIN = ChangeDomain()


def get_domain(ref):
    if ref == DOMAIN_REF:return DOMAIN
    if ref == 'general-assistant@1.0.0':
        from .domains.general_assistant import DOMAIN as general_domain
        return general_domain
    from .domains.knowledge_answer import DOMAIN as knowledge_domain
    if ref == knowledge_domain.ref:return knowledge_domain
    raise ValueError('unpublished DomainPack reference')


def domain_for(snapshot):
    compiled = snapshot.get('compiled_agent')
    domain = get_domain(compiled['domain_pack']['ref']) if compiled else DOMAIN
    if compiled and compiled.get('domain_pack') != domain.descriptor():
        raise ValueError('frozen DomainPack is unavailable or has drifted')
    if compiled and compiled.get('execution_protocol'):
        if compiled['execution_protocol'].get('ref')=='task-conversation@1.0.0':
            from .conversation_execution import descriptor,ModelExecutionDomain
        else:
            from .model_execution import descriptor,ModelExecutionDomain
        if compiled['execution_protocol']!=descriptor():
            raise ValueError('frozen model execution protocol has drifted')
        return ModelExecutionDomain(domain)
    return domain


def default_definition(name='变更评估助手', domain_ref=DOMAIN_REF):
    if domain_ref=='general-assistant@1.0.0':
        domain=get_domain(domain_ref)
        return {'identity':{'name':name,'role':'general_assistant'},
                'responsibilities':[{'description':'按任务目标与自定义执行指令交付结果','deliverable_ref':'task-deliverable@1.0.0','check_refs':list(domain.checks)}],
                'domain_pack_ref':domain.ref,'standard_refs':['goal-driven-delivery@1.0.0'],
                'knowledge_spaces':[KNOWLEDGE],'skill_refs':[domain.skill_ref],'capability_refs':list(domain.capabilities),
                'policy_ref':domain.policy_ref,'runtime_profile_ref':'profile-runtime@1','prompt_template_ref':'profile-prompt@1',
                'adapter_bindings':{},'native_read_refs':[]}
    if domain_ref != DOMAIN_REF:
        domain=get_domain(domain_ref)
        return {'identity':{'name':name,'role':'knowledge_assistant'},
                'responsibilities':[{'description':'依据有来源的知识回答问题','deliverable_ref':'knowledge-answer@1.0.0','check_refs':list(domain.checks)}],
                'domain_pack_ref':domain.ref,'standard_refs':['knowledge-source-evidence@1.0.0'],
                'knowledge_spaces':[KNOWLEDGE],'skill_refs':[domain.skill_ref],'capability_refs':list(domain.capabilities),
                'policy_ref':domain.policy_ref,'runtime_profile_ref':'profile-runtime@1','prompt_template_ref':'profile-prompt@1',
                'adapter_bindings':{},'native_read_refs':[]}

    return {'identity': {'name': name, 'role': 'release_reviewer'},
            'responsibilities': [
                {'description': '评估变更风险', 'deliverable_ref': 'release-report@1.0.0', 'check_refs': list(CHECKS[:2])},
                {'description': '创建并回读草稿', 'deliverable_ref': 'release-draft@1.0.0', 'check_refs': [CHECKS[2]]}],
            'domain_pack_ref': DOMAIN_REF, 'standard_refs': ['report-evidence@1.0.0','release-review-rubric@1.0.0'],
            'knowledge_spaces': [KNOWLEDGE], 'skill_refs': [SKILL_REF],
            'capability_refs': list(TOOLS), 'policy_ref': POLICY_REF,
            'runtime_profile_ref': 'profile-runtime@1', 'prompt_template_ref': 'profile-prompt@1',
            'adapter_bindings': {}, 'native_read_refs': []}


def normalize_definition(value, name):
    from .agents import text, string_list
    if value is None:
        return default_definition(name)
    default = default_definition(name)
    if not isinstance(value, dict) or set(value) != set(default):
        raise ValueError('岗位定义字段不完整或包含未知字段')
    result = deepcopy(value)
    identity = result['identity']
    if (not isinstance(identity, dict) or not {'name', 'role'} <= set(identity)
            or set(identity) - {'name', 'role', 'owner_team'}):
        raise ValueError('岗位身份需要 name、role，且不能包含未知字段')
    for key in identity:
        # Keep existing team metadata without requiring it for new Agents.
        identity[key] = text(identity[key], '岗位身份', 100, empty=key == 'owner_team')
    if identity['name'] != name:
        raise ValueError('岗位身份名称必须与 Agent 名称一致')
    responsibilities = result['responsibilities']
    if not isinstance(responsibilities, list) or not 1 <= len(responsibilities) <= 16:
        raise ValueError('岗位需要 1–16 项职责')
    for item in responsibilities:
        if not isinstance(item, dict) or set(item) != {'description', 'deliverable_ref', 'check_refs'}:
            raise ValueError('职责需要说明、交付物和验收映射')
        item['description'] = text(item['description'], '职责', 1000)
        item['deliverable_ref'] = text(item['deliverable_ref'], '交付物引用', 120)
        item['check_refs'] = string_list(item['check_refs'], '验收引用')
    for key in ('standard_refs', 'knowledge_spaces', 'skill_refs', 'capability_refs', 'native_read_refs'):
        result[key] = string_list(result[key], key)
        if len(result[key]) != len(set(result[key])):
            raise ValueError(key + ' 包含重复引用')
    for key in ('domain_pack_ref', 'policy_ref', 'runtime_profile_ref', 'prompt_template_ref'):
        result[key] = text(result[key], key, 120)
    try:
        get_domain(result['domain_pack_ref'])
    except ValueError as error:
        raise ValueError('请为智能体选择可用的执行模板') from error
    if not isinstance(result['adapter_bindings'], dict):
        raise ValueError('adapter_bindings 必须是引用映射')
    return result


class AgentCompiler:
    def compile(self, profile=None, domain_ref=DOMAIN_REF, *, execution_mode=None):
        if execution_mode not in (None,'direct','conversation'):raise ValueError('unsupported execution mode')
        from .agents import agent_ref
        profile = deepcopy(profile)
        definition = normalize_definition(profile.get('definition'), profile['name']) if profile else default_definition('知识问答助手' if domain_ref != DOMAIN_REF else '变更评估助手',domain_ref)
        domain=get_domain(definition['domain_pack_ref'])
        if definition['policy_ref'] != domain.policy_ref:
            raise ValueError('unpublished domain or policy reference')
        if definition['runtime_profile_ref'] != 'profile-runtime@1' or definition['prompt_template_ref'] != 'profile-prompt@1':
            raise ValueError('unpublished runtime or prompt template reference')
        if not set(definition['standard_refs']) <= STANDARDS.keys() or not definition['standard_refs']:
            raise ValueError('unpublished standard reference')
        available_checks = {c for s in definition['standard_refs'] for c in STANDARDS[s]}
        if not set(domain.checks) <= available_checks:
            raise ValueError('standards do not cover required acceptance')
        if set(definition['knowledge_spaces']) - {KNOWLEDGE}:
            raise ValueError('unpublished knowledge space reference')
        if definition['skill_refs'] != [domain.skill_ref]:
            raise ValueError('unpublished Skill or missing domain method')
        caps = capability_definitions()
        declared = definition['capability_refs']
        if set(declared) - caps.keys():
            raise ValueError('unregistered capability (UNKNOWN effects are denied)')
        # Resolve the exact capability closure of the selected published method.
        if set(declared) != set(domain.capabilities):
            raise ValueError('Skill capability dependency missing')
        covered = set()
        for item in definition['responsibilities']:
            if item['deliverable_ref'] not in domain.deliverable_refs or not item['check_refs'] or set(item['check_refs']) - available_checks:
                raise ValueError('unregistered deliverable or verifier in responsibility')
            covered.update(item['check_refs'])
        if not set(domain.checks) <= covered:
            raise ValueError('responsibilities do not cover task acceptance')
        bindings = definition['adapter_bindings']
        if set(bindings) - set(declared):
            raise ValueError('adapter bound outside declared capabilities')
        compiled_caps = {}
        for ref in declared:
            cap = deepcopy(caps[ref])
            adapter = bindings.get(ref, cap['adapter_ref'])
            if adapter not in cap['allowed_adapter_refs']:
                raise ValueError('unregistered adapter binding')
            cap['adapter_ref'] = adapter
            if cap['effect'] not in ('READ', 'WRITE'):
                raise ValueError('UNKNOWN effect cannot be compiled')
            if ((cap['effect'] == 'WRITE' and cap['phase'] != 'EXECUTE')
                    or (cap['effect'] == 'READ' and cap['phase'] not in ('PERCEIVE', 'VERIFY'))):
                raise ValueError('effect/phase binding mismatch')
            if cap['effect'] == 'WRITE' and (cap['reconcile_ref'] not in declared
                    or caps[cap['reconcile_ref']]['effect'] != 'READ'
                    or caps[cap['reconcile_ref']]['phase'] != 'VERIFY'):
                raise ValueError('write requires a declared read-only verifier capability')
            if cap['effect'] != 'READ' and (not cap['reconcile_ref'] or cap['idempotency'] == 'none'):
                raise ValueError('write capability requires idempotency and reconciliation')
            compiled_caps[ref] = cap
        for ref in definition['native_read_refs']:
            if ref not in declared or compiled_caps[ref]['effect'] != 'READ' or ref not in NATIVE_NAMES:
                raise ValueError('native MCP exposes registered READ capabilities only')
        # Old free-form endpoint settings can still be edited/exported; cannot start new tasks.
        if profile and any(s['enabled'] for s in profile.get('mcp_servers', [])):
            raise ValueError('未登记 MCP 效果：请关闭原生直连，改用 definition.native_read_refs 受控读取')
        runtime_binding = {'ref': 'mock-planner@1.0.0'}
        if profile and profile['runtime'] != 'mock':
            from .llm import CONFIG_TYPES, LLMPlanner
            config_type = CONFIG_TYPES.get(profile['runtime'])
            if not config_type:
                raise ValueError('unregistered cognitive runtime')
            runtime_binding = LLMPlanner(config_type(model=profile['model'], **profile['options']), agent_profile=profile,execution_mode=execution_mode).descriptor()
        domain_descriptor = domain.descriptor()
        processing_domain = (profile or {}).get('processing_domain')
        if processing_domain:
            from .agent_domains import normalize_domain
            processing_domain = normalize_domain(processing_domain, frozen=True)
        builtin_ref='general-assistant@1.0.0' if domain.ref=='general-assistant@1.0.0' else 'release-assistant@1.0.0' if domain.ref==DOMAIN_REF else 'knowledge-assistant@1.0.0'
        result = {'schema_version': 2, 'ref': agent_ref(profile) if profile else builtin_ref,
                  'definition': definition, 'domain_pack': domain_descriptor, 'capabilities': compiled_caps,
                  'standards': {ref: {'ref': ref, 'verifier_refs': list(STANDARDS[ref])} for ref in definition['standard_refs']},
                  'skills': [domain_descriptor['skill']] + [{'ref': 'inline-skill:' + digest(s), 'kind': 'instructions-only', **s}
                                                for s in (profile or {}).get('skills', []) if s['enabled']],
                  'runtime': runtime_binding,
                  'prompt': (profile or {}).get('prompt', ''), 'cognition_schema_hash': domain_descriptor['cognition_schema_hash']}
        from .evaluation_contract import compile_contract
        if processing_domain:
            result['processing_domain'] = processing_domain
        result['evaluation_contract'] = compile_contract(definition, (profile or {}).get('evaluation_config'), result['standards'], processing_domain=processing_domain)
        if (profile or {}).get('skill_packages'):
            from .skills import validate_frozen
            for item in profile['skill_packages']:
                validate_frozen(item['package'])
                if item['ref']!=item['skill_id']+'@'+str(item['version']):raise ValueError('Skill version binding mismatch')
                if item['enabled']:result['skills'].append({'kind':'agent-skill-package',**deepcopy(item)})
        if execution_mode in ('direct','conversation'):
            if execution_mode=='conversation':
                from .conversation_execution import descriptor,evaluation_contract
            else:
                from .model_execution import descriptor,evaluation_contract
            result['execution_protocol']=descriptor()
            result['evaluation_contract']=evaluation_contract(result)
            result['cognition_schema_hash']=result['execution_protocol']['schema_hash']
        return {**result, 'hash': digest(result)}

    @staticmethod
    def validate(compiled):
        body = {k: v for k, v in compiled.items() if k != 'hash'}
        if digest(body) != compiled.get('hash'):
            raise ValueError('CompiledAgent hash mismatch')
        domain_for({'compiled_agent': compiled})
        for item in compiled.get('skills',[]):
            if item.get('kind')=='agent-skill-package':
                from .skills import validate_frozen
                validate_frozen(item['package'])
        for ref, cap in compiled['capabilities'].items():
            resolve_capability({'compiled_agent': compiled}, ref)


def resolve_capability(snapshot, ref):
    registry = capability_definitions()
    if ref not in registry:
        raise PolicyDenied('unregistered capability: UNKNOWN effect')
    current = registry[ref]
    if 'compiled_agent' in snapshot:
        frozen = snapshot['compiled_agent']['capabilities'].get(ref)
        if not frozen:
            raise PolicyDenied('capability outside compiled Agent')
        current['adapter_ref'] = frozen.get('adapter_ref')
        if current['adapter_ref'] not in current['allowed_adapter_refs'] or frozen != current:
            raise PolicyDenied('capability schema/adapter drift; recompile required')
    if current['effect'] not in ('READ', 'WRITE'):
        raise PolicyDenied('UNKNOWN effect is not executable')
    return current


def domain_runtime_settings(ref):
    """Trusted domain registrations; the execution loop does not name business fields."""
    if ref == DOMAIN_REF:
        from .domains.change_assessment import MockPlanner
        from .mock_tools import SCENARIOS
        return {'planner_type':MockPlanner,'refresh_keys':('change','standards'),'scenarios':SCENARIOS,'cognitive_domain_ref':None}
    if ref == 'knowledge-answer@1.0.0':
        from .domains.knowledge_answer import KnowledgePlanner
        return {'planner_type':KnowledgePlanner,'refresh_keys':('knowledge_hits','knowledge_documents'),
                'scenarios':('normal',),'cognitive_domain_ref':ref}
    if ref=='general-assistant@1.0.0':
        from .domains.general_assistant import GeneralPlanner
        return {'planner_type':GeneralPlanner,'refresh_keys':('knowledge_hits','knowledge_documents'),
                'scenarios':('normal',),'cognitive_domain_ref':ref}
    raise ValueError('unregistered domain runtime settings')
