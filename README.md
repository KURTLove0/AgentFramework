# Agent Framework

当前发行版本 **1.4.0**。独立安装包及启动方式见 [发行版安装说明](docs/release/INSTALL.md)，功能范围见 [发布说明](docs/release/RELEASE_NOTES.md)。业务工具仍为模拟实现；初始工作台不附带演示数据。

当前界面面向 **桌面 Web 与 PC**。开发和 UI 验收以 1024、1280、1440、1920px 桌面窗口、鼠标键盘及浏览器文字缩放为准；手机端不在产品实现范围内。桌面细节验收可运行 `npm run test:desktop`，具体标准见 [桌面范围说明](docs/ui-detail-review-20261028/DESKTOP_SCOPE.md)。

从当前源码生成不含本机数据的发行包（在已安装项目依赖的虚拟环境中执行）：

```sh
python -m pip install 'setuptools>=68' wheel
python scripts/build_release.py
```

输出 `dist/agent-framework-1.4.0.tar.gz`、独立 wheel 和 SHA256 校验文件。构建会逐文件核对代码和资源，包含目标与智能体任务创建、持续对话、工作流画布及浅色/深色界面。解压后执行 `sh scripts/install.sh`、`sh scripts/start.sh` 即可启动干净工作台；原有源码和开发测试命令继续可用。

默认构建拒绝覆盖已有版本。检查尚未发布的当前工作树，可用 `python scripts/build_release.py --output-dir /tmp/agent-source-candidate` 单独生成验收候选。安装、启动及内置 Python 子进程现已隔离调用方目录与环境；全新离线安装和实际启动脚本的验证方式见 [当前源码的交付验收](docs/release/source-delivery.md)。

安装验收的 `--browser-check` 覆盖提交回执恢复、首次任务准备、任务名称、归档、收藏、多轮导出、工作流恢复和消息草稿。浏览器新建的工作流再经历实际进程重启及备份还原，核对原节点、冻结配置、事件和模拟草稿，并再次验证授权重放不重复写入。1.4.0 另补齐原版 1.3.0 升级与完整备份回退，见 [1.4.0 发布验收](docs/release/verification-1.4.0.md)。

当前源码面向按目标执行的智能体任务：选择已保存的智能体、输入目标，即可开始。运行页按实际事件展示公开思考摘要、资料读取与结果，支持同一任务内继续提问、修改和停止。普通任务没有固定的“计划 → 检索 → 回答 → 验收”模型调用链路。

Python **3.11+**，核心执行器使用标准库；标准 Skill YAML 解析使用 PyYAML。默认模式无需 API Key、网络或额外服务，使用确定性规划器；真实模型模式支持 Codex、Cursor 和 Qoder CLI，复用对应的本机账号配置。业务工具始终为模拟实现；状态机、持久化、子进程、授权检查、幂等、回读与故障恢复是真实代码。

基于“知识、记忆、经验、能力 → 岗位 Agent → 感知、执行、验证”的下一轮优化，见 [Agent 框架优化方案](docs/optimization/proposal.md)，附目标架构与可运行设计契约样例。

## 当前任务动线

- 处理领域保存业务范围和自由填写的工作指引；智能体的模型、工具与交付要求独立配置。
- 普通任务直接执行，运行时提供公开摘要或正文时持续展示；刷新和重连恢复已保存的片段。模型未提供公开摘要时，仅展示实际状态，不生成模拟思考。
- 补充信息、修订和重试保留在同一任务，运行中的补充消息按顺序处理；停止或失败保留已有片段并标记未完成。
- 每日任务模板使用同样的目标与智能体配置，可待启动或自动执行。通用工作流按各节点目标执行，节点提问后可以在任务中补充信息并自动继续。
- 复盘读取最新一轮结果，沉淀仍需审阅；普通任务经验只做结果结构与来源检查，不将业务模拟流程作为经验。

运行摘要仅来自运行时明确公开的内容，不展示隐藏推理。旧业务流程的授权、回读与故障恢复继续兼容；下方 CLI `demo` 章节说明的是这些业务模拟场景。

以下此前按独立候选记录的改进已纳入 1.4.0；各历史文档保留当时的版本与验收范围。任务、工作流和评测动态空页的修复见 [1.4.0 发布验收](docs/release/verification-1.4.0.md)。任务动线核查见 [任务及跨模块动线核查](docs/project-review-20261027/README.md)。

工作流新增**持久排队、自动接续与重启恢复**：启动、具体提案授权和恢复请求在队列拥堵时仍会保存，界面明确显示排队状态，容量恢复后继续原运行。节点补充回答即使错过续跑通知也会接回原流程，超过 100 条的历史运行仍可继续。授权期限和已完成节点的任务身份继续保持原有规则。见 [工作流恢复与执行可靠性](docs/reliability/implementation.md)。

工作流页面新增**旧响应保护**：保存、归档、授权和取消成功后，较早开始的刷新不能回退配置或状态；切换运行后，过期详情和读取错误也不会覆盖当前页面。见 [工作流刷新与操作回执](docs/reliability/workflow-view-consistency.md)。

工作流操作新增**回执版本与取消优先级**：晚到的授权或恢复回执不能回退已确认状态，取消后提交的新授权会在事务内拒绝；取消派发失败可“重试取消”，授权入口保持停用。见 [工作流操作回执与取消优先级](docs/reliability/workflow-command-receipts.md)。

工作流恢复与取消支持**响应不明后的只读核对**：页面重绘不会恢复重复提交入口，恢复等待期间仍可取消；取消结果未确认时阻止重复操作和新增授权。核对仅读取原运行，旧回执不影响另一条记录。见 [工作流恢复与取消的结果核对](docs/reliability/workflow-controls.md)。

工作流详情确认状态变化后，**历史列表同步失效并保留查询位置**：读取失败不会把已取消或已授权的运行重新显示为等待授权，也不会显示旧数量或虚假的零匹配。刷新入口保持可用，普通刷新失败仍保留有效的上次结果。见 [详情与历史列表的一致性](docs/reliability/workflow-history-consistency.md)。

执行器意外退出会保存**持久诊断并等待显式恢复**，刷新和重启后仍可查看原因及已保存片段；恢复沿用原任务、配置、预算与授权。旧执行器或迟到的页面回执不能覆盖新状态。见 [执行器中断的诊断与恢复](docs/reliability/worker-recovery.md)。

**失去租约的静默模型调用及时退出**：心跳检测到执行权失效后终止本机模型进程，保留租约错误，不替接手进程写入停止请求或覆盖结果。页面继续提供原任务恢复入口。见 [模型调用中的租约失效](docs/reliability/cognition-lease-loss.md)。

**长输入发送受阻时也能停止**：Codex RPC 发送阶段持续检查停止、租约和调用超时；子进程停止读取输入时及时退出，长 Unicode 消息仍按原顺序完整发送。见 [RPC 输入阻塞与恢复](docs/reliability/codex-rpc-writes.md)。

**模型异常退出后的清理保留原始错误**：先回收已退出主进程，再结束本次进程组，避免清理错误覆盖模型或租约异常、阻断管道关闭。已显示片段和失败记录保留，可在原任务中明确重试。见 [异常退出进程的回收](docs/reliability/process-cleanup.md)。

[清理拒绝与管道退出](docs/reliability/cleanup-failures.md)进一步处理进程终止无法确认的情况：本地管道独立关闭，保留原始错误并明确记录清理状态；有效模型输出也不能在清理失败时被当作成功。RPC 和通用 CLI 使用同一执行线程中的非阻塞读写，停止时不遗留阻塞的管道线程。

