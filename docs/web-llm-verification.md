# Web UI 真实模型闭环验收

最新一轮重新执行的任务、真实进程重启对比，以及模型超时处理记录见 [Web UI 真实模型复验](web-llm-recheck.md)。

日期：2026-10-22（Asia/Shanghai）。本机 `codex login status` 返回 `Logged in using ChatGPT`。通过 Web UI 创建五个任务，规划器均为 `codex-planner@1.0.0`，冻结模型为 `gpt-6.1-sol`，推理强度 `high`。本轮未修改运行时、授权策略、Schema 或验收规则。

任务、变更、规范、依赖、测试结果及草稿均为模拟数据。任务只包含 `change-web-llm-001` 至 `005`、`project-demo`、`tenant-demo` 和 test 环境。模型上下文由既有过滤器构造，不传入仓库文件内容、凭据或授权记录；本机登录态由 Codex CLI 自行使用。所有任务均在页面勾选模型上下文发送许可，审计事件包含 `model.sharing_consented`。

## 结果

| 场景 | 最终状态 | 验收 | 创建调用 | 实际草稿 | 模型调用 |
|---|---|---|---:|---:|---:|
| 正常流程 | SUCCEEDED | 3/3 通过 | 1 | 1 | 8 |
| 缺少授权 → 页面授权后继续 | SUCCEEDED | 3/3 通过 | 1 | 1 | 8 |
| 写入成功但响应丢失 | SUCCEEDED | 3/3 通过 | 1 | 1 | 7 |
| 写后中断 → 重启服务 → 页面恢复 | SUCCEEDED | 3/3 通过 | 1 | 1 | 7 |
| 外部草稿内容篡改 | NEEDS_REVIEW | 回读拒绝，2/3 通过 | 1 | 1 | 7 |

共 37 次真实模型请求及响应。模型生成 7–8 步结构化计划、单步决策和评估报告；导出后的计划、决策及报告再次通过本地 Schema 校验。真实调用由 `model.requested` / `model.responded` 事件、用量、冻结模型描述和实际输出佐证，业务工具仍由本地网关与独立模拟数据库执行。

## 关键证据

- **授权**：授权前保存 `WAITING_AUTH`，create=0、drafts=0。随后在 Web UI 的“审查并授权”弹窗查看具体写入参数哈希并继续。`grant.issued.args_hash` 与实际动作授权回执中的 `args_hash` 一致，最终通过三项验收。
- **响应丢失**：日志记录 `action.unknown → action.reconciling → action.effect_confirmed`；使用原幂等键找到已提交草稿，create 调用仍为 1。
- **真实进程重启**：工作线程在写入后留下 `DISPATCHED` 意图，外部库已有 1 份草稿。确认所有线程停止后，终止旧 Web 服务进程 70634，再以同一数据目录启动新进程 88567。在页面恢复原运行 `run-1d31032dc1f346e0`，先完成外部副作用核对，再发出下一次模型请求。模型快照、动作参数、参数哈希、幂等键与外部草稿均与重启前一致；草稿和创建调用仍各为 1。
- **独立验收反例**：模拟业务系统把报告风险从 HIGH 篡改为 LOW，客观回读校验失败并进入 `NEEDS_REVIEW`。草稿保留供人工核对，没有被标记为成功。
- **重复恢复**：对五个终态运行再次提交恢复请求，Web API 全部返回 409；模型请求、外部工具调用和草稿行数均未增加。

## 在 Web UI 查看

[恢复后的真实模型运行](http://127.0.0.1:8787/#/workbench/run-1d31032dc1f346e0)。切换“执行轨迹”“评估报告”“证据与验收”“动作提案”查看模型输出与独立判定。其他运行如下：

- 正常流程：`run-61558052cc844549`（`change-web-llm-001`）
- 缺少授权 → 页面授权后继续：`run-94951d4ff58a44e4`（`change-web-llm-002`）
- 写入成功但响应丢失：`run-dacd2cd2f6df42f1`（`change-web-llm-003`）
- 写后中断 → 重启服务 → 页面恢复：`run-1d31032dc1f346e0`（`change-web-llm-004`）
- 外部草稿内容篡改：`run-8b8ae865d97e4f0f`（`change-web-llm-005`）

## 重现与原始产物

```bash
codex login status
python3 -m agent_framework serve --port 8787
```

在新建任务中选择“Codex CLI · 真实大模型”，填写纯模拟任务并勾选许可。分别选择上述五个场景。未授权时先核对草稿参数再授权；写后中断时保留原运行 ID，在没有其他活动任务时停止并重启同一数据目录的服务，刷新页面后恢复原运行。不要重新创建任务替代恢复。

原始产物位于被忽略的 `.agent-data/web-llm-live-20261022/`，可以直接复核：

- `summary.json`：五个任务的状态、模型、用量、Schema 检查、验收及独立数据库计数。
- 各场景目录中的 `result.json`、`report.md`、`events.jsonl`、`external.json`。
- `denied-before-grant/`：未授权写入被拦截的零副作用快照。
- `crash-before-restart/` 与 `before-server-restart.json`：写后中断、旧工作线程及原始草稿。
- `restart-comparison.json`：进程身份、冻结快照、参数哈希、幂等键及恢复事件次序对比。
- `terminal-resume-checks.json`：五个终态任务的重复恢复拒绝与计数不变检查。
- `authorization-review.jpg`、`tampered-draft-review.jpg`、`recovered-real-model.jpg`：浏览器验收截图。

仅重新核对现有产物、不再调用模型：

```bash
python3 .agent-data/web-llm-live-20261022/collect.py --final
```

本轮结果覆盖固定模拟样本，说明现有权限、结构化输出校验、客观验收和失败恢复在这些真实模型执行路径中有效，不代表开放任务成功率或自然语言全部语义真实性。业务主体和授权仍是本机开发模拟。CLI 的结构化输出用法参考 [OpenAI 官方文档](https://learn.chatgpt.com/docs/non-interactive-mode)。
