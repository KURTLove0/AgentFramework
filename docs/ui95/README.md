# 全应用 UI 与动线验收

2026-10-24，固定量表工程自评 **95/100**，达到95分目标；5项硬门槛全部通过。此前撤回的96分结论不恢复，本次采用改进前固定的50项量表、当前源码指纹和逐项证据。

量表 SHA256：`ee03604ffa8cfb15e7744b08cc7a84077a4de0ca7e0915eddcfa70d6ac51bfda`。完整逐项结果见 [final-score.json](final-score.json)，源码、执行时间和12组最终浏览器回归见 [final-run.json](final-run.json)。

## 完成的改进

- 清理空工作台重复引导；统一11模块的页头、字号、工具栏、状态和浅深主题。知识库与能力目录优先呈现业务内容。
- 长弹窗正文可滚动，底部操作实际可达；修正手机工作流保存区、按钮图标和文字按钮高度。
- 表单就近报错并聚焦首项，失败保留输入；设置、画布和复盘统一保护未保存修改。保存中防重复操作，切页仍正确接收回执。
- 空间URL携带明确上下文，前进/返回和重开深链接恢复正确空间；404记录与服务断线分别处理。
- 岗位更新后明确提示流程重新选择版本；缺材料、失败、取消和中断任务提供准确下一步，保持原有授权与写入核对。

## 当前证据

| 验收 | 当前结果 |
| --- | --- |
| [页面与动态弹窗](layout-results.json) | 540组合、6尺寸、浅深主题；0关键裁切/小目标/缺名称/小字/低对比/底部不可达 |
| [200%文字](text-resize-results.json) | 25状态，375×812，0不可达 |
| [完整模块闭环](module-results.json) | 12项通过 |
| [画布、版本更新与复盘编辑](canvas-learning-results.json) | 6项通过，真实指针/键盘及分支执行 |
| [状态与反馈](behavior-results.json) | 10项通过 |
| [空间管理与导航](navigation-results.json) | 7项通过 |
| [跨空间历史与重开链接](workspace-history-results.json) | 通过 |
| [任务恢复](recovery-results.json) | 5项通过，恢复后原草稿仍为1份、创建调用不增加 |
| [运行时配置](runtime-results.json) | 3项通过 |
| [既有Agent动线](agent-flow/browser-results.json) / [纯键盘](agent-flow/keyboard-results.json) | 22项 / 5项通过 |
| [按钮视觉回归](buttons/visual-results.json) | 12组空状态/页头 + 40组已有内容；旧样式负例可检出；正常/悬停/焦点/按下/禁用/提交均通过 |
| [服务端访问与空间边界](backend-boundaries.log) | 24项既有回归通过 |
| [当前前端交互测试](ui-tests.log) | 8个文件全部通过，51个Node测试项；另含文件内场景断言，不混算成用户操作样本 |
| [技能导出内容](export-verification.json) | ZIP完整，包含SKILL.md与资源文件 |
| [当前8787应用只读核对](live-results.json) | 21个页面资源与源码SHA256一致，11模块，0写请求/页面错误 |

## 固定量表评分

| 类别 | 得分 |
| --- | --- |
| 视觉与信息层级 | 24/24 |
| 导航与发现 | 11/12 |
| 完整操作动线 | 29/32 |
| 状态与恢复 | 20/20 |
| 可访问性与输入方式 | 11/12 |

五项扣分均为非关键验证范围限制：跨空间长列表精确滚动位置（N04）、Skill复制及部分关闭分支的实机覆盖（J08）、资料撤回与私有偏好组合（J09）、所有目录的原生输入法组合（J15）、全部浮层/原生控件边界对比（A03）。核心操作已通过对应测试，没有以扣分代替修复阻断问题。