**清理未确认时暂停后续消息**：首轮或后续轮次出现清理失败后，队列保留并等待用户检查运行环境，确认后才继续。确认绑定具体运行版本，支持回执丢失后的只读核对与刷新恢复，不改写原失败结果。见 [队列暂停与环境核对](docs/reliability/cleanup-review.md)。

**清理异常后的执行器中断只恢复原轮次收尾**：诊断已保存但失败结果尚未保存时，恢复会核对在途业务效果并结束原轮次，不再次调用模型或重新派发写入。原错误、公开片段与队列继续保留。见 [清理异常保存后的中断恢复](docs/reliability/cleanup-recovery.md)。

**失败提示说明原因与下一步操作**：常见模型错误显示可理解的恢复建议，失败轮次可直接查看本轮记录；原始错误码继续保留。涉及待核对的业务操作时先提示人工确认，普通中文说明不会因包含错误码而被改写。见 [模型失败提示与诊断入口](docs/reliability/model-failure-messages.md)。

**失败轮次的重试有固定关联**：重复点击或多个页面同时重试，只创建一个接续轮次；原失败记录可直接定位重试结果。回执丢失后支持刷新恢复和只读核对，再次失败可从新轮次继续重试。输入框草稿与完整对话导出的重试来源均保留。见 [失败轮次的重试与关联](docs/reliability/turn-retries.md)。

**未决操作期间保留对话队列**：原业务操作待确认时暂停后续消息，接收与执行均复核当前状态。已接收消息仍可核对回执或取消排队，草稿和运行记录保留，列表不会用排队状态遮盖人工核对提示。见 [待核对操作与对话队列](docs/reliability/conversation-review.md)。

**人工核对信息集中展示**：待核对运行展示操作编号、幂等键、回执对象和检查依据，可复制核对摘要；对话记录窗口可展开完整工具动作。查看或复制均保留原任务和业务结果。见 [人工核对信息与工具记录](docs/reliability/run-review.md)。

任务停止新增**持久请求与重启恢复**：先保存停止意图，再核对在途操作并结束当前轮次；刷新和跨进程停止仍可追踪处理进度。停止失败保留原因并支持“重试停止”，已保存片段、输入草稿和明确排队的后续消息继续保留。见 [任务停止的持久请求与恢复](docs/reliability/cancellation.md)。

新建任务的**保存、启动登记与首次审计一起提交**，进程在回执返回前退出也能接续原任务；多个页面或进程同时重试相同提交编号会返回同一记录。排队消息取消与开始处理互相校验，防止已取消消息再次执行，重复回执也不会删除后来保存的新草稿。见 [任务提交与取消排队](docs/reliability/task-submission.md)。

新建任务和启动工作流在**接受事务内再次核对配置**：智能体、流程或已启用 Skill 在预检后变化时，拒绝旧提交并保留草稿；已经接受的请求继续复用原回执和冻结配置。见 [任务接受时的配置一致性](docs/reliability/task-acceptance.md)。

任务提交回执丢失后可以**核对原任务、沿用编号重试并在刷新后恢复**；继续编辑不会自动创建第二项任务。明确查到原任务后才提供另建选择，配置冲突也能保留目标并核对当前版本。见 [任务提交回执与页面恢复](docs/reliability/task-submission-recovery.md)。

任务创建与核对会**先检查回执，再清理恢复记录**。HTTP 成功但内容残缺、编号不匹配或配置错误时，继续保留目标与原提交编号；可只读找回原任务，刷新后重试也不会另建。见 [任务回执一致性](docs/reliability/task-receipts.md)。

任务结果待核对期间，**原提交与后续编辑分别保留**。刷新还原本页目标、智能体和来源；服务端已有草稿供明确核对，不自动替换本页输入。存储失败会提示，恢复出的不可用智能体需要重新选择。见 [待核对任务的编辑恢复](docs/reliability/task-editing.md)。

普通新建、从智能体发起、基于已有任务新建时，**另一份已保存草稿保持独立**。本页输入不会自动覆盖它；可以直接创建任务，或核对后明确使用、替换草稿。放弃本页新设置也不清理独立草稿。见 [新任务与独立草稿](docs/reliability/task-draft-ownership.md)。

[任务准备与读取重试](docs/reliability/task-opening.md)为慢配置读取提供可取消的等待窗口，失败原因持续保留并支持重新读取。复用任务重试保留原来源，从配置页返回保留任务目标；取消、离开页面或转去其他编辑器后，迟到响应不会重新打开窗口。

[排队消息修改与恢复](docs/reliability/task-message-edits.md)支持在原位置修正尚未开始处理的要求，保留原发送回执及后续草稿。多页面冲突和回执丢失先只读核对；消息已经开始时拒绝修改并保留可复制的输入，派发不会使用已被修正的旧内容。

[消息修改记录](docs/reliability/task-message-history.md)可查看原始消息、每次修改前后内容，以及本轮执行实际采用的要求。长记录分页加载，新修改不会打乱当前查看范围；读取失败保留已加载内容，支持重试或重读最新记录。查看和复制保留编辑草稿与排队消息。

[回复复制与失败恢复](docs/reliability/task-reply-copy.md)保留完整 Markdown 原文，复制失败可重试或全选原文手动复制。重复点击不会叠加复制，切换任务后忽略旧结果，复制和重绘保留草稿与选区；较矮窗口中的长输入也会保留可见的发送按钮。

[代码复制与选区恢复](docs/conversation-ui/code-copy-recovery.md)为代码块提供重试和全选入口，慢许可及整页重绘不会重复复制。手动复制保留缩进、空行与末尾换行，局部反向选区和横向位置可随重绘恢复；后续输入和其他任务的反馈保持独立。

[流式回复的阅读连续性](docs/conversation-ui/stream-reading.md)让正文追加时保留未变化段落、列表和表格中的选区，以及来源链接的键盘焦点。仅进度变化不再重新解析正文；流式更新只处理变化回复的阅读状态，减少长对话中反复扫描历史消息的开销。

[状态变化后的阅读恢复](docs/conversation-ui/redraw-reading.md)进一步在整页重绘和最终结果替换时恢复原文字选区与来源链接焦点。恢复前核对消息身份、所选内容和链接地址；已改写内容、其他任务及后来输入不会继承旧阅读状态。

任务草稿新增**多页面版本保护与冲突核对**：放弃后保留递增版本，旧页面不能覆盖新草稿；提交任务只清理已查看的版本。保存冲突可核对两份设置，放弃失败保留输入与确认框。见 [多页面任务草稿保护](docs/reliability/task-drafts.md)。

[运行时配置保存与恢复](docs/reliability/runtime-settings.md)为配置保存提供固定编号与持久回执。刷新可恢复当前标签页的编辑，回执丢失可只读核对并沿用原内容重试；冲突时分别展示原保存与当前配置，明确选择采用或继续修改。迟到配置和模型目录读取保留后来输入。

运行时与智能体表单已对齐后端支持的参数：**`ultra` 推理强度与正小数秒超时**可读取、保存和恢复，合法回执不会再被误判为无效。超时仍须大于 0 且不超过 180 秒；隐藏运行时中的无效值会定位到对应字段，修正后清除旧错误。见 [执行参数的表单与回执一致性](docs/reliability/runtime-values.md)。

[配置修改核对](docs/reliability/runtime-feedback.md)逐项展示编辑基准与本页输入。保存后继续编辑会立即标记未保存内容，全部还原后清理草稿；版本冲突和未决保存继续优先提示，展开比较状态也会保留。

[配置页返回恢复](docs/reliability/runtime-lifecycle.md)在浏览器恢复缓存页面后重新连接编辑器、恢复控件，保留草稿与原保存编号。返回不会自动提交；旧响应不会覆盖恢复后的编辑，滚动位置也会保留。

