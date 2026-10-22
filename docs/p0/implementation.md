# P0A / P0B 实施与验证

2026-10-22。范围是“变更评估并创建草稿”现有样板及模拟业务系统；本轮没有调用真实模型或真实业务工具。

## 已落地

P0A：`AgentRegistry` 新增结构化 `definition`，身份、职责及交付物/验收映射、标准、知识空间引用、Skill、能力、策略与运行时绑定由 `AgentCompiler` 解析。新任务提交时编译并冻结 `CompiledAgent`；内置岗位同样走编译器。编译输出按租户和内容哈希保存，任务快照也保存完整副本。修改 Agent 不会覆盖历史运行。

首个 `change-assessment@2.0.0` DomainPack 包含原来的方法、产物 Schema、四个能力及三项验收。确定性规划样例与验收器已移至 `agent_framework/domains/`，旧导入路径继续可用。当前发布的 Skill 需要全部四个能力；移除依赖、未知引用、无验收职责或未登记适配器都会使编译失败。内联 Skill 冻结为 `instructions-only`，不获得脚本执行权限。知识空间在 P0 时仅注册模拟上下文引用；后续知识检索、私有记忆和经验治理已实现，见 [助理框架实施与验收](../assistant/implementation.md)。

P0B：四个 `CapabilityDefinition` 统一登记 Schema、PERCEIVE/EXECUTE/VERIFY 阶段、READ/WRITE 效果、资源解析、适配器、超时、凭据范围、幂等、前置条件、核对、验收与策略引用。未知效果和未登记能力拒绝执行。模拟 Tool、CLI、MCP 三种适配方式均由同一 Gateway 准备意图、检查参数/授权并分发；CLI 只使用受信 argv 构造器，MCP 是本地模拟 JSON-RPC 适配器，不接入任意上游服务。

写入仍以 PREPARED → 执行前授权 → DISPATCHED → 外部效果 → 观察/核对 → 独立验收推进。新动作额外绑定能力契约哈希和适配器版本；模型不能提供命令、适配器或幂等键。授权在实际适配器调用前再次检查。当前 `capability_blocks` 按租户存储紧急禁用；禁用写能力不妨碍已发生写入的只读核对，禁用核对能力则转人工并禁止重建。

原生 MCP 只开放 `ReadCapabilityProxy`：通过 `definition.native_read_refs` 选择已登记 READ 能力，工具名为 `mcp__governed__change_read`、`standards_read`、`report_read`。代理复用 Gateway，校验当前任务资源、租约 owner/epoch、当前策略及共享步骤预算，独立保存 `native_reads` 审计和验证过的证据。短期随机作用域凭据不进入模型上下文、任务快照或审计；作用域在认知结束时撤销，崩溃后因租约失效而不可复用。模型服务登录态仍由 Codex/Cursor CLI 管理。

## 兼容策略

- 缺少 `schema_version: 2` / `compiled_agent` 的任务按历史 v1 桥接解释；不补写定义、不重算快照或动作参数哈希，不改变逻辑动作 ID、`report_revision` 和幂等键。
- 恢复优先处理已有 PREPARED 以及 DISPATCHED/UNKNOWN/RECONCILING 写动作；不会让模型重提在途写入。历史 Agent Prompt v1/v2/v3、模型配置及 Schema 描述符仍可精确还原。
- 当前主体授权、撤销及能力禁用实时检查，不随快照永久冻结。
- 历史任意 MCP 直连配置保留供查看/编辑，但不会因旧白名单自动取得 READ 分类。新编译拒绝启用的直连；旧任务若需要再次调用未分类原生 MCP，暂停为 NEEDS_REVIEW。已经登记的业务写入仍先核对，不会重复创建。需要继续原生读取时应关闭旧直连，发布新 Agent 修订并绑定受控读取能力；不改写旧任务。
- 新快照会核对领域实现、能力 Schema 与适配器摘要；不兼容的漂移转人工。后续升级需保留被引用的已发布版本，不能用相同版本号替换实现。

## 运行与检查

```bash
# 工作台；进入 Agent → 编辑“岗位定义与能力绑定”→ 保存 → 检查编译
python3 -m agent_framework serve --port 8787

# 全部单元与 HTTP 集成测试
python3 -m unittest discover -s tests -q

# P0 等价回归：旧快照 11 个场景 + 新版三种适配器各 11 个场景
python3 -m agent_framework.p0_evaluate --output .agent-data/p0-review

# 单独观察正常、丢回执流程（默认使用新版编译快照与模拟模型）
python3 -m agent_framework --data-dir .agent-data/p0-normal demo --scenario normal
python3 -m agent_framework --data-dir .agent-data/p0-lost demo --scenario response-lost
```

矩阵的 `crash-after-write` 使用两个独立 Python 进程：首个进程在写入成功但未保存回执时退出 75，租约到期后第二个进程执行 CLI `resume`。它比较重启前后快照与动作的 `logical_id`、`args`、`args_hash`，并验证创建次数与草稿数。输出目录包含每例数据库、报告、完整动作、事件及汇总，保留用于回放。

| 关键场景 | 旧快照及新版三适配器共同预期 |
| --- | --- |
| 正常 | SUCCEEDED，三项验收通过，1 次创建 / 1 份草稿 |
| 写入成功但回执丢失 | SUCCEEDED，原键回读，1 次创建 / 1 份草稿 |
| 写入后进程退出再恢复 | SUCCEEDED，冻结身份不变，1 次创建 / 1 份草稿 |
| 无写授权 | WAITING_AUTH，0 次创建 / 0 份草稿 |
| 草稿被篡改 | NEEDS_REVIEW，验收拒绝，1 份草稿保留 |
| 无法核对外部效果 | NEEDS_REVIEW，禁止重建，1 次创建 / 1 份草稿 |
| 来源版本已变 | 旧版本写入被条件检查拒绝，刷新后创建；2 次调用 / 1 份草稿 |

新增 API：`POST /api/agents/{id}/compile`（`{"revision":当前修订}`，仍需工作台 CSRF 令牌），以及只读 `/api/capabilities`、`/api/skills`、`/api/standards`、`/api/domain-packs`、`/api/agent-definition-default`。编译成功只表示依赖可执行，不授予业务写权限。

本轮测试覆盖未知/缺失引用、职责验收映射、能力/Schema 漂移、原生写入拒绝、跨资源读取拒绝、租约替换、预算耗尽、当前禁用和授权撤销、旧 Prompt 版本恢复、已持久化提案恢复，以及三协议的等价故障矩阵。结果见 [verification.json](verification.json)。这验证的是固定模拟故障集，不代表任意外部工具或真实 IAM 已接入。

Codex 配置装配保留官方定义的 stdio MCP 与 `enabled_tools` 白名单方式，只把受控代理交给 CLI，参考 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)。

## 本轮执行结果

最终完整测试 **103/103**、故障矩阵 **44/44** 通过。额外只读核验本机 **23** 份历史运行：快照摘要全部有效，模型规划器描述符全部按原版还原。UI 任务 `run-3d23dadcfbac4dba` 使用新编译岗位完成响应丢失恢复，三项验收通过，创建调用 1 次且只有 1 份草稿。

[岗位编译截图](compile.jpg) · [验收与草稿统计截图](result.jpg) · [完整验证记录](verification.json)