| 项目 | 得分 | 结果与证据 |
| --- | --- | --- |
| V01 每页标题、用途与一个主操作清楚；次要动作不争抢视觉优先级 | 2/2 | 页头明确用途和主动作；次要操作使用轻量样式，同一创建动作可在空状态重复提供。 [screenshots/matrix/empty-workbench-light-1440.png](screenshots/matrix/empty-workbench-light-1440.png)、[screenshots/matrix/empty-registry-light-1440.png](screenshots/matrix/empty-registry-light-1440.png)、[layout-results.json](layout-results.json) |
| V02 系统字体和字号层级一致；普通正文至少14px、次要信息至少12px | 2/2 | 保留平台系统字体，消除9–11px规则；正文与辅助信息层级经实际渲染检查。 [layout-results.json](layout-results.json)、[text-resize-results.json](text-resize-results.json) |
| V03 工作台首屏优先呈现可执行下一步，空列表不重复堆叠介绍区 | 2/2 | 空工作台只显示一个任务引导，移除重复空列表和零值统计。 [behavior-results.json](behavior-results.json)、[screenshots/matrix/empty-workbench-light-1440.png](screenshots/matrix/empty-workbench-light-1440.png) |
| V04 数量、状态、空值来自真实数据；模拟执行和真实模型范围清楚 | 2/2 | 数量来自服务数据；MOCK、模拟业务、真实模型发送许可都有明确说明。 [module-results.json](module-results.json)、[recovery-results.json](recovery-results.json)、[screenshots/matrix/populated-workbench-light-1440.png](screenshots/matrix/populated-workbench-light-1440.png) |
| V05 浅色与深色的文字、状态、控件边界可辨；不只靠颜色传达状态 | 2/2 | 浅深主题都检查文字和状态，成功/警告含文字及图标。 [layout-results.json](layout-results.json)、[screenshots/matrix/populated-daily-dark-375.png](screenshots/matrix/populated-daily-dark-375.png) |
| V06 表单有持久标签、必要帮助与约束说明；高级选项按需展开 | 2/2 | 持久标签、必填说明、错误关联与高级选项披露；任务演示场景移入高级选项。 [behavior-results.json](behavior-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json) |
| V07 所有弹窗头部、内容、操作区有稳定边界；长内容可滚动且不遮挡操作 | 2/2 | 长表单独立滚动，工作流头尾固定；所有可见底部按钮逐项滚动并实测命中。 [layout-results.json](layout-results.json)、[text-resize-results.json](text-resize-results.json) |
| V08 11个路由及弹窗在320/375/414/768宽度可用；无页面级水平滚动和关键控件裁切 | 2/2 | 11路由及静态/生成后弹窗在6尺寸、浅深主题中无关键裁切。 [layout-results.json](layout-results.json) |
| V09 长中文、长名称与标识可读；200%文字时内容和操作仍可到达 | 2/2 | 长中文与标识可换行或按用途披露；25状态下HTML文字和行高放大200%仍可到达操作。 [text-resize-results.json](text-resize-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json) |
| V10 按钮图标和文字对齐；主要操作至少44px；单行动作不意外换行或增高 | 2/2 | 主要按钮44px，图标18px且继承文字色；文字按钮对齐回归已修正，旧样式负例可检出。 [buttons/visual-results.json](buttons/visual-results.json)、[layout-results.json](layout-results.json) |
| V11 面板、列表、徽标、空状态、工具栏使用统一样式与语义颜色 | 2/2 | 复用System Blue变量、语义状态、面板与工具栏，浅深页面一致。 [layout-results.json](layout-results.json)、[screenshots/matrix/empty-skills-light-1440.png](screenshots/matrix/empty-skills-light-1440.png) |
| V12 数据密集页面可扫描；详情、技术标识和原始JSON不抢占主要阅读路径 | 2/2 | 知识库轻量页签；能力目录先读职责与工具名，原始规则/版本/JSON按需展开。 [screenshots/matrix/populated-library-knowledge-light-375.png](screenshots/matrix/populated-library-knowledge-light-375.png)、[screenshots/matrix/empty-registry-light-1440.png](screenshots/matrix/empty-registry-light-1440.png) |
| N01 11个模块分组和当前页状态清楚；侧栏键盘可达 | 2/2 | 11模块导航、当前页语义及手机焦点约束均通过。 [navigation-results.json](navigation-results.json)、[layout-results.json](layout-results.json) |
| N02 命令面板可搜索并到达全部模块；空结果可恢复，方向键与Escape正确 | 2/2 | 命令搜索可发现所有模块，键盘进入、Escape关闭与前后退通过。 [navigation-results.json](navigation-results.json)、[agent-flow/keyboard-results.json](agent-flow/keyboard-results.json) |
| N03 当前空间始终明确；切换后内容隔离，旧请求不会覆盖新空间 | 2/2 | 空间切换预检查后打开明确空间URL，内容隔离并恢复正确目录。 [navigation-results.json](navigation-results.json)、[workspace-history-results.json](workspace-history-results.json) |
| N04 深链接、浏览器前后退和详情返回保持正确上下文与页面位置 | 1/2 | 任务深链接、跨空间Back/Forward和新页重开均通过；未逐一实机验证超长列表跨空间返回的精确滚动位置。 [workspace-history-results.json](workspace-history-results.json)、[ui-tests.log](ui-tests.log) |
| N05 保存、关闭、切页后焦点落在有意义且可见的位置 | 2/2 | 通知关闭返回有效焦点，配置保存及编辑返回保持有意义的操作上下文。 [behavior-results.json](behavior-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json)、[ui-tests.log](ui-tests.log) |
| N06 首次使用帮助围绕创建空间、智能体、任务及查看结果；缺前置条件时有直达入口 | 2/2 | 帮助包含真实创建入口；无Agent时工作流直达前置配置。 [behavior-results.json](behavior-results.json) |
| J01 空间创建、编辑、进入、删除和恢复有明确回执及后续入口 | 2/2 | 创建、编辑、明确进入、隔离、删除恢复及服务端重名定位完整通过。 [navigation-results.json](navigation-results.json) |
| J02 智能体用途选择、自建领域、三步配置、保存与开始使用衔接完整 | 2/2 | 用途预设、自建领域、三步配置、保存与使用的真实浏览器闭环通过。 [agent-flow/browser-results.json](agent-flow/browser-results.json)、[module-results.json](module-results.json) |
| J03 任务草稿、配置往返、字段校验、失败重试与双击防重入有效 | 2/2 | 任务字段错误、提交失败重试、配置往返及重复提交保护通过。 [agent-flow/browser-results.json](agent-flow/browser-results.json)、[ui-tests.log](ui-tests.log)、[buttons/visual-results.json](buttons/visual-results.json) |
| J04 待授权、待材料、失败、中断、取消均展示合适的下一步，保留原执行事实 | 2/2 | 待授权、缺材料、失败、取消、写后中断恢复均在独立空间实际执行；中断恢复保留一个原草稿。 [recovery-results.json](recovery-results.json) |
| J05 运行列表可筛选；结果、来源、验收、轨迹之间切换不会被刷新覆盖 | 2/2 | 运行筛选可恢复，完成后优先显示报告与来源；手动页签不被轮询覆盖。 [agent-flow/browser-results.json](agent-flow/browser-results.json)、[buttons/visual-results.json](buttons/visual-results.json)、[recovery-results.json](recovery-results.json) |
| J06 工作流画布添加、配置、连接、分支与缩放可操作，手机上有可达的配置入口 | 2/2 | 真实拖动、键盘微调、端口连线、分支、汇合、缩放与手机配置入口通过。 [canvas-learning-results.json](canvas-learning-results.json)、[layout-results.json](layout-results.json) |
| J07 工作流对话、提案审阅、保存、启动与运行详情衔接；明确模型许可 | 2/2 | 对话澄清→提案→画布审查→保存→启动→结果可完成；提案未自动运行或授权。 [module-results.json](module-results.json)、[canvas-learning-results.json](canvas-learning-results.json) |
| J08 Skill草稿、资源文件、校验、发布、撤回、复制、导入导出与未保存处理可完成 | 1/2 | 草稿、资源、校验、发布、撤回、导入导出均实际完成；复制及部分未保存分支由交互测试覆盖，本轮未逐一实机覆盖。 [module-results.json](module-results.json)、[export-verification.json](export-verification.json)、[ui-tests.log](ui-tests.log) |
| J09 资料草稿、修订、审核发布、撤回与来源检索形成闭环；私有偏好范围清楚 | 1/2 | 资料草稿、修订、审核发布与引用来源闭环通过；撤回和私有偏好组合主要由当前交互测试覆盖，实机覆盖仍有限。 [module-results.json](module-results.json)、[ui-tests.log](ui-tests.log) |
| J10 复盘与本体的来源选择、生成、审阅、保存、沉淀和发布入口可达 | 2/2 | 复盘与本体生成、人工审阅、保存沉淀、审核发布及浏览入口通过。 [module-results.json](module-results.json)、[canvas-learning-results.json](canvas-learning-results.json)、[layout-results.json](layout-results.json) |
| J11 每日计划配置、预览、派发、受阻处理与任务回跳清楚；不产生重复派发 | 2/2 | 计划配置、生成、派发、重复派发去重及待启动任务回跳实际通过，演示定时开关保持关闭。 [module-results.json](module-results.json)、[layout-results.json](layout-results.json) |
| J12 评测设置、岗位契约、执行明细、低分提醒、确认与证据回跳完整 | 2/2 | 失败历史评分、提醒明细、确认已阅、空间阈值与岗位契约保存通过；旧流程明确要求重选岗位版本。 [module-results.json](module-results.json)、[canvas-learning-results.json](canvas-learning-results.json) |
| J13 运行时配置可选择提供方、调整模型参数、保存并返回任务；故障说明可操作 | 2/2 | 运行时提供方和参数校验、等待冻结、保存回执、失败保留与重试通过，任务配置往返完整。 [runtime-results.json](runtime-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json) |
| J14 能力与标准可按领域与版本理解，先读业务说明，再按需查看技术结构 | 2/2 | 职责、工具读写边界与业务说明优先；版本和技术规则保留披露入口。 [screenshots/matrix/empty-registry-light-1440.png](screenshots/matrix/empty-registry-light-1440.png)、[layout-results.json](layout-results.json) |
| J15 目录搜索、筛选和空结果有清除入口；刷新不抢走输入焦点或打断输入法 | 1/2 | 运行与Agent筛选、无结果恢复和轮询保护通过；所有目录的原生中文输入法组合未逐项实机复核。 [agent-flow/browser-results.json](agent-flow/browser-results.json)、[buttons/visual-results.json](buttons/visual-results.json)、[ui-tests.log](ui-tests.log) |
| J16 资料、Skill、配置等跨模块往返保留原任务或智能体编辑上下文 | 2/2 | 任务直达配置再返回保留目标和预算，重新采用版本并审查许可；跨模块返回有交互回归。 [agent-flow/browser-results.json](agent-flow/browser-results.json)、[ui-tests.log](ui-tests.log) |
| S01 成功反馈持久且有下一步；浮动提示不遮挡焦点和主要操作 | 2/2 | 保存后持久下一步、页内顶部提示与弹窗内提示可见，不遮挡主要操作。 [behavior-results.json](behavior-results.json)、[buttons/visual-results.json](buttons/visual-results.json) |
| S02 提交期间有文字反馈、防重复提交；禁用和加载视觉一致 | 2/2 | Agent保存尺寸稳定；运行时保存冻结字段，双次提交只发一次，切页仍正确接收回执。 [buttons/visual-results.json](buttons/visual-results.json)、[runtime-results.json](runtime-results.json)、[ui-tests.log](ui-tests.log) |
| S03 错误就近展示、关联字段并可聚焦；失败保留输入，修正后错误清除 | 2/2 | 首个无效字段自动聚焦，中文错误与字段关联；原生约束和服务端重名错误都保留输入并可修正。 [behavior-results.json](behavior-results.json)、[navigation-results.json](navigation-results.json)、[runtime-results.json](runtime-results.json) |
| S04 写入成功后刷新失败仍保留权威回执，不误报保存失败或重复写入 | 2/2 | 保存成功与列表刷新分开处理；资源回执失败分支有当前交互测试，运行时切页后的权威回执实际验证。 [ui-tests.log](ui-tests.log)、[runtime-results.json](runtime-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json) |
| S05 所有可编辑对话框关闭/切换有未保存处理，提交中不能意外退出 | 2/2 | 任务、Agent、资源与配置有编辑保护；设置、画布和复盘使用统一继续编辑/放弃确认。 [behavior-results.json](behavior-results.json)、[canvas-learning-results.json](canvas-learning-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json)、[ui-tests.log](ui-tests.log) |
| S06 初次读取与切页加载有可理解反馈，旧页面内容不伪装成当前页 | 2/2 | 切页清除旧内容，显示目标模块和读取状态；等待请求的真实场景通过。 [behavior-results.json](behavior-results.json) |
| S07 首次空白、筛选无结果、无权限、无前置配置有不同的文案和恢复动作 | 2/2 | 首次空白、筛选无结果、缺少Agent和当前空间找不到记录均提供相应恢复动作。 [behavior-results.json](behavior-results.json)、[navigation-results.json](navigation-results.json)、[buttons/visual-results.json](buttons/visual-results.json) |
| S08 服务断开、超时和读取失败提供重试入口，恢复后提示正确清除 | 2/2 | 读取503可重试，恢复后清除错误；配置保存503保留输入；有效HTTP记录错误不会误报离线。 [behavior-results.json](behavior-results.json)、[runtime-results.json](runtime-results.json)、[navigation-results.json](navigation-results.json)、[ui-tests.log](ui-tests.log) |
| S09 配置许可和业务授权保持独立；变更执行上下文后重新审查 | 2/2 | 模型发送许可、MCP许可与业务写入授权保持独立；变更配置后重新审查，不自动继承授权。 [agent-flow/browser-results.json](agent-flow/browser-results.json)、[recovery-results.json](recovery-results.json)、[ui-tests.log](ui-tests.log) |
| S10 无效、冲突、未知结果和部分失败不会静默丢失；给出安全后续动作 | 2/2 | 保存冲突、刷新失败和未知写入结果保留事实；岗位旧版本明确提示，恢复核对不重写。 [canvas-learning-results.json](canvas-learning-results.json)、[recovery-results.json](recovery-results.json)、[ui-tests.log](ui-tests.log) |
| A01 主要动线全程键盘可完成；弹窗焦点约束、Escape和关闭后恢复正确 | 2/2 | 纯键盘创建与使用、手机导航焦点24次循环、Escape、配置返回与画布微调通过。 [agent-flow/keyboard-results.json](agent-flow/keyboard-results.json)、[navigation-results.json](navigation-results.json)、[canvas-learning-results.json](canvas-learning-results.json) |
| A02 控件名称、表单标签、错误关联、状态播报和当前页语义完整 | 2/2 | 布局扫描未发现可见控件缺名称；字段错误aria关联、当前页和运行状态播报有实际及交互证据。 [layout-results.json](layout-results.json)、[behavior-results.json](behavior-results.json)、[buttons/visual-results.json](buttons/visual-results.json)、[ui-tests.log](ui-tests.log) |
| A03 实际渲染文本对比至少4.5:1，必要控件边界/焦点至少3:1，覆盖浅深主题 | 1/2 | 540状态有效背景合成后的文本对比均通过；代表控件的边界/焦点通过，但未穷举所有浮层和原生控件边界。 [layout-results.json](layout-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json)、[buttons/visual-results.json](buttons/visual-results.json) |
| A04 200%文字、减少动态效果及小屏低高度下仍可到达字段与操作 | 2/2 | 200%文字25状态、320宽、375低高度和减少动态效果可达性通过；文字放大方法与浏览器缩放明确区分。 [text-resize-results.json](text-resize-results.json)、[layout-results.json](layout-results.json)、[behavior-results.json](behavior-results.json) |
| A05 授权与删除等操作有可审查范围；模拟与真实能力的描述准确 | 2/2 | 授权审查具体任务范围、参数与环境；删除可审查影响并恢复；模拟描述与真实发送许可准确。 [recovery-results.json](recovery-results.json)、[navigation-results.json](navigation-results.json)、[agent-flow/browser-results.json](agent-flow/browser-results.json) |
| A06 画布拖动等指针操作有键盘或点击替代；图标动作有可见或可访问名称 | 2/2 | 画布指针拖动有键盘与配置操作替代；图标动作有名称，移动与连线实际完成。 [canvas-learning-results.json](canvas-learning-results.json)、[layout-results.json](layout-results.json) |