[CLI 检测与恢复](docs/reliability/runtime-detection.md)按运行时保留检测状态，切换页面后丢弃旧回复，检测与配置保存交错时仍保持正确的按钮状态。版本检测有独立超时、输出上限和进程组清理；失败后可明确重试，检测不会保存配置或调用模型。

[模型目录读取的超时与恢复](docs/reliability/model-discovery.md)让慢 CLI 不再阻塞其他运行时或有效缓存，同类并发刷新共享一次查询。持续通知、输入阻塞和超长输出都有边界，查询结束清理所属进程组；失败保留原目录与本页输入，可明确重试。

任务导出新增**一致快照与完整记录包**：浏览器可下载包含结果、事件、证据和上下文的 ZIP，CLI 可校验完整性；已有导出目录不会被覆盖。完整对话和未完成报告标注实际状态，运行过程中导出也不会混合不同检查点。见 [任务导出与完整记录包](docs/reliability/exports.md)。

[完整任务包](docs/reliability/task-exports.md)进一步覆盖整段对话、全部消息修改历史和所有已创建轮次的运行记录。任务信息中可一次下载 ZIP，并沿用 `verify-export` 离线校验；排队与取消状态、实际执行采用的要求和各轮事件来自同一读取快照。

[选择导出格式与失败恢复](docs/reliability/export-formats.md)让 Markdown、JSON 和 ZIP 共用下载窗口，说明各自包含的记录。失败后可按原格式重试，准备期间重复点击不会重复请求；键盘下载保留等待焦点，完成或失败后不抢回用户已移到关闭按钮的焦点。切换任务或超时后的旧响应不会触发迟到下载，草稿继续保留。

[基于已有任务新建](docs/reliability/task-reuse.md)可从任务对话复用初始目标，展示原智能体版本与当前配置的差异，开始后创建带来源链接的独立任务。已有设置草稿与待核对提交会先保留并说明，原对话和执行结果不变；切换页面后迟到的配置读取不会重开旧窗口。

[查看关联任务](docs/reliability/task-relations.md)可从原任务找到直接复用结果，也可返回来源及具体对话轮次。列表包含已归档任务、支持分页与刷新，并在新任务加入时给出提示；不可访问的来源隐藏，查看和切换过程保留对话草稿。关联查找按来源编号定位，避免反复读取无关任务正文，并保留只读旧库兼容。

导出交付补齐了**目录同步、文件归属检查与读取限制**：失败清理保留其他进程的文件，收尾异常不删除完整导出；校验先检查名单、清单和文件类型，再读取正文，损坏 ZIP 与命名管道返回明确错误。见 [导出发布与校验保护](docs/reliability/export-publication.md)。

任务回复支持**表格、引用、嵌套清单与单独复制代码**：宽内容在回复内滚动，流式追加保留阅读位置和键盘焦点；解析器随应用离线打包，完整回复复制仍保留原始 Markdown。见 [任务回复的表格、代码与阅读连续性](docs/conversation-ui/rich-replies.md)。

任务对话支持**按文字查找要求、回复和生成片段**，显示匹配数及所在轮次，可高亮并双向定位。查找期间的新回复会更新匹配数，保留当前阅读位置和输入草稿；查询只在本页内存中保留。见 [对话内查找与定位](docs/conversation-ui/task-search.md)。

[长对话查找索引](docs/conversation-ui/search-index.md)复用未变化消息的正文和匹配范围，连续定位不再重新遍历全部消息；生成片段变化时只重建受影响的正文。复制恢复按钮和状态不会混入查找结果，关闭查找或离开任务会释放索引。

[跨任务消息正文搜索](docs/reliability/task-text-search.md)让任务列表与全局搜索也能找到后续要求和已保存回复中的文字。结果显示命中片段、轮次与消息类型，点击可直接定位；正文匹配参与完整分页，并遵守归档、收藏、状态及权限筛选。轮次链接可刷新，原消息和草稿继续保留。

历史 CLI 查询改为**直接只读打开已有数据**：查看、事件、统计和独立导出不初始化执行器或迁移旧库，路径错误不会生成新工作台；业务库缺失时明确说明无法统计。见 [历史任务的只读查询](docs/reliability/inspection.md)。

智能体配置保存新增**持久回执与冲突核对**：回执丢失后重试不重复创建或增加版本，保留本页输入并区分已接受版本与当前配置。归档和空间删除会阻止配置改写，用户可明确选择另存副本。见 [智能体保存回执与恢复](docs/reliability/agent-saves.md)。

智能体编辑支持**当前标签页的草稿恢复**：刷新后继续未完成的工作指令、职责与技能配置，保留待核对的保存编号；恢复不会自动提交。存储失败会提示并保持编辑窗口，不可用模型保留原选择并要求修正。见 [智能体编辑草稿](docs/reliability/agent-drafts.md)。

刚打开或复制的配置，即使尚未修改字段，也能明确点击“保留草稿并关闭”，刷新后继续编辑。未填写名称的新建表单也可保留；普通取消不生成草稿。

智能体的**模型刷新保留最后选择**：慢响应不会改回旧模型或推理强度，刷新失败保留已有选项。已移除模型和不再支持的强度继续显示原值，要求明确修正；重新选择后清除旧错误，保存及新任务快照沿用最终选择。见 [模型选择与刷新恢复](docs/reliability/agent-models.md)。

浏览器模型目录现在有**明确的有效期**：按服务端读取时间核算五分钟，到期后下次打开或切换运行时会重新核对；读取失败保留原选择，且不会延长旧缓存寿命。见 [模型目录缓存时效](docs/reliability/model-freshness.md)。

智能体配置打开前会**并行读取并核对当前数据**：慢读取可以取消，失败可重新读取，离开页面后旧回复不会弹出窗口。新建智能体采用新读取的运行时默认值，编辑与恢复仍保留自身配置。见 [配置打开与读取恢复](docs/reliability/agent-opening.md)。

[智能体执行配置切换](docs/reliability/agent-template-switching.md)在读取期间显示进度，关闭或重新打开编辑器后忽略旧结果。等待期间填写的名称、岗位和指令保留；职责或能力有新修改时先保留原配置，明确重试后再切换，复制保存仍生成独立智能体。

执行配置读取较慢时，也可[保留草稿并关闭](docs/reliability/agent-template-drafts.md)，稍后恢复原配置与输入。迟到响应不会改写恢复后的表单，存储失败会保持编辑窗口。

保存结果不确定时，可**重试原提交并保留后续修改**。原内容、编号与目标固定，后续表单未填完也可重试；查不到回执时不会提前换号保存。刷新恢复同时保留两份内容，旧版副本仍可明确处理。见 [智能体原提交重试](docs/reliability/agent-retries.md)。

任务详情使用**同一份持久化快照**展示状态、对话、事件和证据；迟到响应保留较新的状态。停止已完成但响应丢失时，只读核对会明确显示已结束；停止尚未完成时不能开始复盘。见 [任务详情快照与停止结果核对](docs/reliability/detail-snapshots.md)。

**停止请求同步约束原生读取**：读取代理会检查已保存的停止意图，阻止新的读取，并拒绝尚未保存的晚到结果。停止与模型错误同时发生时按停止处理，已有业务写入仍先核对。见 [原生读取的停止边界](docs/reliability/native-read-cancellation.md)。

**旧式工作流的模型调用也可及时停止**：没有公开进度回调时，仍持续检查停止和输出限额；停止后不再进行格式重试或采用晚到计划。收尾会清理本次模型进程组，避免父进程退出后子进程占住管道。见 [工作流模型停止与进程收尾](docs/reliability/workflow-model-cancellation.md)。

实时对话按**检查点和事件顺序**采用更新，同时间戳的旧轮询不会抹掉新增过程，时钟回退也不阻止新内容。重连保留匹配的操作详情，等待授权时刷新完整提案。见 [实时对话的顺序与操作详情恢复](docs/reliability/stream-ordering.md)。

