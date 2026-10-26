# 智能体目录与交互动线改版

本次将智能体页面调整为「紧凑目录 → 独立详情 → 创建任务」。产品经理 Agent 使用实现前固定的 [25 项量表](pm-rubric.md) 逐轮复评，达到 95/100 且没有阻断问题才停止。评审结果为 **62 → 93 → 98/100**，达到阈值后已停止优化。报告见 [第 0 轮](round-0.md)、[第 1 轮](round-1.md)、[最终第 2 轮](round-2.md) 及 [最终评分](final-score.json)。测试通过数不直接换算评分。

## 实现

- 目录：名称/用途、真实可用或归档状态、领域、执行方式；支持搜索、状态/领域/执行方式筛选及最近更新、名称、最早创建排序。进入详情后返回保留查找上下文。
- 详情：可直接打开或刷新 `#/agents/:id`；概览、工作指令、技能、任务记录有各自链接。配置摘要与技术信息分层，主要任务操作可直接选择当前智能体。
- 配置：创建后进入详情；编辑可直达指令或技能分区，失败保留输入，保存后生成新版本。归档后隐藏编辑与新任务入口，恢复后才能继续使用。
- 运行：列表接口补充冻结的 `agent_id` 和 `agent_revision`，任务历史只显示当前空间最近 200 条记录中属于该智能体的真实运行。旧任务不补造所属身份。
- 可访问性：浅深色、手机布局、长名称、200%文字、键盘页签与披露均有验收材料。手机表格视觉调整仍保留列头、行、单元格与详情链接语义。

## 参考边界

2026-10-26 公开打开 [参考页](https://multica.ai/kl/agents) 会进入 [登录页](https://multica.ai/login)。因此没有声称看到 KL 私有工作空间的在线布局或数据。结构参考来自本机 Multica 的 `packages/views/agents/components/agents-page.tsx`、`agent-list-toolbar.tsx`、`agent-detail-page.tsx`、`agent-overview-pane.tsx`；这不保证与在线部署版本完全一致。本项目保留自身业务、配色和授权规则，没有照搬不存在的在线状态、所有者或统计。

## 验证与限制

本地预览使用独立的临时数据目录；全部业务工具仍为模拟实现，没有修改原有工作空间数据。界面检查结果记录于 [browser-results.json](browser-results.json)、[运行日志](browser-run.log)，截图在 [screenshots](screenshots/)。手机可访问树保存于 `mobile-accessibility-tree.yml`。

既有三步创建、字段校验、保存/任务失败重试、配置往返、授权重审和结果来源通过浏览器回归，见 [creation-regression/browser-results.json](creation-regression/browser-results.json)。接口、Agent、交互和会话检查见相邻日志。没有真实模型调用、人工用户研究或实体屏幕阅读器验收。中文输入法采用合成事件测试，200%文字测试未同步放大原生输入/选择控件文字；它们不代表原生输入法完整验证或完整浏览器缩放验收。最终评分为这两项保留2分，仅表示固定量表下本次产品评审结果。

重新验证需要一个独立本地预览（默认 8799 端口），以及带 Playwright 和 Chrome 的 Node 环境：

```sh
node tests/verify_multica_agents.cjs
AGENT_UX_OUTPUT=docs/multica-agent-review/creation-regression node tests/verify_agent_ux_browser.cjs
python -m unittest discover -s tests -p 'test_agents.py' -v
python -m unittest discover -s tests -p 'test_web.py' -v
node tests/test_agent_interactions.js
node tests/test_journey_interactions.js
node tests/test_ui_session.js
```
