from dataclasses import asdict
from pathlib import Path
import time

from .contracts import ActionProposal, PolicyDenied, digest
from .definitions import domain_for, resolve_capability
from .adapters import invoke as invoke_adapter


class Gateway:
    def __init__(self, store, external_db, timeout=2):
        self.store, self.external_db, self.timeout = store, str(Path(external_db).resolve()), timeout

    def prepare(self, state, proposal: ActionProposal, evidence):
        if not isinstance(proposal, ActionProposal):
            raise ValueError("unregistered action proposal")
        capability = self.capability(state, proposal.tool_ref)
        if proposal.tool_ref not in state["snapshot"]["agent"]["capabilities"]:
            raise PolicyDenied("tool is outside Agent capabilities")
        if not isinstance(proposal.args, dict) or any(r not in evidence for r in proposal.evidence_refs):
            raise ValueError("invalid arguments or untrusted evidence reference")
        if 'compiled_agent' in state['snapshot'] and (not isinstance(proposal.expected_checks, list)
                or set(proposal.expected_checks) - (set(domain_for(state['snapshot']).checks) | {'schema-and-scope'})):
            raise ValueError('unregistered expected verifier')
        task, tool = state["task"], proposal.tool_ref
        args = domain_for(state['snapshot']).prepare_args(state, tool, dict(proposal.args), evidence)
        if tool=='knowledge.search@1.0.0' and task.get('retrieval'):
            # Workflow configuration constrains the effective query; retain the
            # original model proposal alongside the normalized action for audit.
            args={**args,'query':task['retrieval']['query']}
        logical_id = f"{tool}:{state['replans']}:{state['report_revision']}"
        action = {"logical_id": logical_id, "tool_ref": tool, "args": args, "args_hash": digest(args),
                "status": "PREPARED", "attempts": 0, "reconcile_attempts": 0,
                "proposal": asdict(proposal), "resource": {"tenant_id": task["tenant_id"], "project_id": task["project_id"], "environment": task["environment"]}}

        if 'compiled_agent' in state['snapshot']:
            action.update(capability_hash=digest(capability), adapter_ref=capability['adapter_ref'])
        return action

    def capability(self, state, ref):
        capability = resolve_capability(state['snapshot'], ref)
        if self.store.capability_disabled(state['tenant_id'], ref):
            raise PolicyDenied('capability disabled by current policy')
        return capability

    def is_write(self, state, action):
        return resolve_capability(state['snapshot'], action['tool_ref'])['effect'] == 'WRITE'

    def authorize(self, state, action):
        capability = self.capability(state, action['tool_ref'])
        if 'compiled_agent' in state['snapshot'] and (action.get('capability_hash') != digest(capability)
                or action.get('adapter_ref') != capability['adapter_ref']):
            raise PolicyDenied('prepared capability binding has changed')
        if action["tool_ref"] not in state["snapshot"]["agent"]["capabilities"]:
            raise PolicyDenied("capability revoked")
        if action["args_hash"] != digest(action["args"]) or action["resource"] != {
            "tenant_id": state["tenant_id"], "project_id": state["task"]["project_id"], "environment": "test"
        }:
            raise PolicyDenied("prepared action has changed")
        if capability["effect"] == "READ":
            return {"policy_ref": state["snapshot"]["agent"]["policy_ref"], "kind": "task-scoped-read"}
        if state['snapshot'].get('context_policy'):
            from .knowledge import Library
            Library(self.store).validate_required(state)
        grant, task = self.store.get_grant(state), state["task"]
        if not grant or grant["revoked"] or grant["expires_at"] <= time.time():
            raise PolicyDenied("draft write grant absent, revoked or expired")
        if any(grant[k] != task[k] for k in ("principal", "project_id", "environment", "tenant_id")):
            raise PolicyDenied("grant scope mismatch")
        if grant["args_hash"] and grant["args_hash"] != action["args_hash"]:
            raise PolicyDenied("grant does not cover this argument hash")
        return {"principal": task["principal"], "run_id": state["run_id"], "tenant_id": state["tenant_id"],
                "tool_ref": action["tool_ref"], "args_hash": action["args_hash"], "resource": action["resource"],
                "expires_at": grant["expires_at"], "policy_ref": state["snapshot"]["agent"]["policy_ref"]}

    def invoke(self, state, action):
        # Current policy is checked again at the actual dispatch boundary.
        self.authorize(state, action)
        capability = self.capability(state, action['tool_ref'])
        trusted = {"tenant_id": state["tenant_id"], "run_id": state["run_id"],
                   "project_id": state["task"]["project_id"], "scenario": state["scenario"]}
        payload = {"external_db": self.external_db, "tool_ref": action["tool_ref"], "args": action["args"], "trusted": trusted}
        if capability['adapter_ref']=='scoped-library@1.0.0':
            from .domains.knowledge_answer import invoke_library
            try:
                if action['tool_ref']=='knowledge.search@1.0.0' and state['task'].get('retrieval'):
                    from .knowledge import Library,Access
                    access=Access.task(state['task']);config=state['task']['retrieval']
                    result=Library(self.store).search(access,config['query'],spaces=state['snapshot']['compiled_agent']['definition']['knowledge_spaces'],limit=50)
                    return {'tenant_id':access.tenant,'project_id':access.project,'hits':[
                        {k:a[k] for k in ('ref','title','content_hash','source_uri','source_version')} for a in [a for a in result['items'] if a['kind']=='KNOWLEDGE'][:config['top_k']]],
                        'excluded':result['excluded']}
                return invoke_library(self.store,state,action)
            except (KeyError,PolicyDenied) as exc:
                from .knowledge import KnowledgeUnavailable
                raise KnowledgeUnavailable('knowledge source is no longer readable') from exc
        return invoke_adapter(capability['adapter_ref'], payload, min(self.timeout, capability['timeout']),
                              capability['effect'] == 'WRITE')
