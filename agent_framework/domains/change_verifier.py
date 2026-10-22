"""Independent rules and business readback; planner completion is never sufficient."""

from datetime import date

from ..contracts import digest
from ..planner import write_key


def verdict(passed, detail, refs=()):
    return {"passed": bool(passed), "detail": detail, "evidence_refs": list(refs), "verifier_ref": "release-verifier@1.0.0"}


def validate_observation(tool, data, task):
    if not isinstance(data, dict):
        return False
    if tool.startswith("change.read"):
        return (data.get("id") == task["change_id"] and data.get("project_id") == task["project_id"]
                and data.get("tenant_id") == task["tenant_id"] and data.get("environment") == task["environment"]
                and type(data.get("version")) is int and data["version"] > 0
                and isinstance(data.get("service"), str)
                and ("tests" not in data or (isinstance(data["tests"], dict) and all(type(data["tests"].get(k)) is int and data["tests"][k] >= 0 for k in ("passed", "failed")))))
    if tool.startswith("standards.read"):
        return (data.get("id") == "release-review-rubric" and data.get("version") == "1.0.0"
                and data.get("effective_until", "") >= date.today().isoformat()
                and data.get("rules") == {"failed_tests_risk": "HIGH", "dependency_risk": "MEDIUM", "default_risk": "LOW"}
                and data.get("required_sections") == ["summary", "impact", "risks", "test_results", "rollback", "recommendation"])
    if tool.startswith("report.draft.create"):
        return isinstance(data.get("id"), str) and type(data.get("version")) is int
    if tool.startswith("report.read"):
        return type(data.get("found")) is bool and data.get("authoritative") is True and (not data["found"] or isinstance(data.get("draft"), dict))
    return False


def local_checks(state, evidence):
    report = state["report"] or {}
    if (not isinstance(report, dict) or not isinstance(report.get("sections", {}), dict)
            or not isinstance(report.get("claims", []), list)
            or any(not isinstance(c, dict) or not isinstance(c.get("path"), str)
                   or not isinstance(c.get("evidence_ref"), str) for c in report.get("claims", []))):
        return {name: verdict(False, "报告结构非法") for name in ("report-sections", "critical-claims-evidence")}
    standard_obs = state["observations"].get("standards", {})
    change_obs = state["observations"].get("change", {})
    required = standard_obs.get("data", {}).get("required_sections", [])
    sections = report.get("sections", {})
    complete = bool(required) and all(isinstance(sections.get(k), str) and sections[k].strip() for k in required)
    refs = [change_obs.get("id"), standard_obs.get("id")]
    valid = all(r in evidence and evidence[r]["content_hash"] == digest(evidence[r]["data"]) for r in refs)
    change = change_obs.get("data", {})
    claims = report.get("claims", [])
    valid = valid and len(claims) == 5 and {c.get("path") for c in claims} == {"version", "service", "dependencies", "tests", "rollback"}
    for claim in claims:
        source = evidence.get(claim.get("evidence_ref"), {})
        valid = valid and source.get("id") == change_obs.get("id") and claim.get("path") in source.get("data", {}) and source.get("data", {}).get(claim.get("path")) == claim.get("value")
    expected_risk = "HIGH" if change.get("tests", {}).get("failed", 0) > 0 else ("MEDIUM" if change.get("dependencies") else "LOW")
    valid = (valid and report.get("risk_level") == expected_risk and report.get("change_id") == state["task"]["change_id"]
             and report.get("source_version") == change.get("version") and report.get("standard_ref") == standard_obs.get("id")
             and report.get("task_ref") == write_key(state))
    return {"report-sections": verdict(complete, "所有必选章节非空" if complete else "缺少必选章节", refs),
            "critical-claims-evidence": verdict(valid, "关键事实、来源哈希、版本与风险规则一致" if valid else "事实引用或风险判定不一致", refs)}


def task_checks(state, evidence):
    checks = local_checks(state, evidence)
    obs = state["observations"].get("draft_readback", {})
    data = obs.get("data", {})
    draft = data.get("draft") or {}
    task, report = state["task"], state["report"]
    passed = (data.get("found") is True and draft.get("id") == (state["draft"] or {}).get("id")
              and draft.get("status") == "DRAFT" and draft.get("version") == (state["draft"] or {}).get("version")
              and draft.get("tenant_id") == task["tenant_id"] and draft.get("project_id") == task["project_id"]
              and draft.get("change_id") == task["change_id"] and draft.get("source_version") == (report or {}).get("source_version")
              and draft.get("content_hash") == digest(report) and draft.get("report") == report
              and obs.get("id") in evidence and evidence[obs["id"]]["content_hash"] == digest(data))
    checks["draft-readback"] = verdict(passed, "草稿对象、状态、版本、内容及哈希回读一致" if passed else "草稿回读不满足预期", [obs["id"]] if obs else [])
    return checks
