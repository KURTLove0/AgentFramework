"""Replaceable cognition port. This implementation is deterministic, not an LLM."""

from .contracts import ActionProposal, Decision


def write_key(state):
    return f"{state['run_id']}:report:{state['report_revision']}"


# Historical import stays valid for clients and frozen test fixtures.
from .domains.change_assessment import MockPlanner


def context_bundle(state, evidence):
    # Observations are explicitly data, not higher-priority executable instructions.
    bundle = {"agent": state["snapshot"]["agent"], "skill": state["snapshot"]["skill"],
            "constraints": {"environment": "test", "write": "draft-only", "tools": state["snapshot"]["agent"]["capabilities"]},
            "state": state, "evidence": evidence,
            "unmet_acceptance": [k for k in state["task"]["acceptance"] if not state["checks"].get(k, {}).get("passed")]}
    if state['snapshot'].get('compiled_agent'):
        compiled = state['snapshot']['compiled_agent']
        bundle['constraints']['domain_pack_ref'] = compiled['domain_pack']['ref']
        bundle['constraints']['verifier_refs'] = list(state['task']['acceptance'])+['schema-and-scope']
        if all(cap['effect']=='READ' for cap in compiled['capabilities'].values()):
            bundle['constraints']['write']='forbidden'
            bundle['constraints']['completion_gate']='Grounded artifact plus a request_finish triggers the independent current-source check. An unmet check can mean not yet executed, not a failed check.'
        bundle['constraints']['capability_effects'] = {ref: {key: cap[key] for key in ('effect', 'phase', 'reconcile_ref')}
                                                      for ref, cap in compiled['capabilities'].items()}
    return bundle
