# Agent Framework

当前发行版本 **1.2.0**。独立安装包及启动方式见 [发行版安装说明](docs/release/INSTALL.md)，功能范围见 [发布说明](docs/release/RELEASE_NOTES.md)。业务工具仍为模拟实现；初始工作台不附带演示数据。

从当前源码生成不含本机数据的发行包（在已安装项目依赖的虚拟环境中执行）：

```sh
python -m pip install 'setuptools>=68' wheel
python scripts/build_release.py
```

输出 `dist/agent-framework-1.2.0.tar.gz`、独立 wheel 和 SHA256 校验文件。构建会逐文件核对代码和资源，包含三步任务创建、配置往返、可直接操作的工作流画布及浅色/深色界面。解压后执行 `sh scripts/install.sh`、`sh scripts/start.sh` 即可启动干净工作台；原有源码和开发测试命令继续可用。

基于「设计可落地的 Agent 框架」会话的技术方案，实现一个可恢复的 **规划 → 执行 → 验证 → 恢复** 闭环。样板任务：读取变更与规范、评估风险、生成报告、创建评估草稿、外部回读验收。

Python **3.11+**，核心执行器使用标准库；标准 Skill YAML 解析使用 PyYAML。默认模式无需 API Key、网络或额外服务，使用确定性规划器；可选真实模型模式复用本机 Codex CLI 的 ChatGPT 登录态。业务工具始终为模拟实现；状态机、持久化、子进程、授权检查、幂等、回读与故障恢复是真实代码。

基于“知识、记忆、经验、能力 → 岗位 Agent → 感知、执行、验证”的下一轮优化，见 [Agent 框架优化方案](docs/optimization/proposal.md)，附目标架构与可运行设计契约样例。

## 助理闭环已接通

新增**岗位评测契约与业务本体模型**：按 Agent 的冻结身份、职责交付物、标准及可配置权重评分，核对证据完整性和能力边界；本体支持 Agent 抽取、对象类型/实例、关系基数、约束报告、能力映射核对、来源路径检索及带 SHACL/PROV 的 JSON-LD 导出。详见 [岗位评测与 Ontology 优化](docs/ontology-v2/implementation.md)。

新增**每日任务与岗位评测**：工作空间可按时区和每日时间汇总待办、按模板派发指定版本的 Agent 任务，支持待启动或自动运行、同日去重和中断恢复。任务终态按冻结身份、职责及标准自动评分，低分或基础验收失败时产生站内提醒；支持历史补评、阈值配置与确认追溯。详见 [每日任务与岗位评测](docs/operations/implementation.md)。此轮为源码更新，现有发行包需另行升级构建。

当前源码新增**运行复盘与本体 Ontology**：调用所选 Agent 总结运行，经审阅沉淀为知识、工作记忆、经验和能力方法；本体支持概念/属性/关系编辑、来源校验、审核发布、检索扩展及 JSON-LD 导出。详见 [复盘与领域本体](docs/learning/implementation.md)。此轮源码更新尚未重建 1.2.0 发行包。

新增**四模块知识库和 Agent 工作流**：知识修订与审计、私有记忆、经验评测发布、能力使用岗位统一管理；工作流节点全部由 Agent 实现，支持对话生成提案、审查保存、依赖执行、上游产物传递、节点授权及持久化恢复。见 [知识库与工作流使用及验收](docs/workflows/implementation.md)。

工作流现支持**可视化画布、端口连线、条件分支与汇合、RAG 检索模板**。查询词和 Top K 会实际约束检索，未选分支不创建任务，保留旧任务恢复兼容。见 [画布、分支与 RAG 使用及验收](docs/workflow-designer/implementation.md)。

任务创建现分为目标、执行配置和授权确认三步；跳转配置后可保留草稿返回。Agent、Skills、资料与工作空间提供明确的保存后入口，工作流支持拖动、平移、缩放和手机属性面板。使用边界与验收证据见 [交互与操作动线](docs/interactions/implementation.md)。

新增独立 **Skills 管理模块**：支持标准 `SKILL.md`、资源文件、ZIP 导入导出、版本发布与撤回、Agent 固定版本选择，以及目录 → 正文 → 资源的逐级加载。旧内联方法可迁移为标准包，历史任务继续使用冻结版本。见 [Agent Skills 使用与验收](docs/skills/implementation.md)。

