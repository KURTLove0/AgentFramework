# 全功能 UI 与交互动线独立评审

2026-10-25。本轮由独立评审 Agent `ui_review` 负责呈现评分，`journey_review` 负责独立动线探索，主 Agent 与 `history_fix` 负责实现。评审 Agent 未修改产品代码。

**独立评审最终97/100，通过；P0/P1/P2未解决项为0。** [评审报告](reviewer/final-report.md)、[逐项评分](reviewer/final-score.json)、[36项覆盖与证据归属](reviewer/coverage-status.json)、[完成审计](completion-audit.json)。旧工程自评分数不作为本轮通过依据。

## 评分与覆盖

- [冻结量表](reviewer/rubric.v1.json)，总分100，通过线95；[覆盖计划](reviewer/coverage-plan.md)。量表 SHA256：`7cd7cfae976a663d3a5f906ca2e653271659ea9f44a6ba69d6da5e6bfd01f13f`。
- 覆盖11模块：工作台、运行记录、Agent、工作流、Skills、知识库、每日任务、岗位评测、工作空间、能力与标准、运行时配置。
- 除目录与空状态，还检查创建、编辑、保存、发布/撤回、生成结果、授权、故障恢复、跨模块返回、浅深主题、手机和键盘操作。未观察的必测状态不能补满分；P0/P1不能被平均分掩盖。
- [最终候选逐文件指纹](implementation/candidate-source.json)，[本轮最初源码](implementation/baseline-source.json)。截图与操作记录保留在 reviewer/ 和 journeys/。

## 已修正的问题

| 问题 | 修正与当前证据 |
| --- | --- |
| 保存请求发出后仍可输入，响应成功会丢掉晚输入 | 统一提交保护，等待期间锁定控件、防重复提交和误关；失败后恢复输入与焦点。[原始复现](implementation/pending-baseline.json)、[成功等待保护](implementation/pending-results.json)、[失败恢复](implementation/async-form-results.json) |
| 评测记录跳转后旧弹窗仍遮住详情 | 关闭记录弹窗再导航，并把焦点交给原运行详情。[独立复核](journeys/results.json) |
| 跨空间后退丢失长列表位置 | 按空间、路由和历史条目恢复；新空间/新标签从顶部开始；缩短列表与坏数据安全处理。[23项验证](history-fix/results.json)、[独立复核](journeys/history-results.json) |
| “跳至主要内容”错误切到工作台 | 保留当前路由与历史，直接移动主内容焦点。[键盘实测](history-fix/results.json) |
| 每日受阻计划摘要过时、缺少恢复入口 | 显示当前派发/受阻计数；无已派发任务时可调整并重生成，已有任务时保留冻结事实并提供今日补充任务入口。[两类恢复闭环](journeys/daily-recovery-results.json) |
| 新恢复区说明在桌面右侧裁切 | 约束恢复区整行布局和说明换行。[10组手机/桌面浅深验证](implementation/blocked-layout-results.json) |
| 本体校验折叠错误区域，手机真实对象表单被撑宽 | 保留披露、输入和焦点；错误可展开定位；长来源在控件内滚动。[10项定向验证及8组布局](ontology-form/results.json) |

## 实现验证

详见[实现验证汇总](implementation/verification-summary.json)和[独立动线汇总](journeys/verification-summary.json)。

- 12条跨模块闭环通过；Skill复制、版本切换/放弃、归档恢复、私有偏好、配置往返和搜索组合事件另有独立实机证据。
- 540组页面/弹窗布局通过；新增受阻恢复区10组通过。
- 52组按钮视觉组合通过；原按钮样式负例保持可检出。
- 3类提交成功等待保护、5类失败输入恢复、8类任务终态与恢复通过。
- 本体表单10项定向验证通过，真实对象/关系/能力映射在320/375/414/768与浅深主题8组布局通过。
- 历史与键盘跳转23项、独立动线22项通过。
- 8个前端交互测试文件、51个Node测试项通过。文件内部场景断言不混算为独立用户样本。
- [当前用户应用只读核对](implementation/live/live-results.json)：21个资源与最终源码一致，未发送写请求，页面异常为0。

自动化回归只作为功能与几何证据；独立评审另行目视呈现和实际操作，不能用上述通过数直接推导视觉分数。

剩余5项均为P3轻微建议，已扣分：资料类型切换标题、手机画布工具区高度、部分状态说明重复、资源元数据间距、偏好JSON错误摘要关联。它们不阻断主要动线，详细影响和扣分见独立评分文件。

## 运行与边界

用户应用保持在 [127.0.0.1:8787](http://127.0.0.1:8787/)，刷新可加载修正。8799和8800临时评审服务已关闭；本轮仅使用各自隔离的模拟数据，不写用户8787数据、不调用真实模型。业务授权、发送许可、冻结版本与派发去重语义保留。

本轮浏览器实机以本机 Chrome 为主；浏览器组合事件不等同于操作系统输入法的全量验证。分数属于本轮独立 Agent 按固定范围的工程评审，不等同于独立人类用户研究或跨平台认证。
