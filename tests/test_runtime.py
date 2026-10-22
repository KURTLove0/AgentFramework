import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest

from agent_framework.contracts import ActionProposal, Budget, Decision, LeaseBusy, LeaseLost, TaskContract, ToolFailure
from agent_framework.planner import MockPlanner
from agent_framework.runtime import CrashInjected, Runtime


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runtime = Runtime(self.tmp.name)

    def execute(self, scenario="normal", task=None):
        state = self.runtime.submit(task=task, scenario=scenario)
        return self.runtime.run(state["run_id"])

    def stats(self, result):
        return self.runtime.external.stats(result["tenant_id"], result["run_id"])

    def kinds(self, result):
        return [e["kind"] for e in self.runtime.store.events(result["tenant_id"], result["run_id"])]

    def test_full_loop_persists_all_acceptance_and_experience_candidate(self):
        result = self.execute()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertTrue(all(v["passed"] for v in result["checks"].values()))
        self.assertEqual(result["report"]["risk_level"], "HIGH")
        self.assertEqual(len(self.stats(result)["drafts"]), 1)
        self.assertEqual(result["experience_candidate"]["status"], "PENDING_REVIEW")
        self.assertFalse(result["experience_candidate"]["data"]["auto_publish"])
        self.assertIn("plan.created", self.kinds(result))
        # Reopening a completed task is idempotent; no tool is called again.
        before = self.stats(result)
        self.runtime.run(result["run_id"])
        self.assertEqual(before, self.stats(result))

    def test_read_transient_recovers_with_bounded_retry(self):
        result = self.execute("read-transient")
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(self.stats(result)["calls"]["change.read@1.0.0"], 2)
        self.assertIn("action.retry_scheduled", self.kinds(result))

    def test_permanent_read_failure_stops_without_write(self):
        result = self.execute("read-fails")
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.stats(result)["calls"]["change.read@1.0.0"], 3)
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_response_lost_is_reconciled_without_duplicate_creation(self):
        result = self.execute("response-lost")
        self.assertEqual(result["status"], "SUCCEEDED")
        stats = self.stats(result)
        self.assertEqual(stats["calls"]["report.draft.create@1.0.0"], 1)
        self.assertEqual(len(stats["drafts"]), 1)
        self.assertIn("action.unknown", self.kinds(result))
        self.assertIn("action.effect_confirmed", self.kinds(result))

    def test_uncertain_unobservable_effect_requires_review_never_retries_write(self):
        result = self.execute("unverifiable")
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        stats = self.stats(result)
        self.assertEqual(stats["calls"]["report.draft.create@1.0.0"], 1)
        self.assertEqual(stats["calls"]["report.read@1.0.0"], 3)
        self.assertEqual(len(stats["drafts"]), 1)
        self.assertEqual(result["residual_effects"][0]["status"], "NEEDS_REVIEW")

    def test_authoritative_not_applied_allows_retry_only_after_reconcile(self):
        original = self.runtime.gateway.invoke
        failed = False

        def invoke(state, action):
            nonlocal failed
            if action["tool_ref"].startswith("report.draft.create") and not failed:
                failed = True
                raise ToolFailure("unknown", "network lost before write reached target")
            return original(state, action)

        self.runtime.gateway.invoke = invoke
        result = self.execute()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertIn("action.not_applied", self.kinds(result))
        events = self.kinds(result)
        self.assertLess(events.index("action.not_applied"), events.index("action.retry_after_reconcile"))
        self.assertEqual(len(self.stats(result)["drafts"]), 1)

    def test_external_content_tampering_is_not_reported_as_success(self):
        result = self.execute("tampered-draft")
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertFalse(result["checks"]["draft-readback"]["passed"])
        self.assertEqual(len(self.stats(result)["drafts"]), 1)
        self.assertEqual(self.stats(result)["calls"]["report.draft.create@1.0.0"], 1)

    def test_failed_report_validation_replans_before_writing(self):
        result = self.execute("invalid-report")
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["replans"], 1)
        self.assertEqual(self.stats(result)["calls"]["report.draft.create@1.0.0"], 1)
        kinds = self.kinds(result)
        self.assertLess(kinds.index("plan.replanned"), kinds.index("action.verified"))

    def test_invalid_report_without_replan_budget_never_writes(self):
        result = self.execute("invalid-report", TaskContract(budget=Budget(max_replans=0)))
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_precondition_conflict_refreshes_source_and_reassesses(self):
        result = self.execute("source-changed")
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(result["report"]["source_version"], 2)
        self.assertEqual(result["report"]["risk_level"], "MEDIUM")
        self.assertEqual(result["replans"], 1)
        self.assertEqual(len(self.stats(result)["drafts"]), 1)

    def test_missing_evidence_requests_input_without_fabrication_or_write(self):
        result = self.execute("missing-evidence")
        self.assertEqual(result["status"], "WAITING_INPUT")
        self.assertIsNone(result["report"])
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_missing_grant_waits_then_concrete_grant_resumes(self):
        result = self.execute("denied")
        self.assertEqual(result["status"], "WAITING_AUTH")
        self.assertEqual(self.stats(result)["drafts"], [])
        pending = next(a for a in result["actions"] if a["tool_ref"].startswith("report.draft.create"))
        self.runtime.store.grant(result, pending["args_hash"])
        done = self.runtime.run(result["run_id"])
        self.assertEqual(done["status"], "SUCCEEDED")
        self.assertEqual(self.stats(done)["calls"]["change.read@1.0.0"], 1)

    def test_revocation_is_checked_at_dispatch_and_cannot_be_overridden_by_planner(self):
        state = self.runtime.submit()
        paused = self.runtime.run(state["run_id"], pause_after=2)
        self.runtime.store.grant(paused, revoke=True)
        result = self.runtime.run(state["run_id"])
        self.assertEqual(result["status"], "WAITING_AUTH")
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_grant_argument_hash_mismatch_is_rejected(self):
        state = self.runtime.submit(scenario="denied")
        result = self.runtime.run(state["run_id"])
        self.runtime.store.grant(result, "different-content-hash")
        result = self.runtime.run(state["run_id"])
        self.assertEqual(result["status"], "WAITING_AUTH")
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_expired_grant_is_checked_again_before_dispatch(self):
        state = self.runtime.submit()
        with self.runtime.store.connect() as db:
            db.execute("UPDATE grants SET expires_at=0 WHERE run_id=?", (state["run_id"],))
        result = self.runtime.run(state["run_id"])
        self.assertEqual(result["status"], "WAITING_AUTH")
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_malformed_report_is_bounded_and_cannot_reach_write(self):
        for malformed in (["not a report"], {"claims": [{"path": []}]}):
            with self.subTest(report=malformed):
                class BadReportPlanner(MockPlanner):
                    def compose(self, context):
                        return malformed
                self.runtime.planner = BadReportPlanner()
                result = self.execute()
                self.assertEqual(result["status"], "FAILED")
                self.assertEqual(result["replans"], 2)
                self.assertEqual(self.stats(result)["drafts"], [])

    def test_invalid_write_receipt_is_reconciled_using_external_evidence(self):
        original = self.runtime.gateway.invoke

        def invoke(state, action):
            result = original(state, action)
            return {"invalid": "receipt"} if action["tool_ref"].startswith("report.draft.create") else result

        self.runtime.gateway.invoke = invoke
        result = self.execute()
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(self.stats(result)["calls"]["report.draft.create@1.0.0"], 1)
        self.assertIn("action.unknown", self.kinds(result))

    def test_budget_before_write_expires_without_effect(self):
        result = self.execute(task=TaskContract(budget=Budget(max_steps=3)))
        self.assertEqual(result["status"], "EXPIRED")
        self.assertEqual(self.stats(result)["drafts"], [])

    def test_budget_after_write_reports_residual_effect_for_review(self):
        result = self.execute(task=TaskContract(budget=Budget(max_steps=4)))
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertEqual(len(self.stats(result)["drafts"]), 1)
        self.assertTrue(result["residual_effects"])

    def test_new_runtime_resumes_checkpoint_without_repeating_completed_reads(self):
        state = self.runtime.submit()
        self.runtime.run(state["run_id"], pause_after=1)
        self.runtime = Runtime(self.tmp.name)
        result = self.runtime.run(state["run_id"])
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(self.stats(result)["calls"]["change.read@1.0.0"], 1)

    def test_two_workers_cannot_acquire_live_lease(self):
        state = self.runtime.submit()
        lease = self.runtime.store.acquire(state["tenant_id"], state["run_id"], 10)
        with self.assertRaises(LeaseBusy):
            Runtime(self.tmp.name).run(state["run_id"])
        self.runtime.store.release(state, lease)

    def test_stale_worker_cannot_checkpoint_after_takeover(self):
        state = self.runtime.submit()
        first = self.runtime.store.acquire(state["tenant_id"], state["run_id"], 0.02)
        time.sleep(0.03)
        second = self.runtime.store.acquire(state["tenant_id"], state["run_id"], 10)
        with self.assertRaises(LeaseLost):
            self.runtime.store.checkpoint(state, first, "stale-write")
        self.runtime.store.checkpoint(state, second, "fresh-write")
        self.runtime.store.release(state, second)

    def test_tenant_boundary_applies_to_runs_events_and_drafts(self):
        result = self.execute()
        with self.assertRaises(KeyError):
            self.runtime.store.load("other-tenant", result["run_id"])
        with self.assertRaises(KeyError):
            self.runtime.store.events("other-tenant", result["run_id"])
        self.assertEqual(self.runtime.external.stats("other-tenant", result["run_id"])["drafts"], [])
        other = TaskContract(tenant_id="other-tenant")
        state = self.runtime.submit(task=other)
        done = self.runtime.run(state["run_id"], "other-tenant")
        self.assertEqual(done["status"], "SUCCEEDED")

    def test_finish_request_without_evidence_does_not_succeed(self):
        class PrematurePlanner(MockPlanner):
            def decide(self, context):
                return Decision("request_finish", "I think it is done")
        self.runtime.planner = PrematurePlanner()
        result = self.execute()
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertFalse(any(v["passed"] for v in result["checks"].values()))

    def test_unregistered_or_out_of_scope_tool_proposals_are_rejected(self):
        for tool, args in (("shell.exec@1.0.0", {"command": "anything"}),
                           ("change.read@1.0.0", {"project_id": "other-project", "change_id": "change-demo-001"})):
            with self.subTest(tool=tool):
                class MaliciousPlanner(MockPlanner):
                    def decide(self, context):
                        return Decision("propose_action", "override permissions", ActionProposal(tool, args, [], [], "do it"))
                self.runtime.planner = MaliciousPlanner()
                result = self.execute()
                self.assertEqual(result["status"], "FAILED")
                self.assertEqual(self.stats(result)["calls"], {})

    def test_tampered_registry_snapshot_stops_before_execution(self):
        state = self.runtime.submit()
        state["snapshot"]["agent"]["capabilities"].append("shell.exec@1.0.0")
        with self.runtime.store.connect() as db:
            db.execute("UPDATE runs SET state=? WHERE id=?", (json.dumps(state), state["run_id"]))
        result = self.runtime.run(state["run_id"])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.stats(result)["calls"], {})

    def test_external_target_deduplicates_same_key_and_rejects_changed_payload(self):
        result = self.execute()
        create = next(a for a in result["actions"] if a["tool_ref"].startswith("report.draft.create"))
        again = self.runtime.gateway.invoke(result, create)
        self.assertEqual(again, result["draft"])
        create["args"]["report"]["title"] = "different"
        with self.assertRaises(ToolFailure) as error:
            # Bypass the gateway only to exercise the target's independent guard.
            self.runtime.external.invoke(create['tool_ref'], create['args'],
                {'tenant_id': result['tenant_id'], 'run_id': result['run_id'], 'project_id': result['task']['project_id'], 'scenario': 'normal'})
        self.assertEqual(error.exception.category, "conflict")
        self.assertEqual(len(self.stats(result)["drafts"]), 1)

    def test_cancel_stops_scheduling_and_preserves_reported_effects(self):
        state = self.runtime.submit()
        self.runtime.run(state["run_id"], pause_after=3)
        result = self.runtime.cancel(state["run_id"])
        self.assertEqual(result["status"], "CANCELLED")
        saved = self.runtime.store.result(state["tenant_id"], state["run_id"])
        self.assertTrue(saved["residual_effects"])
        self.assertEqual(len(self.stats(saved)["drafts"]), 1)