工作台现已支持**工作空间创建、编辑、删除/恢复与切换**，按业务和场景分别管理 Agent、任务、知识与记忆。Agent 的**身份、职责、交付物和执行标准**可直接在表单中编辑，任务继续冻结岗位版本并独立授权、验收和恢复。使用说明与本次验证见 [岗位与工作空间](docs/workspaces/implementation.md)。

知识版本与受控检索、本人偏好、终态情节、经验候选→离线评测→明确发布/撤回，现在都接入了岗位编译与实际任务。支持“变更评估并创建草稿”和“只读知识问答”两个领域包。工作台新增“知识与记忆”和运行上下文来源清单。

```bash
python3 -m agent_framework serve --port 8787
python3 -m agent_framework.assistant_evaluate
python3 -m agent_framework --domain knowledge-answer@1.0.0 --goal '变更评估的风险规则是什么？' demo
```

完整说明、资料 CLI、兼容策略和验证证据见 [助理框架实施与验收](docs/assistant/implementation.md)。

## 开发演示与回归

正式工作台请使用上方安装包。以下为开发演示，会主动创建模拟任务；在项目根目录创建并启用虚拟环境：

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -e .
python3 -m agent_framework --data-dir /tmp/agent-framework-demo demo --export /tmp/agent-framework-demo/export
```

正常结果为 `SUCCEEDED`，报告风险 `HIGH`，三个验收项全部通过。模拟变更有 1 项失败测试，因此生成的草稿建议修复并复核；任务成功代表**完成评估并创建草稿**，不代表变更可以发布。

导出目录包含 `report.md`、`result.json` 和逐事件 `events.jsonl`。默认数据目录 `.agent-data` 包含两个独立 SQLite 数据库：`runtime.sqlite3` 保存运行事实，`mock-business.sqlite3` 模拟外部业务系统。

```bash
# 指定任务契约；修改 configs/task.example.json 可调整输入和预算
python3 -m agent_framework demo --task configs/task.example.json

# 跑测试，包括进程退出后由新进程恢复
python3 -m unittest discover -s tests -v

# 一次运行全部 11 个故障场景，输出各场景证据与汇总
python3 -m agent_framework.evaluate
```

`pip install -e .` 同时安装 PyYAML 和 `agent-mvp` 入口；构建安装使用 setuptools。离线业务执行不需要模型服务。

## 真实大模型规划器

本机先安装并登录 Codex CLI；本适配器支持 OpenAI 提供方的 ChatGPT 登录态，无需复制 API Key。模型服务会接收本次任务、角色/Skill、模拟工具证据与输出 Schema。

```bash
codex login status

# 模型和 reasoning effort 默认读取本机 Codex 的对应配置并冻结到本次运行
python3 -m agent_framework --planner codex demo \
  --task configs/task.llm.example.json --export .agent-data/llm-export

# 正常、响应丢失、写后退出恢复、权限不足、外部内容篡改的真实模型评测
python3 -m agent_framework.evaluate --planner codex \
  --scenario normal --scenario response-lost --scenario crash-after-write \
  --scenario denied --scenario tampered-draft

# 恢复自动加载冻结的模型/提示词/Schema，不必再次指定 --planner
python3 -m agent_framework --data-dir .agent-data resume run-xxx
```

可显式传入全局选项 `--model`、`--reasoning-effort`、`--model-timeout`（默认 60 秒）及 `--model-attempts`（默认 2 次，限 JSON/Schema 修正）。新的真实模型 demo 默认任务期限为 600 秒，显式任务文件的期限保持不变；可通过 demo/submit 的 `--max-wall-seconds` 调整。TaskContract 预算增加 `max_model_calls`（默认 24）和 `max_model_tokens`（默认 200000）。token 上限在模型响应后检查，不能撤销已经发生的模型用量；不是计费金额上限。

模型分别生成结构化计划、单步 `Decision/ActionProposal` 和带证据引用的报告。每个输出先经过封闭 JSON Schema 的本地校验，禁止多余字段、重复 JSON 键和非法值；格式错误可有限修正。内容越权仍由网关拒绝，事实引用与风险规则仍由独立验收器判定。模型错误、超时或拒答不会静默切回模拟规划器。

推理在独立临时目录中以 read-only 模式运行，忽略用户工具配置，并禁用 shell、Apps、插件、hooks、浏览器及多 Agent 等工具能力。业务动作只能提案，不能直接调用模拟业务工具；自定义 Agent 可显式启用已登记 READ 能力的 MCP 受控代理。模型上下文排除本地路径、故障注入设置、授权记录与凭据。角色、Skill、任务、工具观察及当前范围内选中的知识、本人偏好/情节和已发布经验会发送给模型服务；不应在任务中放入未经授权发送的信息。

运行时在长推理期间续租；已有 PREPARED 动作恢复后直接重新授权和分发，未决写入先核对，不依赖模型再次判断。外部回读完成后立即执行客观校验；内容不一致直接进入 NEEDS_REVIEW，模型无法通过“请求输入”延后这一校验。模型/提示词/Schema 与快照不一致时拒绝继续。事件中记录模型调用数、用量、阶段、输出摘要和被拒原因；完整动作提案随 `decision.proposed` 保存。正文表述的事实一致性并非全部由当前规则覆盖，验收主要检查结构化事实、风险判定和草稿读回。

## 观察和恢复

每次 `demo`、`submit` 都会先输出 `run_id=...`。以下命令中的 `run-xxx` 替换为该值；不同命令需使用同一 `--data-dir`、`--tenant`。

```bash
# 创建契约但暂不执行
python3 -m agent_framework submit
python3 -m agent_framework resume run-xxx

