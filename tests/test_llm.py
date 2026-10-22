"""Offline adapter/control tests. These fixtures are not claimed as live model results."""

from dataclasses import asdict
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from agent_framework.contracts import Budget, TaskContract
from agent_framework.llm import CodexConfig, CodexTransport, LLMPlanner, ModelError, SYSTEM
from agent_framework.planner import MockPlanner
from agent_framework.runtime import CrashInjected, Runtime
from agent_framework.structured import SCHEMAS, SchemaError, parse_json, validate


class FixtureTransport:
    def __init__(self, mutate=None, delay=0):
        self.mutate, self.delay, self.requests = mutate, delay, []

    def generate(self, prompt, schema, config, timeout):
        request = json.loads(prompt[len(SYSTEM) + 1:])
        self.requests.append(request)
        if self.delay:
            time.sleep(self.delay)
        wire, phase = request["context"], request["phase"]
        run_id, revision = wire["draft_key"].rsplit(":report:", 1)
        state = {**wire["work"], "task": wire["task"], "run_id": run_id,
                 "report_revision": int(revision), "snapshot": {"skill": wire["skill"]}}
        context = {"state": state, "evidence": wire["evidence"]}
        planner = MockPlanner()
        result = {"steps": planner.plan(context)} if phase == "plan" else asdict(planner.decide(context)) if phase == "decide" else planner.compose(context)
        if phase == "plan":
            for step in result["steps"]:
                step.setdefault("tool_ref", None)
        if self.mutate:
            result = self.mutate(phase, result)
        return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False), {
            "usage": {"input_tokens": 10, "output_tokens": 5}, "model": config.model}


class LLMTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = CodexConfig("fixture-model", "low", timeout=5)
        self.transport = FixtureTransport()
        self.runtime = Runtime(self.tmp.name, planner=LLMPlanner(self.config, self.transport))

    def execute(self, scenario="normal", task=None):
        state = self.runtime.submit(task=task, scenario=scenario)
        return self.runtime.run(state["run_id"])

    def stats(self, result):
        return self.runtime.external.stats(result["tenant_id"], result["run_id"])

    def test_structured_model_loop_is_audited_and_config_is_frozen(self):
        result = self.execute()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["snapshot"]["planner_ref"], "codex-planner@1.0.0")
        self.assertEqual(result["model_calls"], 8)
        self.assertEqual(result["model_tokens"], 120)
        self.assertEqual({r["phase"] for r in self.transport.requests}, {"plan", "decide", "compose"})
        events = self.runtime.store.events(result["tenant_id"], result["run_id"])
        self.assertEqual(sum(e["kind"] == "model.requested" for e in events), 8)
        action_events = [e["data"] for e in events if e["kind"] == "decision.proposed" and e["data"]["action"]]
        self.assertEqual(len(action_events), 4)
        self.assertNotIn("scenario", self.transport.requests[0]["context"])
        self.assertNotIn("snapshot", self.transport.requests[0]["context"])

    def test_valid_schema_cannot_grant_cross_project_access(self):
        def mutate(phase, value):
            if phase == "decide" and value["action"]:
                value["action"]["args"]["project_id"] = "unauthorized-project"
            return value
        self.transport.mutate = mutate
        result = self.execute()
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.stats(result)["calls"], {})

    def test_unknown_tool_is_rejected_before_gateway(self):
        def mutate(phase, value):
            if phase == "decide" and value["action"]:
                value["action"]["tool_ref"] = "shell.exec@1.0.0"
            return value
        self.transport.mutate = mutate
        result = self.execute()
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.stats(result)["calls"], {})
        self.assertEqual(result["model_calls"], 3)

    def test_no_grant_and_revocation_are_still_enforced(self):
        result = self.execute("denied")
        self.assertEqual(result["status"], "WAITING_AUTH")
        self.assertEqual(self.stats(result)["drafts"], [])
        pending = next(a for a in result["actions"] if a["status"] == "PREPARED")
        self.runtime.store.grant(result, pending["args_hash"])
        before = len(self.transport.requests)
        # Dispatch the already fixed proposal without asking the model to rewrite it.
        resumed = self.runtime.run(result["run_id"], pause_after=1)
        self.assertEqual(len(self.transport.requests), before)
        self.assertEqual(len(self.stats(resumed)["drafts"]), 1)

    def test_model_claiming_completion_cannot_skip_verification(self):
        self.transport.mutate = lambda phase, value: {"kind": "request_finish", "summary": "done", "action": None} if phase == "decide" else value
        result = self.execute()
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertFalse(any(check["passed"] for check in result["checks"].values()))
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_schema_correct_but_fabricated_claims_never_reach_write(self):
        def mutate(phase, value):
            if phase == "compose":
                value["claims"][0]["value"] = 99
            return value
        self.transport.mutate = mutate
        result = self.execute()
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["replans"], 2)
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_model_cannot_forge_report_task_identity(self):
        def mutate(phase, value):
            if phase == "compose":
                value["task_ref"] = "another-run:report:0"
            return value
        self.transport.mutate = mutate
        result = self.execute()
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_external_count_uses_trusted_key_not_model_report_metadata(self):
        result = self.execute()
        with self.runtime.external.connect() as db:
            raw = db.execute("SELECT data FROM drafts").fetchone()[0]
            draft = json.loads(raw)
            draft["report"]["task_ref"] = "fabricated-report-metadata"
            db.execute("UPDATE drafts SET data=?", (json.dumps(draft),))
        self.assertEqual(len(self.stats(result)["drafts"]), 1)

    def test_external_tampering_still_fails_readback(self):
        result = self.execute("tampered-draft")
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertFalse(result["checks"]["draft-readback"]["passed"])

    def test_model_cannot_defer_bad_readback_by_requesting_input(self):
        def mutate(phase, value):
            if phase == "decide" and self.transport.requests[-1]["context"]["work"]["observations"].get("draft_readback"):
                return {"kind": "request_input", "summary": "please check mismatch", "action": None}
            return value
        self.transport.mutate = mutate
        result = self.execute("tampered-draft")
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertFalse(result["checks"]["draft-readback"]["passed"])
        self.assertFalse(any(r["phase"] == "decide" and r["context"]["work"]["observations"].get("draft_readback") for r in self.transport.requests))

    def test_lost_response_recovers_without_model_deciding_to_repeat_write(self):
        result = self.execute("response-lost")
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(self.stats(result)["calls"]["report.draft.create@1.0.0"], 1)
        # Once creation was proposed, the next model decision is finish; reconciliation supplied the readback.
        after_write = [r for r in self.transport.requests if r["phase"] == "decide" and r["context"]["work"]["draft"]]
        self.assertEqual(len(after_write), 1)

    def test_write_crash_restores_existing_intent_and_never_recreates(self):
        self.runtime = Runtime(self.tmp.name, planner=LLMPlanner(self.config, self.transport), lease_seconds=0.3, tool_timeout=0.15)
        state = self.runtime.submit(scenario="crash-after-write")
        with self.assertRaises(CrashInjected):
            self.runtime.run(state["run_id"])
        before_calls = len(self.transport.requests)
        time.sleep(0.32)
        restarted = Runtime(self.tmp.name, planner=LLMPlanner(self.config, self.transport))
        result = restarted.run(state["run_id"])
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(len(self.transport.requests) - before_calls, 1)
        self.assertEqual(self.stats(result)["calls"]["report.draft.create@1.0.0"], 1)

    def test_changed_model_is_rejected_before_resuming(self):
        state = self.runtime.submit()
        different = Runtime(self.tmp.name, planner=LLMPlanner(CodexConfig("other-model"), self.transport))
        result = different.run(state["run_id"])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.transport.requests, [])

    def test_restart_without_planner_flags_restores_the_frozen_adapter(self):
        state = self.runtime.submit()
        self.runtime.run(state["run_id"], pause_after=1)
        restarted = Runtime(self.tmp.name)
        with patch("agent_framework.llm.CodexTransport.generate", side_effect=self.transport.generate):
            result = restarted.run(state["run_id"])
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["snapshot"]["planner"]["config"]["model"], "fixture-model")
        self.assertEqual(self.stats(result)["calls"]["change.read@1.0.0"], 1)

    def test_bad_json_is_repaired_once_with_validation_feedback(self):
        self.transport.mutate = lambda phase, value: "not JSON" if len(self.transport.requests) == 1 else value
        result = self.execute()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["model_calls"], 9)
        self.assertIsNotNone(self.transport.requests[1]["format_feedback"])

    def test_refusal_or_transport_error_does_not_fall_back_to_mock(self):
        class Unavailable:
            def generate(self, *args):
                raise ModelError("model_timeout")
        self.runtime.planner.transport = Unavailable()
        result = self.execute()
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["model_calls"], 1)
        self.assertEqual(self.stats(result)["calls"], {})

    def test_model_call_and_token_budgets_are_enforced(self):
        for budget in (Budget(max_model_calls=1), Budget(max_model_tokens=1)):
            with self.subTest(budget=budget):
                result = self.execute(task=TaskContract(budget=budget))
                self.assertEqual(result["status"], "EXPIRED")
                self.assertEqual(result["model_calls"], 1)
                self.assertEqual(self.stats(result)["calls"], {})

    def test_long_inference_keeps_the_lease_alive(self):
        self.transport.delay = 0.3
        self.transport.mutate = lambda phase, value: {"kind": "request_finish", "summary": "done", "action": None} if phase == "decide" else value
        self.runtime = Runtime(self.tmp.name, planner=LLMPlanner(self.config, self.transport), lease_seconds=0.12, tool_timeout=0.05)
        result = self.execute()
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertEqual(result["model_calls"], 2)

    def test_local_parser_rejects_ambiguous_or_non_json_output(self):
        for raw in ('{"kind":"a","kind":"b"}', '{"n":NaN}', '```json\n{}\n```'):
            with self.assertRaises(SchemaError):
                parse_json(raw)
        with self.assertRaises(SchemaError):
            validate({"steps": [], "grant": True}, SCHEMAS["plan"])

    def test_cli_transport_disables_tools_and_rejects_tool_events(self):
        for kind in ("agent_message", "error", "command_execution", "mcp_tool_call"):
            with self.subTest(kind=kind):
                commands = []

                class FakeProcess:
                    returncode = 0

                    def __init__(self, command, **kwargs):
                        commands.append(command)
                        Path(command[command.index("--output-last-message") + 1]).write_text('{"steps":[]}')

                    def communicate(self, *args, **kwargs):
                        return json.dumps({"type": "item.completed", "item": {"type": kind}}) + '\n' + json.dumps({
                            "type": "turn.completed", "usage": {"input_tokens": 3, "output_tokens": 2}}), ''

                with patch("agent_framework.llm.subprocess.Popen", FakeProcess):
                    if kind in ("agent_message", "error"):
                        raw, meta = CodexTransport().generate("synthetic", SCHEMAS["plan"], self.config, 5)
                        self.assertEqual(meta["usage"]["input_tokens"], 3)
                        self.assertEqual(meta["cli_diagnostic_count"], int(kind == "error"))
                    else:
                        with self.assertRaises(ModelError):
                            CodexTransport().generate("synthetic", SCHEMAS["plan"], self.config, 5)
                command = commands[0]
                self.assertIn("features.shell_tool=false", command)
                self.assertIn("features.plugins=false", command)
                self.assertIn("--ignore-user-config", command)
                self.assertIn("read-only", command)


if __name__ == "__main__":
    unittest.main()
