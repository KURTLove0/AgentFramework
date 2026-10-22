"""Deterministic cognition fixture for the published change-assessment domain."""
from ..contracts import ActionProposal, Decision
from ..planner import write_key


class MockPlanner:
    def plan(self, context):
        return [
            {"id": "perceive", "description": "读取变更、服务依赖和测试证据", "tool_ref": "change.read@1.0.0"},
            {"id": "retrieve", "description": "检索已发布规范", "tool_ref": "standards.read@1.0.0"},
            {"id": "assess", "description": "按 Skill 生成带引用的风险报告"},
            {"id": "validate", "description": "独立校验章节、风险规则和事实引用"},
            {"id": "create", "description": "持久化并授权写入意图，创建草稿", "tool_ref": "report.draft.create@1.0.0"},
            {"id": "verify", "description": "外部回读并检查全部必选验收项", "tool_ref": "report.read@1.0.0"},
        ]

    def decide(self, context):
        state, task = context["state"], context["state"]["task"]
        common = {"project_id": task["project_id"]}

        def propose(tool, args, summary):
            return Decision("propose_action", summary, ActionProposal(tool, args, list(context["evidence"]),
                            ["draft-readback"] if tool.startswith("report.") else ["schema-and-scope"], summary))

        if "change" not in state["observations"]:
            return propose("change.read@1.0.0", {**common, "change_id": task["change_id"]}, "先获取当前变更事实")
        if "standards" not in state["observations"]:
            return propose("standards.read@1.0.0", common, "加载风险判定标准")
        change = state["observations"]["change"]["data"]
        if any(k not in change for k in ("tests", "dependencies", "rollback")):
            return Decision("request_input", "变更缺少测试、依赖或回滚证据，需要补充后重新提交")
        if state["report"] is None:
            return Decision("compose_report", "依据已获取证据与风险规则编写报告")
        if not state["draft"]:
            return propose("report.draft.create@1.0.0", {**common, "change_id": task["change_id"],
                           "source_version": change["version"], "report": state["report"]}, "报告已通过本地验收，申请创建草稿")
        if "draft_readback" not in state["observations"]:
            return propose("report.read@1.0.0", {**common, "idempotency_key": write_key(state)}, "独立回读草稿")
        return Decision("request_finish", "请求按机器验收条件完成任务")

    def compose(self, context):
        state = context["state"]
        change_obs, standards_obs = state["observations"]["change"], state["observations"]["standards"]
        change, standard = change_obs["data"], standards_obs["data"]
        rules = state["snapshot"]["skill"]["manifest"]["risk_rules"]
        risk = rules["failed_tests"] if change["tests"]["failed"] else (
            rules["dependencies"] if change["dependencies"] else rules["otherwise"])
        claims = [{"path": path, "value": change[path], "evidence_ref": change_obs["id"]}
                  for path in ("version", "service", "dependencies", "tests", "rollback")]
        return {
            "title": f"{change['title']} · 变更评估", "change_id": change["id"], "source_version": change["version"],
            "task_ref": write_key(state), "risk_level": risk, "standard_ref": standards_obs["id"], "claims": claims,
            "sections": {
                "summary": f"评估 {change['id']}，来源版本 {change['version']}，风险 {risk}。",
                "impact": f"服务 {change['service']}；依赖：{', '.join(change['dependencies']) or '无'}。",
                "risks": f"依照 release-review-rubric@1.0.0 判为 {risk}。",
                "test_results": f"通过 {change['tests']['passed']} 项，失败 {change['tests']['failed']} 项。",
                "rollback": change["rollback"],
                "recommendation": "修复失败测试并复核后再决定发布。" if change["tests"]["failed"] else "补充依赖联调评估，提交人工审核。",
            },
            "limitations": ["模拟数据；草稿供人工审核；未执行发布或部署。"],
        }