# 状态、完整契约/计划/证据/动作、审计、外部系统调用统计
python3 -m agent_framework show run-xxx
python3 -m agent_framework show run-xxx --full
python3 -m agent_framework events run-xxx
python3 -m agent_framework stats run-xxx
python3 -m agent_framework export run-xxx .agent-data/export

# 每完成一个工具动作就暂停，可用另一个进程继续
python3 -m agent_framework demo --pause-after 1
python3 -m agent_framework resume run-xxx
```

**响应丢失**：目标已提交，但调用方未得到回执。任务进入 `UNKNOWN → RECONCILING`，按原幂等键查询已存在草稿，补记结果，继续独立验收。创建调用次数仍为 1。

```bash
python3 -m agent_framework demo --scenario response-lost
```

**写后进程退出**：模拟工具提交成功，主进程在持久化回执前以 75 退出，数据库保留 `DISPATCHED` 与未过期租约。租约过期后，在新进程中恢复。默认租约 10 秒；可用下面配置缩短演示等待时间：

```bash
python3 -m agent_framework --data-dir .agent-data/recovery --lease-seconds 1 --tool-timeout 0.3 demo --scenario crash-after-write
# 等待至少 1 秒，将上一步输出的运行 ID 代入
python3 -m agent_framework --data-dir .agent-data/recovery resume run-xxx
python3 -m agent_framework --data-dir .agent-data/recovery stats run-xxx
```

恢复时先查询外部系统，不再调用 create。过期 worker 的检查点写入会被租约代数与状态版本拒绝。若读回也一直不可用，任务进入 `NEEDS_REVIEW`，列出未决动作及幂等键，禁止盲目重试写入。

## 授权与取消

默认 demo 显式签发本次模拟任务、指定主体、租户、项目和 test 环境的草稿创建授权。执行时再次校验，动作授权回执绑定工具版本、规范化参数哈希、资源和有效期。

```bash
python3 -m agent_framework demo --scenario denied
# 输出 WAITING_AUTH；先查看完整待执行参数和报告
python3 -m agent_framework show run-xxx --full
# 本地开发者签发覆盖该具体参数摘要的模拟授权，再继续
python3 -m agent_framework grant run-xxx
python3 -m agent_framework resume run-xxx

