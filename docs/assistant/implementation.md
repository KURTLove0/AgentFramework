# 知识、记忆、经验与岗位驱动的助理框架

2026-10-22。框架在本机、test 环境和模拟业务边界内运行；可选择确定性认知或本机 Codex/Cursor CLI 模型。它现在以完整任务契约工作：受理目标，按岗位和标准组织资料，规划动作，受控执行，独立验收，恢复故障，归档事实并生成待审核经验。

## 已连接的对象

| 对象 | 实际行为 | 实现 |
| --- | --- | --- |
| 知识 | 按版本保存内容、来源、有效期、摘要和范围；草稿→审核→发布→撤回；FTS5 检索前后都检查租户、项目、环境及私有所有者 | `knowledge.py` |
| 工作记忆 | 保留原始任务、计划、精确动作、未决写入、证据和检查点；不靠模型摘要恢复 | `store.py` / `runtime.py` |
| 私有偏好 | 仅本人可检索；限定语言、报告风格和标题前缀；同属性采用最新有效的本人已发布偏好 | `knowledge.py` / `context_builder.py` |
| 情节记忆 | 终态检查点事务归档任务结果、证据与动作引用；同租户/项目/环境/主体的后续相关任务可召回 | `memory.py` |
| 经验 | 终态运行生成带条件、支持情节、局限的候选；候选不可用于认知；隔离模拟回放与反例评测→明确审核发布→撤回 | `experience.py` |
| 能力 | 六项正式效果契约，固定输入、效果、阶段、适配器、资源、超时、核对与验收；UNKNOWN 拒绝执行 | `definitions.py` / `gateway.py` |
| 岗位 Agent | 统一编译身份、职责、交付物、标准、知识空间、Skill、能力及模型；任务保存不可变快照 | `agents.py` / `definitions.py` |
| 认知 | 确定性演示或真实 CLI 模型生成结构化计划、动作提案和产物；认知不取得业务写权限 | `planner.py` / `llm.py` |
| 动作 | Skill 组织方法；Tool/CLI/MCP 模拟适配器受同一 Gateway 管理；原生 MCP 仅经任务作用域读取代理 | `adapters.py` / `read_proxy.py` |
| 标准与验收 | 报告事实、风险、草稿读回或问答逐字引用、来源范围、当前发布/时效/摘要，由可信代码独立判定 | `domains/` |

这些对象进入真实执行链，而不是只保存配置。模拟报告会引用所选知识版本，按本人偏好呈现；已审核经验进入后续计划和上下文。知识、记忆和经验始终是数据，不能授予能力、提高预算或覆盖验收。

## 两个领域包

`change-assessment@2.0.0`：感知变更和标准，生成带事实证据的报告，在当前授权范围内创建草稿，独立回读后确认完成。保持 P0 的四工具、三项验收及幂等恢复语义。

`knowledge-answer@1.0.0`：只提供 `knowledge.search@1.0.0` 和 `knowledge.read@1.0.0`，没有写能力。回答是带版本、证据 ID 和内容摘要的原文摘录；独立检查引用与回答一致、来源属于任务范围、当前仍已发布且有效。无相关资料时请求补充，伪造引文或提前宣称完成均不能成功。业务模拟库的工具调用及草稿数保持为零。

领域注册提供方法、Schema、验证器、能力闭包、模拟规划器及刷新范围，共用同一持久化、授权和恢复内核。状态中的 `report` 字段保留兼容名称，在只读领域承载问答产物。

## 上下文与失效处理

新任务冻结 `context_policy`，每轮认知先按当前主体与岗位知识空间构建上下文。必需标准固定具体版本及摘要；可选知识与偏好按词项相关性召回，按内容去重和字节预算裁减，再加入适用的已发布经验、同主体的相关情节。

每轮保存 `ContextManifest`，记录资料引用、版本、摘要、来源、选用/排除原因和预算。未发布、过期、撤回、同级冲突、摘要不符、重复和预算裁减均有明确结果。未授权资料在查询前过滤，不把其标题、正文或引用写进模型清单。约束、原始动作和必需证据不会为节省上下文而被裁掉。撤回后的知识读取正文仍保留在精确审计中，但在重新规划的模型证据及旧计划上下文中排除，不会因恢复旧工作记忆而再次发送。

关键标准失效或冲突时停止认知；执行已准备写入前再次检查。知识问答在每次后续认知前检查已读来源，完成时再独立检查。已经派发的写入仍先核对外部效果，不能因知识撤回再次创建。

补充资料后显式恢复：无在途/固定意图时，有限重规划刷新领域读取，使用新的读取修订；已持久化动作参数和原逻辑身份不变。有 PREPARED 或未决副作用时继续原有恢复顺序。等待人工仍受原任务总期限和预算约束，超限不会静默延长或切换模拟规划器。

## 经验评测与发布

经验采用受信模板生成候选，附所属领域、支持运行与局限，不自动重写 Skill 或策略。变更领域评测包含正常、丢回执、无法核对、草稿篡改和拒绝授权；只读领域包含正常引用、伪造回答和无证据完成。回放使用临时独立模拟库，不重放历史写入、不调用真实模型。评测还重新检查来源情节及冻结证据。