实时连接支持**容量限制、后台释放和递增重试**：多个标签页共用有限推送名额，暂满或断线时继续轮询；后台页面释放连接，恢复后接回原任务，保留草稿且不重发消息。见 [实时连接生命周期](docs/reliability/stream-lifecycle.md)。

长对话改为**批量读取展示字段和有效公开过程**，避免每次推送反复解析完整动作、私有审计和过时回答片段。完整历史继续保留；同一份 60 轮合成历史上，响应内容不变，读取耗时中位数由 135 毫秒降至 34 毫秒。见 [长对话读取优化](docs/reliability/conversation-projection.md)。

续问历史会**保留正文并合并重复引用标识**，避免长引文重复占用模型历史预算；原报告仍保留全部引文。每次调用继续核对显式引用的来源，并记录实际发送历史的摘要。见 [续问历史与来源核对](docs/reliability/history-context.md)。

**历史来源依赖随改写保留**：带引用的回复被后续轮次改写后，即使改写没有再次引用，原资料撤回时也会在下一次模型调用前屏蔽相关历史正文。原报告和冻结记录继续保留，已屏蔽来源不会传给后续新回复。见 [多轮改写的来源核对](docs/reliability/history-dependencies.md)。

来源核对也覆盖**已提供但未标注引用的资料**：根据当轮上下文清单、已验证的工具搜索和读取证据保留依赖，资料撤回后不再把相关旧回复交给模型。因预算未提供的资料、未完成或被拒绝的读取不会给无关回复附加依赖。见 [未引用资料的来源核对](docs/reliability/source-exposure.md)。

**格式重试与技能加载逐次核对上下文**：首次输出格式不合要求后，再次请求会重新读取当前资料、历史来源和工具证据，避免重发期间已撤回的正文。每次请求记录独立清单，停止、期限和调用预算继续生效。见 [模型请求前的上下文刷新](docs/reliability/model-context-refresh.md)。

**长消息可完整送入模型**：粘贴超过 2,000 字的材料后，资料与记忆的自动检索使用有限片段，避免已受理消息在执行时因检索长度限制而失败。消息正文保持完整，16,000 字中文消息经过刷新和继续追问验收。见 [长消息执行](docs/reliability/long-messages.md)。

未发送消息支持**标签页独立恢复与共享草稿核对**：多个页面的输入分别保留，冲突时明确选择保存或采用；发送回执不清除另一页的新草稿。共享保存成功但标签页写入失败时，刷新读取共享内容，避免恢复旧输入或已发送文字；旧副本清理失败会提示并允许重试。存储失败可复制、重试，输入法期间切换任务也不会把文字发往错误对话。见 [消息草稿保护](docs/reliability/chat-drafts.md)。

工作流编辑新增**保存核对与归档保护**：响应丢失后继续修改不会自动另发提交，核对区保留本页输入并区分原回执与当前版本。恢复保存复用已创建的专用智能体，版本冲突和已归档流程需明确处理。见 [工作流保存回执与编辑恢复](docs/reliability/workflow-saves.md)。

工作流草稿支持**当前标签页刷新恢复**：未完成节点、专用智能体草案、画布位置与待核对的原提交一起保留。可“保留草稿并关闭”，从目录明确继续；恢复不自动提交，存储失败会保留窗口并提示。见 [工作流草稿的标签页恢复](docs/reliability/workflow-drafts.md)。

工作流启动支持**原请求核对与刷新恢复**：启动前重新检查流程和智能体；响应丢失后保留原编号、原参数及后续输入。刷新或服务重启后可只读查回原运行，明确重试仍使用原请求；准备另一次运行需重新检查配置。见 [工作流启动核对与恢复](docs/reliability/workflow-starts.md)。

工作流授权绑定**刚刚审查的具体提案**：内容、任务轮次或授权状态变化时拒绝旧提交，页面提供只读核对入口。已受理的重复请求复用持久回执，不延长授权期限或覆盖后来的取消；详情展示与授权均采用节点的当前对话轮次。见 [工作流提案授权与核对](docs/reliability/workflow-grants.md)。

普通任务的**授权、撤销与继续执行**也绑定已审查内容：响应丢失可只读核对，旧请求不能恢复已撤销权限或撤销后来的新权限。队列拥堵与服务重启保留继续执行请求，失败后明确重试沿用原授权；晚到回执不会干扰后来打开的确认窗口。见 [普通任务授权、撤销与执行恢复](docs/reliability/task-permissions.md)。

连续对话支持**消息发送核对与刷新恢复**：回执丢失后保留原消息和编号，后来编辑的文字单独保留。核对只读取；明确重试沿用原编号，其他页面更新仍触发版本检查，不因刷新或修改文字重复增加轮次。见 [连续对话的消息核对与恢复](docs/reliability/task-message-recovery.md)。

任务中的**本轮运行记录**支持即时加载提示、原地重试和明确的读取时间。关闭窗口或切换任务后，慢响应不会重新打开旧内容；下载绑定所查看的轮次与空间。见 [本轮运行记录的读取与恢复](docs/reliability/run-inspector-recovery.md)。

工作流设计支持**原请求核对与刷新恢复**：响应丢失后可取回同一次设计结果，明确重试沿用原编号、内容和版本；后来输入的需求单独保留。结果与回执一起提交，处理期间的配置变化会阻止旧结果写入。见 [工作流设计请求的核对与恢复](docs/reliability/workflow-design-recovery.md)。

设计、复盘和本体**生成等待期间可继续工作**：模型等待不再占住普通写操作，其他页面可以保存草稿和创建任务。各空间共用两个生成名额，容量不足时立即说明尚未受理；已有结果仍可查回。见 [生成等待期间继续工作](docs/reliability/proposal-responsiveness.md)。

复盘与本体支持**生成中断识别与输入恢复**：处理期限结束后明确显示中断，迟到结果不能覆盖失效记录；重新打开恢复原要求，并提示智能体版本和来源变化。核对后可明确生成新提案，原记录保留。见 [复盘与本体生成中断后的恢复](docs/reliability/learning-generation-recovery.md)。

复盘与本体还支持**等待时关闭窗口、刷新后核对原请求**：发送前保留原编号与内容，未送达请求可明确沿用原内容重试；后续要求独立保留，迟到回复不覆盖新窗口。见 [生成请求的刷新恢复](docs/reliability/learning-request-recovery.md)。

本体修订支持**保存回执与编辑恢复**：区分自己的保存版本和其他页面后来的版本，原内容重试不会重复创建版本；关闭或刷新后保留编辑，可明确采用新版本或保留本页内容继续修订。见 [本体修订的保存核对与恢复](docs/reliability/ontology-save-recovery.md)。

复盘和本体生成提案支持**审阅保存与沉淀恢复**：按原请求核对自己的结果，刷新后保留后续审阅和勾选；原请求重试不会重复沉淀，保存结果不明时先核对再继续。见 [审阅保存与沉淀的回执恢复](docs/reliability/learning-write-recovery.md)。

源码新增**核心数据备份、校验和恢复命令**：两个数据库配对保存，纳入尚在 WAL 日志中的已提交记录；恢复前校验完整性，只写入新目录，保留任务和业务幂等事实。恢复中断的目录会阻止启动，避免使用半份数据。用法及验证见 [核心数据备份与恢复](docs/data-protection/implementation.md)。

备份和恢复补齐了**目录同步与失败后的数据保护**：确认文件及目录项同步后才报告成功；恢复完成后的收尾异常不会删除完整数据，回滚失败仍保留启动保护。见 [备份发布与恢复持久性](docs/data-protection/durability.md)。