## 范围与复核方式

- 实机范围为本机 Chrome；未声称已验证 Safari、Firefox、移动操作系统或辅助阅读器。
- 200%为一次性翻倍HTML计算字号与行高，视口375×812；不冒称浏览器缩放或所有尺寸交叉覆盖。
- 业务工具与生成流程使用模拟运行时，定时功能的验收配置未开启真实周期执行；用户数据与8787配置未被验收脚本写入。
- 五项非关键证据范围限制已逐项扣分，未把未覆盖分支算作完整满足。

实测覆盖320×812、375×812、414×896、768×1024、1440×1000及812×375。画布只在标注区域内平移，页面本身不横向滚动。截图人工复核包含11模块的主要页面、授权审查、角色契约、技能编辑、流程画布、复盘及本体浏览。

在8799隔离模拟服务运行时，以已配置的Playwright环境执行 `node tests/run_ui95_final.cjs`；测试需准备 `/tmp/ui95-import.zip` 标准导入包（目录ui95-imported，SKILL.md与references/checklist.md）。`node --test tests/test_*.js` 执行交互回归。失败后保留日志；只有应用源码未改变时可用 `UI95_RESUME=1` 继续剩余验收。

最终验收不写用户8787数据。应用保留本机访问方式：[打开应用](http://127.0.0.1:8787/)。源码变化由刷新页面获取，本轮不重建1.2.0发行包。