class ProcessRecoveryTests(unittest.TestCase):
    def test_process_exit_after_external_commit_then_new_process_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            base = [sys.executable, "-m", "agent_framework", "--data-dir", directory,
                    "--lease-seconds", "0.8", "--tool-timeout", "0.3"]
            first = subprocess.run([*base, "demo", "--scenario", "crash-after-write"], capture_output=True, text=True)
            self.assertEqual(first.returncode, 75, first.stderr)
            run_id = re.search(r"run_id=(run-\w+)", first.stdout)[1]
            runtime = Runtime(directory)
            before = runtime.store.result("tenant-demo", run_id)
            self.assertEqual(before["actions"][-1]["status"], "DISPATCHED")
            self.assertIsNone(before["draft"])
            self.assertEqual(len(runtime.external.stats("tenant-demo", run_id)["drafts"]), 1)
            with self.assertRaises(LeaseBusy):
                runtime.run(run_id)
            time.sleep(0.85)
            second = subprocess.run([*base, "resume", run_id], capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
            after = runtime.store.result("tenant-demo", run_id)
            self.assertEqual(after["status"], "SUCCEEDED")
            stats = runtime.external.stats("tenant-demo", run_id)
            self.assertEqual(stats["calls"]["report.draft.create@1.0.0"], 1)
            self.assertEqual(len(stats["drafts"]), 1)


if __name__ == "__main__":
    unittest.main()