恢复前可用 `verify-backup` **核对备份内容**：显示工作空间、租户、删除状态以及执行记录、对话、智能体和已保存草稿数量；超过 100 个空间可继续翻页。摘要读取经过校验的备份，不启动任务或修改原数据。见 [恢复前核对备份内容](docs/data-protection/backup-contents.md)。

任务历史改为**按需读取与批量汇总**，列表刷新无需加载全部对话正文和审计。分页保存排序边界，避免游标任务更新后重复显示记录；工作台待办与后台派发也减少重复历史读取。实测与状态同步修正见 [任务历史读取与稳定分页](docs/history-performance/implementation.md)。

[任务列表读取一致性](docs/reliability/task-catalog-snapshots.md)把任务名称、归档、最新状态、正文搜索和分页放入同一读快照，计数与行内信息共用执行器状态观察。并发追加消息或完成任务时，不再拼接不同提交时刻的数据；待处理入口同时核对任务状态与租约。

长期运行的**执行记录缓存有了数量上限**：保留近期执行提示，历史结果与失败回执继续从数据库读取；写入失败的诊断保留并计入执行容量，避免无限积累或意外重试。见 [执行记录回收](docs/reliability/job-history.md)。

[运行历史查询与恢复](docs/reliability/run-history-recovery.md)支持在后台慢读取期间切换筛选，旧响应不会覆盖当前结果。翻页失败可重试原页或返回上次成功结果；读取失败与真正的空结果明确区分。

[运行列表浏览位置恢复](docs/reliability/run-history-state.md)让刷新、详情返回和浏览器前进后退保留各自的搜索、筛选、排序与页码。条件按身份和工作空间隔离，结果重新读取；保存失败有明确提示，列表重绘也会保留恢复按钮的键盘焦点。

[任务归档与移回](docs/reliability/task-archive.md)支持整理已结束任务，保留结果、对话、导出和草稿。默认列表隐藏已归档任务，可按归档范围查看或通过全局搜索找回；发送新消息会自动移回，迟到的旧归档不能隐藏新进展。任务仍在执行或有待核对操作时不能归档。键盘归档与核对完成后恢复到可用操作，等待期间转去编辑草稿时保留输入焦点。

[任务名称与编辑恢复](docs/reliability/task-names.md)支持给长要求或相似任务设置便于辨认的名称，也可恢复默认。列表、搜索、待办和完整对话导出同步名称，原始要求继续保留；多页面冲突、回执丢失和刷新均保留本页编辑，核对后由用户决定如何继续。草稿清理失败会保留窗口；名称已保存时，可只重试本地清理。

[任务收藏与查找](docs/reliability/task-favorites.md)支持收藏常用任务，并在运行记录中“只看收藏”。收藏与搜索、归档范围和分页共同生效，刷新及返回列表保留条件；回执丢失后只读核对，多页面的新选择不会被旧回执覆盖。收藏与核对完成后恢复键盘焦点，已确认操作的本页记录清理失败可单独重试，不重复切换收藏。任务结果、执行状态和草稿保留。

[工作台完整待办](docs/reliability/attention-inbox.md)可筛选和翻页浏览全部任务、工作流与每日计划，后面的事项不再被前 8 项遮挡。详情返回保留浏览位置，旧每日计划可通过直达链接读取并定位；读取失败仍保留已知事项的入口。

Skill 目录改为**批量读取与一致快照**，减少历史文件正文的重复解析，保留全部版本摘要和所选包的完整性校验；智能体“编辑指令”和“技能配置”立即打开目标分区。性能对比及验收见 [Skill 目录与配置入口优化](docs/skill-catalog/implementation.md)。

Skill 创建与编辑新增**保存回执和文件恢复**：回复丢失后沿用原编号重试，不重复生成版本；继续编辑时保留本页文件，支持核对差异、明确保存后续修改或将归档包另存。见 [Skill 保存回执与文件恢复](docs/reliability/skill-saves.md)。

智能体目录改为**按需读取技能资源**：列表和各处候选保留固定版本的方法说明，编辑和执行时再读取完整资源。100 个智能体的合成负载下，目录响应从约 20 MB 降到 275 KB。接口兼容与验收见 [智能体目录按需读取](docs/agent-catalog/implementation.md)。

## 助理闭环已接通

新增**岗位评测契约与业务本体模型**：按 Agent 的冻结身份、职责交付物、标准及可配置权重评分，核对证据完整性和能力边界；本体支持 Agent 抽取、对象类型/实例、关系基数、约束报告、能力映射核对、来源路径检索及带 SHACL/PROV 的 JSON-LD 导出。详见 [岗位评测与 Ontology 优化](docs/ontology-v2/implementation.md)。

新增**每日任务与岗位评测**：工作空间可按时区和每日时间汇总待办、按模板派发指定版本的 Agent 任务，支持待启动或自动运行、同日去重和中断恢复。任务终态按冻结身份、职责及标准自动评分，低分或基础验收失败时产生站内提醒；支持历史补评、阈值配置与确认追溯。详见 [每日任务与岗位评测](docs/operations/implementation.md)。此功能已纳入 1.3.0。

每日计划新增**持久派发请求与排队恢复**：已接受的计划跨日、重启或关闭后续定时后仍能继续原任务；模板变更不会把旧任务显示成新目标。队列繁忙时显示排队，意外错误保留原因并提供“重试原计划”。见 [每日任务的持久派发与恢复](docs/operations/daily-recovery.md)。

[岗位评测提醒收件箱](docs/operations/alert-inbox.md)默认显示未确认提醒，支持按岗位与确认状态筛选、完整历史翻页和原评测追溯。较早提醒不再被最近 200 条记录遮挡；确认后即使读取失败，也保留已处理结果。

当前源码新增**运行复盘与本体 Ontology**：调用所选 Agent 总结运行，经审阅沉淀为知识、工作记忆、经验和能力方法；本体支持概念/属性/关系编辑、来源校验、审核发布、检索扩展及 JSON-LD 导出。详见 [复盘与领域本体](docs/learning/implementation.md)。此功能已纳入 1.3.0。

复盘与本体生成新增**受理时的配置和来源核对**，空间删除后阻止新的审阅写入，保存回复不混入其他页面随后提交的内容；本体属性重绘也保留键盘焦点与输入。见 [生成受理、审阅回执与编辑连续性](docs/learning/acceptance-consistency.md)。

新增**四模块知识库和 Agent 工作流**：知识修订与审计、私有记忆、经验评测发布、能力使用岗位统一管理；工作流节点全部由 Agent 实现，支持对话生成提案、审查保存、依赖执行、上游产物传递、节点授权及持久化恢复。见 [知识库与工作流使用及验收](docs/workflows/implementation.md)。

工作流现支持**可视化画布、端口连线、条件分支与汇合、RAG 检索模板**。查询词和 Top K 会实际约束检索，未选分支不创建任务，保留旧任务恢复兼容。见 [画布、分支与 RAG 使用及验收](docs/workflow-designer/implementation.md)。

工作流设计时可**自主创建专用智能体作为执行节点**：对话设计可按目标提出新智能体，画布内也可直接填写职责和执行指令。审查后保存，智能体与流程一次创建并绑定；取消无新增记录，保存重试不重复创建。见 [流程内创建智能体](docs/workflow-agents/implementation.md)。

任务对话与工作流设计对话采用统一的消息、输入和状态样式：消息正文限制阅读宽度，任务属性按需展开，工作流提案独立审查；支持深浅主题和桌面文字放大。见 [对话界面优化与验收](docs/conversation-ui/implementation.md)。

新建普通任务只需目标与执行智能体；使用该智能体已保存的模型和指令，配置往返保留草稿。具体业务写入提案在执行时授权。Agent、Skills、资料与工作空间提供明确的保存后入口，工作流支持拖动、平移、缩放和手机属性面板。使用边界与验收证据见 [交互与操作动线](docs/interactions/implementation.md)。