python3 -m agent_framework revoke run-xxx
python3 -m agent_framework cancel run-xxx
```

取消停止后续动作；对在途写入先核对，无法判断则保留 `NEEDS_REVIEW`。已存在草稿保留并在 `residual_effects` 中列出，不自动删除或声称已回滚。租约仍被其他 worker 持有时拒绝同时取消。

## 故障矩阵

所有故障按 run 隔离；测试和评测为各场景使用独立临时目录。

| `--scenario` | 行为 | 预期终态 | 外部草稿数 |
|---|---|---|---:|
| `normal` | 正常全流程 | SUCCEEDED | 1 |
| `read-transient` | 第一次读失败，有限退避重试 | SUCCEEDED | 1 |
| `read-fails` | 读服务持续失败，重试耗尽 | FAILED | 0 |
| `response-lost` | 写入已生效，回执丢失，按键核对 | SUCCEEDED | 1 |
| `crash-after-write` | 写入后进程退出，新进程恢复 | SUCCEEDED（恢复后） | 1 |
| `unverifiable` | 写入回执丢失且无法查询 | NEEDS_REVIEW | 1（运行时无法确认） |
| `tampered-draft` | 外部保存内容与报告不一致 | NEEDS_REVIEW | 1 |
| `invalid-report` | 首次报告缺少章节，重规划修复 | SUCCEEDED | 1 |
| `denied` | 无草稿创建授权 | WAITING_AUTH | 0 |
| `source-changed` | 条件写发现版本变化，刷新并重评 | SUCCEEDED | 1 |
| `missing-evidence` | 缺少测试证据 | WAITING_INPUT | 0 |

`source-changed` 有 2 次创建调用：第一次条件检查拒绝、没有草稿，第二次以新来源版本创建。响应丢失和进程恢复场景均只有 1 次创建调用。测试另外覆盖“权威查询确认未写入后允许重试”、越权工具、跨租户读取、授权撤销、错误参数摘要、提前申请完成、预算耗尽和取消。

退出码：0 为已成功、正常查询或演示暂停；2 为未成功完成（含等待）；1 为参数/租约等操作错误；75 为故障注入退出。

## 模块和契约

| 模块 | 职责 |
|---|---|
| `contracts.py` | 历史 AgentSpec、TaskContract、ActionProposal、Decision、Planner 端口、预算 |
| `resources/` | 已发布角色、Skill 方法与结构化能力清单；运行时冻结版本和摘要 |
| `planner.py` | 基于观察、缺口和规则生成计划与下一步；可替换的确定性规划器 |
| `llm.py` / `structured.py` | Codex/Cursor CLI 真实模型适配器、封闭输出 Schema、本地校验、有界格式修正 |
| `runtime_config.py` / `web.py` | 租户运行时配置、版本检查、CLI 检测及 Web API |
| `model_catalog.py` / `agents.py` | CLI 模型发现、租户 Agent 配置与任务版本绑定 |
| `agent_extensions.py` | 序列化由运行时提供的受控代理配置与工具白名单 |
| `runtime.py` | 显式状态机、有界重规划/重试、检查点、恢复、完成与取消 |
| `gateway.py` | 工具白名单、参数校验、真实资源解析、执行时授权、固定子进程分发 |
| `store.py` | 租户隔离查询、CAS 版本、租约 fencing、事务性意图/outbox/事件 |
| `worker.py` / `mock_tools.py` | JSON 子进程适配器；独立持久化模拟目标与幂等约束 |
| `verifier.py` | 工具结构/范围验证、报告事实及规则验证、外部草稿回读与任务验收 |
| `evaluate.py` | 11 场景可重复评测与证据导出 |

任务验收固定为：`report-sections`、`critical-claims-evidence`、`draft-readback`。全部通过且无未决动作才可成功。证据保存来源、观察时间、对象版本及 SHA-256；经验仅保存为 `PENDING_REVIEW` 候选。

完整设计对应关系和扩展边界见 [docs/implementation.md](docs/implementation.md)。
真实模型联调结果、回归范围和修复记录见 [docs/llm-verification.md](docs/llm-verification.md)。

Web UI 中使用本机 Codex 登录态的五类真实模型验收，包括页面授权和服务进程重启恢复，见 [docs/web-llm-verification.md](docs/web-llm-verification.md)。
最新一轮的五场景复验、超时配置和重启前后证据见 [docs/web-llm-recheck.md](docs/web-llm-recheck.md)。

## 当前边界

这是单机、两个领域包的开发 MVP。SQLite 替代原方案中的 PostgreSQL；已提供 Codex/Cursor CLI 规划适配器、可编译岗位、MCP 受控读取和本机 Web API；尚无模型 HTTP API 适配器、真实 IAM、向量检索或真实业务平台接入。CLI 的 tenant/principal/grant 是本地可信开发输入，不是生产鉴权。业务工具子进程用于执行隔离和超时控制，不是 OS 安全沙箱。

模拟任务默认 120 秒、真实模型 demo 默认 600 秒，均为持久化的绝对期限，等待授权也不暂停；超过期限的任务需重新提交。`WAITING_INPUT` 目前提供证据缺口与人工处理入口，不支持在线补充材料；修复模拟来源后提交新任务。经验只支持保存候选，不提供晋升发布。预算覆盖步骤、重规划、每动作重试、模型调用/token、墙钟与工具超时；没有货币费用计量。

固定回归集通过只能说明这些模拟场景的结果，不能代表开放环境成功率或跨系统 exactly-once。目标工具仍必须提供幂等/条件写和可回读能力。

## 本机 Web 工作台

无需安装前端依赖，直接启动：

```bash
python3 -m agent_framework serve --port 8787
# 浏览器打开 http://127.0.0.1:8787

