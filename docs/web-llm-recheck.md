# Web UI 真实模型复验

2026-10-22，使用本机 Codex CLI 的 ChatGPT 登录态、`gpt-6.1-sol`、`high` 推理强度。任务创建、授权和重启后的恢复均从 Web UI 操作；变更、规范、测试证据与草稿全部为模拟数据。模型接收任务、内置角色/Skill、模拟证据和 Schema，业务写入仍由本地网关执行。本次使用内置 Agent，没有启用外部 MCP。

## 复验结果

| 场景 | 运行 ID | 结果 | 验收 | 创建调用 / 草稿 |
| --- | --- | --- | --- | --- |
| 正常流程 | `run-e717b3422559495b` | SUCCEEDED | 3/3 | 1 / 1 |
| 无授权 → 页面审查并授权 | `run-1b386b79b4944bfd` | SUCCEEDED | 3/3 | 1 / 1 |
| 写入成功但响应丢失 | `run-67cc8c2ba39f4680` | SUCCEEDED | 3/3 | 1 / 1 |
| 写后中断 → 服务进程重启 → 页面恢复 | `run-2c01ebe306404139` | SUCCEEDED | 3/3 | 1 / 1 |
| 草稿内容被模拟业务系统篡改 | `run-84a68aa159cc462d` | NEEDS_REVIEW | 2/3，回读失败 | 1 / 1 |

五个完成场景共收到 37 次真实模型响应。导出的结构化计划、动作决策和报告再次通过本地 Schema 校验。独立数据库查询确认每个运行实际只有一份草稿。

- **授权拦截**：授权前处于 WAITING_AUTH，创建调用和草稿数均为零；页面审查并签发的参数哈希与实际动作授权回执完全一致。
- **响应丢失**：审计事件为 `action.unknown → action.reconciling → action.reconciled → action.effect_confirmed`，没有再次调用 create。
- **真实进程重启**：重启前保留 DISPATCHED 意图，外部库已经存在草稿。确认没有活动线程后停止 PID 10377，以同一数据目录启动 PID 27442。页面恢复原运行，外部副作用确认发生在下一次模型请求之前。模型快照、动作参数、参数哈希、授权、幂等键和原草稿均保持一致，创建次数仍为 1。
- **验收拒绝**：外部草稿被篡改时，独立回读验收失败，保留草稿供人工检查，模型不能将其标记为成功。
- **重复恢复**：五个终态运行再次请求恢复全部返回 HTTP 409；状态、审计事件、模型调用、工具调用及草稿数均未增加。

## 超时与界面修正

最初正常、写后中断和篡改三个尝试触及原有 60 秒模型超时，均明确进入 FAILED，且没有草稿或创建调用。没有静默切换模拟规划器。通过 Web UI 将后续调用超时调为 180 秒，并重新提交这三个模拟用例；旧失败记录保留。授权、响应丢失两项仍沿用提交时冻结的 60 秒配置；另外三项冻结为 180 秒，模型和推理强度相同。默认运行时仍为模拟模式。

复验时重启了使用旧代码的后台服务，解决新前端与旧后台不匹配导致的初始化错误。另将审计事件 `task.verified` 的界面标题改为“独立验收已完成”，避免验收未通过时仍显示“全部通过”。81 项后端回归测试通过，前端脚本语法检查通过；未改动网关、验收规则或恢复策略。

## 查看和重现

服务现已运行，可直接打开[重启恢复后的运行](http://127.0.0.1:8787/#/workbench/run-2c01ebe306404139)，查看“证据与验收”“动作提案”和“执行轨迹”。

重新启动命令：

```bash
cd /Users/kurt/Desktop/CodeSpace/AgentFramework
codex login status
python3 -m agent_framework serve --port 8787
```

在“运行时配置”中选择 Codex CLI，模型 `gpt-6.1-sol`、推理强度 `high`、单次超时 180 秒。新建任务选择 Codex CLI，只填写模拟上下文并勾选发送许可，依次执行表中场景。写后中断时停止并重启同一数据目录的服务，再恢复原 ID；不要新建任务替代恢复。

原始产物保存在 `.agent-data/web-llm-recheck-20261022/`：

- `summary.json` 及各场景 `result.json`、`report.md`、`events.jsonl`、`external.json`。
- `denied-before/`、`grant-binding.json`：授权前零写入及参数哈希绑定。
- `crash-before-restart/`、`before-server-restart.json`、`restart-comparison.json`：重启前后事实与事件顺序。
- `terminal-resume-checks.json`：重复恢复拒绝且无新增副作用。
- `model-timeout-attempts.json` 及对应目录：三个初始超时记录。
- `authorization-review.png`、`tampered-draft.png`、`recovered-real-model.png`：页面证据。

仅重新验证现有产物，不调用模型：

```bash
python3 .agent-data/web-llm-recheck-20261022/collect.py --final
python3 .agent-data/web-llm-recheck-20261022/compare_restart.py
# 工作台运行时，可再次检查终态恢复接口：
python3 .agent-data/web-llm-recheck-20261022/check_terminal.py
```

这些结论覆盖上述固定模拟样本；业务身份与权限仍为本机开发模拟。