新增独立 **Skills 管理模块**：支持标准 `SKILL.md`、资源文件、ZIP 导入导出、版本发布与撤回、Agent 固定版本选择，以及目录 → 正文 → 资源的逐级加载。旧内联方法可迁移为标准包，历史任务继续使用冻结版本。见 [Agent Skills 使用与验收](docs/skills/implementation.md)。

工作台现已支持**工作空间创建、编辑、删除/恢复与切换**，按业务和场景分别管理 Agent、任务、知识与记忆。Agent 的**身份、职责、交付物和执行标准**可直接在表单中编辑，任务冻结智能体版本并保存运行记录，涉及业务写入的工作流保留逐项授权和恢复。使用说明与本次验证见 [岗位与工作空间](docs/workspaces/implementation.md)。

空间删除前会检查**排队消息、未完成执行与正在派发的计划**，显示阻止原因并支持重新检查；提交时再次校验，防止其他页面新增任务后仍被删除。补充回答完成后，旧提问记录不会永久阻止删除。删除与恢复支持重复请求，历史继续保留。见 [工作空间删除与恢复保护](docs/workspaces/deletion-safety.md)。[资料写入保护](docs/workspaces/asset-write-safety.md)进一步阻止删除后的资料发布、本体修订和证据写入；保存失败保留原输入，恢复原空间后可继续。资料保存遇到回复丢失时，可沿用原编号核对与重试，避免重复创建；见[资料保存回执与恢复](docs/reliability/asset-save-recovery.md)。[刷新恢复](docs/reliability/asset-edit-recovery.md)还会保留当前标签页的原保存编号与后续编辑，恢复后由你明确核对或保存。

[资料版本核对](docs/reliability/asset-version-clarity.md)分别显示实际修订版本与来源标签，可展开历史各版正文。审核和评测后的提示指向此次操作的确切版本；目录刷新失败不会把已确认的成功改报为失败。

[知识库搜索恢复](docs/reliability/library-search-recovery.md)明确区分等待、失败和成功结果。搜索失败可重试原关键词或返回上次结果，保留尚未提交的新输入；快速切换查询和页面时，旧回复不会覆盖新结果或抢走当前焦点。

[知识库读取优化](docs/reliability/library-read-performance.md)合并经验评测摘要查询，并按需读取情节记忆正文。在合成基线中，整页读取由 205 次查询降到 3 次，返回内容与可见范围保持一致。

[情节记忆历史浏览](docs/reliability/memory-history.md)支持超过 50 条的记录翻页和摘要搜索。新任务归档时保留当前位置并提示新记录，翻页失败可重试、返回上次结果或从最新记录恢复。

[后台同步与评测记录读取](docs/reliability/reading-interactions.md)保证知识库主动翻页和搜索在后台读取期间仍能响应。评测详情立即显示等待状态，可关闭或重试；旧回复不会重开窗口、替换新记录或覆盖正在编辑的设置。

[全局搜索与结果定位](docs/reliability/command-search.md)分别显示各类资源的读取状态，支持单独重试、结果翻页和保留原选择。正文命中的资料不会被标题过滤丢弃，工作流定义可准确定位；超过 50 条的运行匹配可进入完整历史列表。

[完整流程历史](docs/reliability/workflow-history.md)支持搜索、状态筛选和每页 50 条翻页。工作台待处理与全局搜索覆盖旧流程运行；详情返回保留当前位置，刷新失败可重试，列表使用轻量摘要查询。

[完整评测历史](docs/operations/evaluation-history.md)可按岗位、结论和关键词查询，并切换全部历史。近期评分汇总与历史明细明确区分，较早报告可完整翻页，旧提醒仍追溯原评测依据。

[每日计划与评测设置恢复](docs/operations/settings-recovery.md)区分保存结果与页面读取失败。响应丢失后可只读核对，版本冲突保留输入并展示当前配置，重试读取不会重复创建岗位版本。

[任务完成后的空间删除与接续](docs/reliability/conversation-handoff.md)避免把合法删除后的迟到接续误报为故障；真实恢复错误保留诊断，并继续处理其他对话。空间恢复后仍能沿用原历史追加消息。

空间状态同步新增**过期回复保护与编辑保留**：当前空间被其他页面删除后，保留原地址和提交范围，全局目录仍可打开并明确恢复或切换；旧目录和旧操作回复不能覆盖较新状态。见 [工作空间状态同步与编辑保留](docs/workspaces/state-consistency.md)。

启动登记历史项目时改为**只处理未登记的项目标识**，避免把完整任务正文载入 Python，并保留已配置及已删除空间。合成历史的耗时与内存对比见 [历史项目登记的启动开销](docs/workspaces/registration-performance.md)。

知识版本与受控检索、本人偏好、终态情节、经验候选→离线评测→明确发布/撤回，现在都接入了岗位编译与实际任务。新增通用执行配置，按任务目标与自由填写的工作指令交付内容；已有“变更评估并创建草稿”和“只读知识问答”配置继续兼容。工作台新增“知识与记忆”和运行上下文来源清单。

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

导出需选择新目录，包含 `result.json`、逐事件 `events.jsonl`、证据、上下文及校验清单，有报告时另含 `report.md`；可运行 `python3 -m agent_framework verify-export 导出目录` 校验。默认数据目录 `.agent-data` 包含两个独立 SQLite 数据库：`runtime.sqlite3` 保存运行事实，`mock-business.sqlite3` 模拟外部业务系统。

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

取消请求先持久化，再停止后续动作；对在途写入先核对，无法判断则保留 `NEEDS_REVIEW`。已存在草稿保留并在 `residual_effects` 中列出，不自动删除或声称已回滚。租约仍被其他 worker 持有时保留停止请求，等待当前执行器结束或租约释放后处理，避免并发执行取消清理。

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

这是单机助理框架开发 MVP。SQLite 替代原方案中的 PostgreSQL；已提供 Codex/Cursor CLI 规划适配器、可编译岗位、MCP 受控读取和本机 Web API；尚无模型 HTTP API 适配器、真实 IAM、向量检索或真实业务平台接入。CLI 的 tenant/principal/grant 是本地可信开发输入，不是生产鉴权。业务工具子进程用于执行隔离和超时控制，不是 OS 安全沙箱。

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

新建任务只需填写**任务目标**、选择**执行智能体**，点击“开始任务”即可运行。模型、运行时和可用能力沿用所选智能体的已保存版本，不再逐步选择任务类型、运行时、预算或审查许可。普通任务使用所选 CLI 的登录态直接处理目标，可按需调用智能体已配置的受控读取能力；不会预授予或直接执行业务写入。业务写入继续通过显式工作流的具体提案授权。任务提交使用幂等编号，重复提交返回同一任务；失败保留输入，离开配置页后可以返回继续。

新智能体使用通用执行配置，直接自由填写“执行方式与工作指令”，支持任意业务目标的撰写、整理、分析等任务。外部事实可按需检索和回读，引用必须对应真实读取证据，完成前检查交付内容与来源。通用配置不会生成示例知识或模拟变更数据。模拟运行时只验证流程，会在结果中明确标注未调用真实模型；实际业务分析应选用已配置模型的智能体。普通新任务不再因历史智能体的领域模板被强制套入固定业务链路；智能体角色、手工指令、领域、Skills 和能力范围仍被冻结并提供给模型。历史任务与显式工作流仍使用原执行协议和快照。