# 可使用独立演示目录；同一目录可被 CLI 查看与恢复
python3 -m agent_framework --data-dir .agent-data/web-demo serve --port 8788
```

工作台提供任务创建、运行搜索与筛选、结构化计划、审计轨迹、报告、证据及验收项、动作提案、授权与撤销、取消、恢复，以及 Markdown / JSON / JSONL 导出。顶部命令面板支持 `⌘K` / `Ctrl+K`。统计与草稿数量均读取当前租户的数据库，不预置演示指标。

新建任务可选择模拟运行时、**Codex CLI** 或 **Cursor CLI**；真实模型运行时使用对应 CLI 的登录态和已保存的模型配置，并要求勾选模拟上下文发送许可。任务说明也会发送给模型，请只填入获准的模拟信息。界面不接收 API Key，模型仍只能提出结构化计划与动作，所有业务调用继续经过现有网关与验收器。

建议按以下顺序演示：

1. **正常流程**：创建并运行，查看“已完成”、三个通过的验收项，以及外部业务库中 1 份草稿 / 1 次创建调用。
2. **写入响应丢失**：选择同名场景，运行自动核对已提交草稿，最终仍为 1 份草稿 / 1 次创建调用。
3. **写后进程中断**：选择同名场景，工作进程在写入后中断；Web 服务继续运行。约 3 秒租约结束后点击“恢复运行”，核对原草稿后完成。也可以先停止并重新启动同一数据目录的 Web 服务，从运行记录恢复同一 ID。不要新建任务代替恢复。
4. **缺少写入授权**：等待 `WAITING_AUTH`，点击“审查并授权”，查看绑定的项目、变更、参数哈希和工具参数，授权后继续。授权不会绕过范围、版本和验收检查。
5. **草稿内容不一致 / 无法核对写入**：查看 `NEEDS_REVIEW` 与原始证据；终态不提供继续写入。缺少材料的 `WAITING_INPUT` 需补充来源后创建新任务，本版不支持在线追加材料。

Web 服务仅支持 `127.0.0.1` 或 `localhost`，校验 Host / Origin，并要求同页面会话令牌和 JSON 请求才能写入；无跨域开放，也不适合作为共享公网服务。服务器固定一个租户，客户端不能更改租户或环境。最多 4 个工作线程、16 个排队/运行任务，同一运行由持久化租约排他执行。取消在当前执行步骤（包括模型调用及该步骤的工具动作）完成后生效；已创建草稿会保留并显示。服务退出时会请求停止当前工作；意外退出后的未决动作由原有恢复机制核对。

Web API 与原运行时的测试一起执行；HTTP 测试使用临时目录和本机随机端口，不调用真实模型：

```bash
python3 -m unittest discover -s tests -v
```

## 目标运行时配置

打开工作台左侧的“运行时配置”（`http://127.0.0.1:8787/#/runtimes`），可分别配置 **Codex CLI、Cursor CLI 和内置模拟运行时**：

- 保存模型 ID、单次模型超时（1–180 秒）、结构化输出修复上限（1–3 次）；Codex 可另选推理强度。
- 选择新任务默认运行时，新建任务窗口仍可单独切换，并显示当前模型和配置版本。
- “检测 CLI”只运行固定的版本查询，显示是否安装及版本；不发送任务、不调用模型，也不代表账号已经登录或拥有所选模型权限。请在终端执行 `codex login` 或 `cursor-agent login` 完成登录。
- 配置按服务租户保存在 `runtime.sqlite3` 的 `runtime_configuration` 中，重启后保留。页面不保存 API Key，不接受任意命令、脚本或额外 CLI 参数。
- 保存采用版本检查，其他页面更新配置后会拒绝覆盖；新建任务也检查页面展示的配置版本，避免使用用户尚未查看的新配置。

任务提交后，所选运行时、模型、超时、输出 Schema 和策略被冻结到运行快照。后来切换默认运行时或修改配置不会改变既有任务；恢复按原快照选择 Codex 或 Cursor 适配器，未决写入仍优先核对原幂等键。原有 Codex 快照格式保持兼容。

