# CLI 模型目录与可配置 Agent

知识、私有记忆、受审经验和两个领域包的当前实现见 [助理框架](assistant/implementation.md)。

## 使用

```bash
python3 -m agent_framework serve --port 8787
```

打开[运行时配置](http://127.0.0.1:8787/#/runtimes)，从 Codex / Cursor CLI 返回的目录中选择模型。点击“基于此运行时创建 Agent”，填写名称、岗位定义、角色 Prompt 与 Skill 方法说明。也可进入[智能体 Agent](http://127.0.0.1:8787/#/agents)创建、编辑、复制、归档和恢复使用。

创建 Agent 只需填写名称与岗位角色，无需归属团队。创建流程分为基本信息、模型与指令、确认创建三步。处理领域可以在表单内新建，填写领域名称和用途，并选择资料问答或变更评估作为工作方式；自建领域保存在当前工作空间，支持后续复用。职责、标准和技能可在确认页展开调整。领域内容会进入智能体上下文和执行、评测快照。旧配置中的团队信息继续保留，已有任务沿用冻结快照。

新建任务选择 Agent 后，运行时与模型随配置绑定。模型上下文发送许可和 MCP 执行许可分别确认；保存 Agent 不启动 MCP 或模型调用。任务提交时冻结 Agent 版本，后续编辑或归档不改变已有任务的执行和恢复配置。默认运行时仍是模拟模式。

Skill 当前配置为具名、可启停的内联方法说明，随 Prompt 进入规划上下文；本版不提供 Skill 包安装与脚本执行。固定任务范围、业务工具白名单、授权和结果验收保持独立。

## 模型目录

| 运行时 | 原生发现方式 | 选择行为 |
| --- | --- | --- |
| Codex | `codex app-server --stdio` → `initialize` → `initialized` → `model/list`，处理分页 | 使用 CLI 返回的具体模型和推理强度 |
| Cursor | `cursor-agent models` | 解析具体模型 ID，排除 `auto` / `default` |
| 模拟 | 内置确定性规划器 | 不请求模型服务 |

发现操作不会创建推理线程或执行任务。目录按租户持久化，缓存 5 分钟，可手动刷新；CLI 失败会显示错误并保留旧缓存，不用静态列表冒充新结果。模型目录不保证账号具有实际推理权限，执行失败不会切换其他运行时。保存 Agent 时再次校验模型属于该 CLI 目录，Codex 推理强度也必须匹配模型支持的选项。

## 岗位编译与 MCP

P0A/P0B 已启用，详见 [实施与兼容策略](p0/implementation.md)。编辑“岗位定义与能力绑定”，保存后点击“检查编译”。身份、职责及交付物、标准、Skill、能力、策略与运行时一并冻结到新任务；编译不授予写权限。

新任务仅允许已登记 READ 能力经 `ReadCapabilityProxy` 暴露给模型。例如在已有岗位定义中设置：

```json
"native_read_refs": ["change.read@1.0.0", "standards.read@1.0.0"]
```

工具名为 `mcp__governed__change_read` 和 `mcp__governed__standards_read`。它们复用 Gateway，校验任务资源、当前策略、租约、预算，并保存审计与证据。选择真实模型时仍分别确认上下文发送与 MCP 调用许可。原生写入和 UNKNOWN 效果拒绝执行；业务写入只接受结构化动作提案。

旧 stdio / HTTP 字段保留供迁移和导出，启用未登记效果的直连会阻止新编译。旧任务 Prompt/模型快照保持原样，业务 PREPARED/UNKNOWN 仍按原参数和幂等键恢复；若需要再次调用未分类原生 MCP，则转 NEEDS_REVIEW，不能恢复旧的权限绕过通道。下文真实模型记录是此前 v3 实现的历史证据，不表示当前版本仍允许直连 `facts.lookup`。

## API 与版本

| 接口 | 行为 |
| --- | --- |
| `GET /api/runtime-config/models?provider=codex&refresh=1` | 获取 / 刷新 CLI 模型目录 |
| `GET /api/agents` | 当前租户的 Agent 配置 |
| `POST /api/agents` | 创建，`revision: 0` |
| `GET /api/agents/{id}` | 读取配置 |
| `POST /api/agents/{id}/compile` | 使用当前 `revision` 编译并返回不可变快照 |
| `POST /api/agents/{id}` | 使用当前 `revision` 编辑；冲突返回 409 |
| `POST /api/agents/{id}/archive` | 使用 `revision` 和 `archived` 归档或恢复使用 |
| `POST /api/runs` | 可传 `agent_id`、`agent_revision`；真实模型需 `consent`，启用 MCP 需 `mcp_consent` |

写接口沿用页面 CSRF 令牌、Host / Origin 校验与 JSON 请求限制。Agent 按租户隔离，归档配置不能用于新任务。任务引用形如 `agent-xxxxxxxxxxxxxxxx@3`，持久化完整 Agent 配置、模型、提示词协议和 Schema 摘要。

自定义 Agent 的提示词协议单独版本化：旧版本快照可以原样还原。v4 协议只允许受控原生读取；有副作用的能力统一通过业务 `ActionProposal` 提案。

## 验证

前一轮 84 项自动测试通过；本轮 P0 103 项测试和 44 个故障用例通过（见 P0 验证记录）。前轮测试，覆盖 CLI 目录缓存 / 分页 / 失败、Agent CRUD / 租户隔离 / 版本冲突、Prompt 与启用 Skill 注入、MCP 白名单、stdio 协议、HTTP 环境变量引用、旧提示词快照兼容，以及自定义 Agent 的授权、验收和恢复。

页面已验证从运行时创建 Codex Agent、复制并选择 Cursor CLI 的模型、编辑、归档和恢复使用。320px 页面和弹窗无横向溢出，768px 页面也无横向溢出。

真实模型仅使用本机 Codex 登录态和模拟上下文。Cursor 已验证模型目录、配置保存和受限传输协议回归，本轮没有发送真实推理请求到 Cursor 模型服务。

2026-10-22 的正式工作台验收如下：

| 项目 | 当前证据 |
| --- | --- |
| CLI 模型目录 | 保存的原生目录为 Codex 7 个、Cursor 264 个；数量随 CLI 目录变化 |
| Prompt 生效 | 最终报告标题以 Agent 配置的“配置新版：”开头 |
| Skill 生效 | 报告 `limitations` 包含启用 Skill 要求的“Skill新版：仅供人工审核” |
| MCP 实际执行 | `model.responded.mcp_calls` 和模拟服务日志均记录 `facts.lookup`；初始计划含返回的 `SYNTHETIC-FACTS-V1` |
| 完整执行与恢复 | [Agent v3 正式运行](http://127.0.0.1:8787/#/workbench/run-ccf8ae5b94af48b0)：7 次真实模型调用，SUCCEEDED，3/3 验收，响应丢失后自动核对，1 次创建 / 1 份草稿 |
| 编辑后恢复旧任务 | [冻结的 Agent v1 运行](http://127.0.0.1:8787/#/workbench/run-bb7abfdcfc214e92)：编辑到 v2 后恢复写后中断，仍使用 v1 Prompt / Skill，SUCCEEDED，1 次创建 / 1 份草稿 |

联调初期发现模型只把 MCP 调用写进计划，未实际执行。该诊断记录已保留；正式验收使用了明确区分原生 MCP 与业务提案的提示词协议 v3，并以原生调用事件和模拟服务日志作为成功依据。旧提示词协议 v1 / v2 的快照仍按原版本还原。

验收产物位于 `.agent-data/agent-config-review/`，运行 `python3 .agent-data/agent-config-review/check.py` 可离线重新核对已完成任务，不再请求模型。

原生参数依据 [Codex MCP 官方文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，CLI 目录和实际行为同时通过本机命令与页面验证。