普通任务冻结 `task-conversation@1.0.0` 执行协议：每轮直接发起 `execute` 模型调用，返回结果或具体追问，不再依次调用 `plan / decide / compose / request_finish`。只有已绑定的相关 Skills 需要时才额外加载其正文和资源。模型返回普通文本回复时也能正常保存；非法结构化输出继续按配置修复。既有 `model-execution@1.0.0` 与业务工作流快照保留原协议。

同一个任务支持持续追问、补充信息与修改结果。页面把用户消息、智能体公开过程和最终回复串成活动流，底部可继续发送，右侧展示状态、智能体和用量。下一轮携带真实历史消息和交付内容，沿用任务冻结的智能体配置；每轮执行、错误、来源与用量分别留档。历史上下文有长度上限，超限明确标记省略；已失效引用不会再次传给模型。运行中的补充消息按顺序排队，可修改尚未开始的消息、取消排队或停止本轮；刷新和服务重启后继续保留。发送失败保留输入，未发送草稿按任务和身份分别保存在本机，支持导出完整对话。历史任务也不再显示固定的阶段条。

普通任务的公开摘要和回答正文均实时流式显示：CLI 的增量消息会在生成期间解析并保存，通过 SSE 持续推送到页面，正文无需等待整轮结束。结构化输出只提取可展示的 summary 和 result.content，不把 JSON 包装或工具参数当成回答。输入框和光标在输出期间保持稳定；刷新和断线重连会重放已保存的片段，失败或停止后保留片段并标明本轮未完成，格式修复重试不会拼接已拒绝的内容。最终结果仍需通过完整格式和引用校验。

Codex 普通任务使用 CLI app-server 的公开摘要与回答增量通知；Cursor 启用 stream-partial-output 并跳过两种重复 flush 事件；Qoder 启用 include-partial-messages 并读取 text_delta。运行时不支持公开摘要时如实显示等待状态。原始 thinking/reasoning 文本不会被当成公开过程，页面不补造思考链或进度百分比。超时、取消、输出预算超限和租约失效会终止本次模型进程；已经收到的公开过程记录会保留。普通任务只保存实际情节，不套用历史变更工作流生成经验候选。

以下故障恢复演示通过原 CLI / `/api/runs` 使用，新建任务界面不再提供场景选择：

1. **正常流程**：创建并运行，查看“已完成”、三个通过的验收项，以及外部业务库中 1 份草稿 / 1 次创建调用。
2. **写入响应丢失**：选择同名场景，运行自动核对已提交草稿，最终仍为 1 份草稿 / 1 次创建调用。
3. **写后进程中断**：选择同名场景，工作进程在写入后中断；Web 服务继续运行。约 3 秒租约结束后点击“恢复运行”，核对原草稿后完成。也可以先停止并重新启动同一数据目录的 Web 服务，从运行记录恢复同一 ID。不要新建任务代替恢复。
4. **缺少写入授权**：等待 `WAITING_AUTH`，点击“审查并授权”，查看绑定的项目、变更、参数哈希和工具参数，授权后继续。授权不会绕过范围、版本和验收检查。
5. **草稿内容不一致 / 无法核对写入**：查看 `NEEDS_REVIEW` 与原始证据；终态不提供继续写入。缺少材料的 `WAITING_INPUT` 需补充来源后创建新任务，本版不支持在线追加材料。

Web 服务仅支持 `127.0.0.1` 或 `localhost`，校验 Host / Origin，并要求同页面会话令牌和 JSON 请求才能写入；无跨域开放，也不适合作为共享公网服务。服务器固定一个租户，客户端不能更改租户或环境。最多 4 个工作线程、16 个排队/运行任务，同一运行由持久化租约排他执行。取消先保存停止意图，页面在清理结束前显示正在停止；普通模型调用响应停止信号，原生读取在入口、调用前和结果保存前检查持久化请求。已在途的读取可能完成底层操作，但检测到停止后不再交付未保存的结果；已有业务写入先核对，已创建草稿会保留并显示。服务退出时会请求停止当前工作；意外退出后的未决动作由原有恢复机制核对。

慢配置校验、未完成上传和等待回复发送期间，任务读取与停止仍可独立处理；正文接收有总时限，超时不会创建任务。普通配置写入继续按顺序及版本校验处理，见 [慢请求期间的任务控制](docs/reliability/http-responsiveness.md)。

Web API 与原运行时的测试一起执行；HTTP 测试使用临时目录和本机随机端口，不调用真实模型：

```bash
python3 -m unittest discover -s tests -v
```

## 目标运行时配置

打开工作台左侧的“运行时配置”（`http://127.0.0.1:8787/#/runtimes`），可分别配置 **Codex CLI、Cursor CLI、Qoder CLI 和内置模拟运行时**：

- 保存模型 ID、单次模型超时（1–180 秒）、结构化输出修复上限（1–3 次）；Codex 可另选推理强度。
- 选择创建智能体时的默认运行时；新建任务直接使用所选智能体的运行时和模型。
- “检测 CLI”只运行固定的版本查询，显示是否安装及版本；不发送任务、不调用模型，也不代表账号已经登录或拥有所选模型权限。请在终端执行 `codex login` 或 `cursor-agent login` 完成登录。
- 配置按服务租户保存在 `runtime.sqlite3` 的 `runtime_configuration` 中，重启后保留。页面不保存 API Key，不接受任意命令、脚本或额外 CLI 参数。
- 保存采用版本检查，其他页面更新配置后会拒绝覆盖；新建任务检查所选智能体版本，避免使用用户尚未查看的新配置。

任务提交后，所选运行时、模型、超时、输出 Schema 和策略被冻结到运行快照。后来切换默认运行时或修改配置不会改变既有任务；恢复按原快照选择 Codex 或 Cursor 适配器，未决写入仍优先核对原幂等键。原有 Codex 快照格式保持兼容。

Cursor 适配器使用 `cursor-agent --print --mode ask --output-format stream-json --sandbox enabled`，在临时工作空间和独立 CLI 配置下运行；原生 Shell、文件、WebFetch 使用拒绝规则，继承的 MCP 配置以禁用项覆盖，不复制其命令或密钥。内置 Agent 禁用所有 MCP；自定义 Agent 仅开放受控读取代理的工具白名单；未登记效果的旧 MCP 直连不再执行。发现未授权原生工具调用、错误结果、缺失用量或非法 JSON 时停止，不切回其他运行时。Cursor 不接受 `auto` 作为模型 ID，请用 `cursor-agent models` 获取具体 ID。旧版 Cursor 若不返回 input/output token 用量会报 `cursor_usage_unavailable`，需要升级 CLI；不会以零用量绕过预算。CLI 的完整 OS 行为隔离仍取决于安装版本和原生沙箱能力。

## CLI 模型选择与 Agent 配置

工作空间的“资源与设置 → 处理领域”提供独立的领域管理，支持新建、搜索、编辑名称、用途与工作方式、查看关联智能体、归档与恢复。工作方式为最多 4000 字的自由文本，选填且后续可修改；领域不绑定执行模板。各空间独立维护领域。创建智能体时仍可快捷新建，也可保留未保存配置、前往管理并选用后返回。

[快捷创建领域](docs/reliability/agent-domain-creation.md)提交期间锁定当前表单，失败保留输入。服务端已受理但响应丢失时，相同内容的明确重试会选用同一领域；选中的领域可随智能体草稿刷新恢复。

[从智能体前往领域或技能管理](docs/reliability/agent-management.md)时，读取与返回均绑定原编辑会话。关闭后重新打开配置，旧回复不会带走新窗口；等待读取时的后续输入保留，选定领域或技能版本后返回原配置，尚不自动保存。

选择领域不会重置智能体的职责、工具、验收规则或手工指令。在智能体“模型与指令”中自由填写执行方式与工作指令；领域工作方式作为冻结的工作指导进入模型上下文，不绑定执行模板，也不授予额外工具或写入权限。旧领域会迁移为自由文本工作方式并生成新版本，已有智能体和任务保留原快照。