Cursor 适配器使用 `cursor-agent --print --mode ask --output-format stream-json --sandbox enabled`，在临时工作空间和独立 CLI 配置下运行；原生 Shell、文件、WebFetch 使用拒绝规则，继承的 MCP 配置以禁用项覆盖，不复制其命令或密钥。内置 Agent 禁用所有 MCP；自定义 Agent 仅开放受控读取代理的工具白名单；未登记效果的旧 MCP 直连不再执行。发现未授权原生工具调用、错误结果、缺失用量或非法 JSON 时停止，不切回其他运行时。Cursor 不接受 `auto` 作为模型 ID，请用 `cursor-agent models` 获取具体 ID。旧版 Cursor 若不返回 input/output token 用量会报 `cursor_usage_unavailable`，需要升级 CLI；不会以零用量绕过预算。CLI 的完整 OS 行为隔离仍取决于安装版本和原生沙箱能力。

## CLI 模型选择与 Agent 配置

打开 [运行时配置](http://127.0.0.1:8787/#/runtimes)，选择 Codex 或 Cursor。模型下拉框分别通过 `codex app-server` 的 `model/list` 和 `cursor-agent models` 获取，显示来源及数量，支持“刷新模型”。目录按租户缓存 5 分钟；读取失败会显示错误，不生成静态替代列表。目录中的模型是否可用，仍由实际模型调用时的账号权限判定。

点击“基于此运行时创建 Agent”，或进入 [智能体 Agent](http://127.0.0.1:8787/#/agents)：

1. 绑定运行时、CLI 模型、超时、结构化输出修复上限，以及 Codex 模型支持的推理强度。
2. 填写角色 Prompt，添加并启用 Skill 的名称和方法说明。当前 Skill 为内联说明，不自动安装或执行任意 Skill 包脚本。
3. 编辑“岗位定义与能力绑定”，配置身份、职责、标准和能力引用；如需原生 MCP，在 `native_read_refs` 中选择已登记 READ 能力。保存后点击“检查编译”。旧 stdio / HTTP 直连字段仅供迁移，启用它们会阻止新任务编译。
4. 保存后可编辑、复制、归档或恢复使用。配置按版本保存，编辑冲突会拒绝覆盖。
5. 新建任务时选择 Agent，运行时和模型随 Agent 绑定。真实模型发送许可与 MCP 执行许可分别确认。提交时冻结完整配置；后续编辑或归档不改变旧任务恢复所用的版本。

Prompt、结构化岗位定义和启用 Skill 进入模型规划上下文。新原生 MCP 由 `ReadCapabilityProxy` 暴露任务范围内的模拟读取，记录当前授权、租约、预算、审计和证据。业务写入仍由结构化提案进入 Gateway；任意 MCP/CLI 不能直接写入。

旧版独立示例 [mock_facts_mcp.py](examples/mock_facts_mcp.py) 保留供协议测试和历史记录解释；新任务不再按任意端点配置直接启动它。迁移方式与完整模拟矩阵见 [P0 实施说明](docs/p0/implementation.md)。

配置说明、API、权限边界和验收记录见 [docs/agents.md](docs/agents.md)。

真实模型任务仍需逐次勾选上下文发送许可。Codex 使用 OpenAI 模型服务；Cursor 使用其 CLI 对应的模型服务与登录态，选择前请确认上下文获准发送。配置保存和版本检测不需要该许可，也不会发送任务。

CLI 可显式选择运行时；下面会真实发送任务，仅在获准后执行：

```bash
python3 -m agent_framework --planner cursor --model YOUR_CURSOR_MODEL demo
# 恢复已有任务时自动使用原来的运行时与模型
python3 -m agent_framework resume run-xxx
```

Web 界面保存的默认值用于 Web 新任务；CLI 新任务继续默认使用模拟规划器，显式 `--planner` / `--model` 才会选择真实运行时。

配置 API 为 `GET/POST /api/runtime-config`，本机版本检测为 `POST /api/runtime-config/detect`。写入继续要求本页面令牌、同源 JSON 请求和服务端固定租户。

参考：[Cursor CLI 配置](https://cursor.com/docs/cli/reference/configuration)、[权限](https://cursor.com/docs/cli/reference/permissions)、[输出格式](https://cursor.com/docs/cli/reference/output-format)。

## P0 岗位与动作治理

新任务已使用岗位编译快照和统一效果契约；旧任务保留原快照恢复路径。运行命令、迁移边界与模拟验证见 [P0 实施说明](docs/p0/implementation.md)。

```bash
python3 -m agent_framework.p0_evaluate
```