发布必须由审核角色明确操作，并绑定当前候选摘要、领域实现摘要和最新成功评测。候选、失败/过期评测或旧成功结果不能绕过最新检查。撤回立即影响后续检索。当前用户偏好、情节和经验默认私有，不因共用一个 Agent 被其他主体召回。

## 运行命令

```bash
# 本机技术工作台
python3 -m agent_framework serve --port 8787

# 完整助理闭环：知识→岗位→动作→情节→经验评测→发布→后续召回/撤回
python3 -m agent_framework.assistant_evaluate

# 原有旧快照 + 新版三协议，共 44 个故障用例
python3 -m agent_framework.p0_evaluate

# 独立只读问答；结果保存并可导出引用
python3 -m agent_framework --domain knowledge-answer@1.0.0 \
  --goal '变更评估的风险规则是什么？' demo --export .agent-data/answer-export

# 全部自动测试
python3 -m unittest discover -s tests -q
```

知识 CLI：

```bash
python3 -m agent_framework.library_cli --data-dir .agent-data seed
python3 -m agent_framework.library_cli --data-dir .agent-data search '草稿验收'
python3 -m agent_framework.library_cli --data-dir .agent-data episodes
python3 -m agent_framework.library_cli --data-dir .agent-data experiences
# 管理操作使用本地受信身份，真实生产须替换为身份服务提供的权限
python3 -m agent_framework.library_cli --role curator create path/to/asset.json
python3 -m agent_framework.library_cli --role curator review ASSET_ID@1
python3 -m agent_framework.library_cli --role curator publish ASSET_ID@1
python3 -m agent_framework.library_cli --role reviewer evaluate EXPERIENCE_REF
python3 -m agent_framework.library_cli --role reviewer publish EXPERIENCE_REF --evaluation-id EVALUATION_ID
```

`asset.json` 示例：

```json
{"kind":"KNOWLEDGE","title":"模拟检查清单","content":{"text":"先核对测试、依赖和回滚；草稿写入后独立回读。"},"source_uri":"synthetic:checklist","source_version":"1"}
```

创建新修订可传原 `id` 与 `supersedes: "原ID@原版本"`，不会修改已发布正文。偏好使用 `kind: "PREFERENCE"`，内容限定 `language`、`report_style`、`report_title_prefix`，只能私有发布。

## 工作台与接口

“知识与记忆”页可新增资料、提交审核、发布/撤回，查看私有情节及经验候选，执行离线评测并明确发布经验。新任务可选择变更评估或只读问答；运行详情的“证据与验收”展示上下文来源清单。Agent 编辑器和能力页展示真实编译和效果契约。

新增接口都沿用本机 Host/Origin/CSRF 检查，主体和角色不接受模型/请求 JSON 自报：

- `GET /api/library`、`POST /api/knowledge/search`、`POST /api/knowledge/assets`。
- `POST /api/knowledge/assets/{ref}/review|publish|withdraw`。
- `GET /api/memory`、`GET /api/experiences`。
- `POST /api/experiences/{ref}/evaluate|publish`，`GET /api/experiences/{ref}/evaluations`。
- `GET /api/runs/{id}/context-manifests`，仅返回当前主体的运行清单。新上下文任务的列表、详情、导出和操作也按同一主体隔离。

工作台默认使用明确标注的本地模拟身份 `demo-user`；查看 CLI 默认 `kurt` 的私有任务可用 `serve --principal kurt` 选择受信本地身份，不能在 HTTP JSON 中切换主体。CLI 的租户/主体/角色是受信开发输入，尚非生产 IAM。业务工具仍模拟；没有连接真实业务平台或自动发布外部变更。FTS5 使用英文词项和中文双字片段，当前没有向量库或语义召回质量保证。

真实模型会接收任务、范围内所选资料/偏好/情节/已发布经验、证据和 Schema。工作台发送许可已覆盖这些对象；目前仅应使用获准的模拟上下文。模型登录凭据由本机 CLI 管理，不进入这些上下文。

## 兼容与证据

缺少 `context_policy` 的历史任务不会被补写新上下文；原快照、动作参数、参数哈希、逻辑 ID 与幂等键保留。未接入新上下文的历史记录保持原租户工作台查看策略；新上下文任务按主体收紧查看和操作。当前授权和紧急禁用仍实时检查；未分类的旧 MCP 直连继续拒绝。

验证结果、真实模型成功/诊断记录、UI 任务及要求逐项审计见 [verification.json](verification.json) 和 [completion-audit.md](completion-audit.md)。

2026-10-22 最终验证：136 项自动测试、44 个 P0 故障/授权用例、14 个助理闭环用例全部通过。真实 Codex 只读问答 6 次调用完成，三项验收通过，业务调用和草稿数均为零。23 个历史快照及全部 27 个主库快照可校验并还原；工作台的已发布经验复用任务在丢回执后仍仅创建一份草稿。

已运行的工作台可直接打开：

- [主工作台及经验复用任务](http://127.0.0.1:8787/#/workbench/run-b20040b18bcb4087)。
- [真实 Codex 只读问答验收](http://127.0.0.1:8788/#/workbench/run-02e2985e79784959)。重开此结果服务：`python3 -m agent_framework --data-dir .agent-data/p1-live-qa-v3 serve --port 8788`。

查看已保存结果无需重新请求模型。重新创建真实模型任务时，在 Web UI 选择 Codex CLI、所需领域及范围，并确认仅发送获准的模拟上下文。