智能体显式保存选用的领域版本。领域编辑与归档不会改写已有智能体或历史任务；编辑智能体时可以主动“采用最新配置”。已归档领域停止新的选用，已有智能体仍可保留原版本并继续使用。领域接口的更新和归档均检查版本，避免不同页面互相覆盖配置。

打开 [运行时配置](http://127.0.0.1:8787/#/runtimes)，选择 Codex、Cursor 或 Qoder。模型下拉框分别通过 `codex app-server` 的 `model/list`、`cursor-agent models` 和 `qodercli --list-models` 获取，显示来源及数量，支持“刷新模型”。Qoder 同时识别 `qoder` 命令别名。目录按租户缓存 5 分钟，浏览器沿用服务端读取时间核算剩余有效期；读取失败会显示错误，不生成静态替代列表。目录中的模型是否可用，仍由实际模型调用时的账号权限判定。

Qoder 复用本机 CLI 登录态，先在终端执行 `qodercli login`（命令为 `qoder` 的安装使用 `qoder login`）。可设置默认运行时、CLI 模型、单次超时与结构化输出修复上限。旧版运行时配置会补齐 Qoder 配置项，保留原默认值和版本。调用使用非交互 JSON 消息流、独立工作目录、禁用内置工具及继承的设置/Hook/插件，只按任务冻结配置开放受控只读 MCP。模型输出经本地 Schema 验证；认证、超时、工具越界或缺失 token 用量均显式失败。任务恢复沿用冻结的 Qoder 模型与策略。

点击“基于此运行时创建 Agent”，或进入 [智能体 Agent](http://127.0.0.1:8787/#/agents)：

1. 绑定运行时、CLI 模型、超时、结构化输出修复上限，以及 Codex 模型支持的推理强度。
2. 填写角色 Prompt，添加并启用 Skill 的名称和方法说明。当前 Skill 为内联说明，不自动安装或执行任意 Skill 包脚本。
3. 编辑“岗位定义与能力绑定”，配置身份、职责、标准和能力引用；如需原生 MCP，在 `native_read_refs` 中选择已登记 READ 能力。保存后点击“检查编译”。旧 stdio / HTTP 直连字段仅供迁移，启用它们会阻止新任务编译。
4. 保存后可编辑、复制、归档或恢复使用。配置按版本保存，编辑冲突会拒绝覆盖。
5. 新建任务时选择 Agent，运行时和模型随 Agent 绑定。点击开始即使用所选模型与已配置的受控读取能力，创建时不授予业务写入权限。提交时冻结完整配置；后续编辑或归档不改变旧任务恢复所用的版本。

Prompt、结构化岗位定义和启用 Skill 进入模型规划上下文。新原生 MCP 由 `ReadCapabilityProxy` 暴露任务范围内的模拟读取，记录当前授权、租约、预算、审计和证据。业务写入仍由结构化提案进入 Gateway；任意 MCP/CLI 不能直接写入。

旧版独立示例 [mock_facts_mcp.py](examples/mock_facts_mcp.py) 保留供协议测试和历史记录解释；新任务不再按任意端点配置直接启动它。迁移方式与完整模拟矩阵见 [P0 实施说明](docs/p0/implementation.md)。

配置说明、API、权限边界和验收记录见 [docs/agents.md](docs/agents.md)。

真实模型任务仍需逐次勾选上下文发送许可。Codex 使用 OpenAI 模型服务；Cursor 和 Qoder 使用各自 CLI 对应的模型服务与登录态，选择前请确认上下文获准发送。配置保存和版本检测不需要该许可，也不会发送任务。

CLI 可显式选择运行时；下面会真实发送任务，仅在获准后执行：

```bash
python3 -m agent_framework --planner cursor --model YOUR_CURSOR_MODEL demo
python3 -m agent_framework --planner qoder --model YOUR_QODER_MODEL demo
# 恢复已有任务时自动使用原来的运行时与模型
python3 -m agent_framework resume run-xxx
```

Web 界面保存的默认值用于 Web 新任务；CLI 新任务继续默认使用模拟规划器，显式 `--planner` / `--model` 才会选择真实运行时。

配置 API 为 `GET/POST /api/runtime-config`，本机版本检测为 `POST /api/runtime-config/detect`。写入继续要求本页面令牌、同源 JSON 请求和服务端固定租户。

参考：[Cursor CLI 配置](https://cursor.com/docs/cli/reference/configuration)、[权限](https://cursor.com/docs/cli/reference/permissions)、[输出格式](https://cursor.com/docs/cli/reference/output-format)；[Qoder 脚本调用](https://docs.qoder.com/cli/run-in-scripts)、[命令参数](https://docs.qoder.com/cli/cli-reference)、[消息协议](https://docs.qoder.com/cli/sdk/references-typescript)。

## P0 岗位与动作治理

新任务已使用岗位编译快照和统一效果契约；旧任务保留原快照恢复路径。运行命令、迁移边界与模拟验证见 [P0 实施说明](docs/p0/implementation.md)。

```bash
python3 -m agent_framework.p0_evaluate
```

## 可靠性检查与浏览器回归

普通任务的检查分衡量交付结构、引用和执行边界；目标达成质量需人工或专项验收。离线演示不计入评分。新版本本体发布后成为生效版本，撤回时不会自动启用旧版；旧版可在列表中明确启用。

本体的“断言证据”可为概念、关系、属性约束和实例保存逐字原文、位置及人工核对。失败生成若保留了可编辑结构，可从生成记录创建修复草稿；修复不再次调用模型，保存和沉淀仍执行全部约束检查。

开发环境先安装 Python 项目依赖、Node.js 22+ 和本机 Chrome，再运行：

```sh
npm ci
npm test
python3 scripts/run_browser_tests.py
python3 scripts/run_browser_tests.py --suite ontology --suite audit-fixes
```

浏览器脚本自动创建临时数据库、合成模型服务和随机本机端口，并在结束时停止服务。结果路径会打印到终端。兼容历史业务模块的额外测试可使用 `--suite legacy-modules`；这部分夹具经公开 API 建立，不代表当前普通任务存在旧的场景/预授权向导。

构建候选后，先准备对应 Python 与平台的依赖 wheel，再验证全新环境中的实际安装及启动。校验本身离线执行，报告不可覆盖：

```sh
python3 -m pip download --only-binary=:all: --no-deps --dest /tmp/agent-wheelhouse PyYAML==6.0.3
python3 scripts/verify_release.py /tmp/agent-source-candidate/agent-framework-1.4.0.tar.gz \
  --wheelhouse /tmp/agent-wheelhouse --report /tmp/agent-source-verification.json
```

在开发依赖已齐全时可加 `--browser-check`，让浏览器验收直接访问安装后的服务。也可传入候选 wheel；该模式使用当前源码中的启动脚本，报告会注明与归档自带脚本验收的区别。

交付验收会在同一外部数据目录执行两次真实重启，核对配置、Agent、任务结果、提交回执及草稿删除版本，并检查旧请求重放不会回退配置或重复创建任务。随后用安装后的 CLI 备份并恢复到新目录，启动恢复后的服务进行浏览器验收。开启 `--browser-check` 时，浏览器新建的工作流还会再经历一次进程重启与一轮备份还原。最新结果见 [1.4.0 发布验收](docs/release/verification-1.4.0.md)。

原版升级与备份回退可独立复现，始终使用临时数据目录：

```sh
python3 scripts/verify_upgrade.py dist/agent-framework-1.3.0.tar.gz dist/agent-framework-1.4.0.tar.gz \
  --wheelhouse /tmp/agent-wheelhouse --report /tmp/agent-upgrade-verification.json
```
