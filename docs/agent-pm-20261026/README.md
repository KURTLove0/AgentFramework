# 智能体 UI 与交互动线：本轮验收

2026-10-26，基于仓库现有实现继续完善智能体模块。独立产品经理 Agent 按冻结的 [25 项量表](pm-rubric.md) 评审，评分 **94 → 96 → 97/100**。第 1 轮虽超过 95 分，但仍存在旧刷新覆盖新状态的阻断问题；第 2 轮关闭全部阻断项后批准停止，未继续增加产品功能。

## 交付范围

当前模块采用“紧凑目录 → 独立详情 → 指定智能体任务”的动线：组合搜索/筛选/排序、保留列表上下文、四个详情页签、三步创建与编辑、固定版本技能、真实任务记录，以及归档后的只读查看与恢复。

本轮产品代码增量位于 `agent_framework/webui/agents.js` 和 `agent_framework/webui/app.js`：

- 归档和恢复直接采纳服务端返回的完整保存记录，避免操作成功后因额外列表读取失败而显示旧状态。
- 请求期间以工作空间和智能体身份防止重复提交；重新渲染后仍保留忙碌状态，失败可明确重试，响应不会写入其他工作空间。
- 全部列表详情入口有稳定的焦点目标，返回目录可定位到原来的名称链接或右侧箭头。
- 自动刷新读取前记录请求序号；期间若保存、归档或恢复完成，丢弃旧响应并重新读取，防止已提交的状态与版本回退。

本轮未重建发行包、未创建提交，也未修改原有工作空间数据。预览与验收使用 `/private/tmp/agent-pm-20261026` 的隔离数据。

## 独立评审与证据

| 轮次 | 评分 | 结论 |
| --- | ---: | --- |
| [第 0 轮](round-0.md) | 94 | 归档权威状态错误、右侧入口返回焦点丢失。 |
| [第 1 轮](round-1.md) | 96 | 首批问题关闭，但旧在途刷新仍可覆盖新状态，继续修正。 |
| [最终第 2 轮](round-2.md) | 97 | 归档及恢复两个方向的并发问题关闭，达到停止条件。 |

最终结构化评分见 [final-score.json](final-score.json)。评分是独立 Agent 对固定量表的验收判断，不等同于真实用户研究结果。

- [最终专项](round-2-audit-results.json)：8 项通过，含慢请求重绘、防重复提交、归档/恢复回执、失败重试，以及旧 GET 晚于归档/恢复返回。两个并发场景均只拦截第一个旧请求，随后真实读取完成后再次检查。
- [最终主流程](final-browser/browser-results.json)：15 项通过，24 组视口/主题/目录详情组合通过，无未处理脚本错误。截图位于 [final-browser/screenshots](final-browser/screenshots/)。
- [创建与任务往返](creation-regression/browser-results.json)：22 项通过，覆盖失败保留、版本冻结、配置返回任务、授权重审及结果来源。
- [交互回归](verification/agent-interactions.log)：32 项；[旅程回归](verification/journey-interactions.log)：22 项；[会话回归](verification/ui-session.log)：15 项，全部通过。
- Python Agent 测试 11 项、Web 测试 15 项均通过；变更文件语法检查和差异空白检查通过。

## 参考与验证边界

本轮实际打开 [Multica 参考地址](https://multica.ai/kl/agents) 后跳转登录页，未观察到其私有工作空间内容。结构参考来自本机 Multica 的 `packages/views/agents/components/agent-list-toolbar.tsx`、`agent-detail-page.tsx` 等源码；不声称与线上部署版本完全一致。

实际执行使用模拟业务工具，未调用真实模型。最终保留 3 分：原生中文输入法完整会话未实测；200%文字测试不等同于完整浏览器缩放；恢复后历史保存提示可能仍显示旧版本，而配置摘要和实际任务已采用新版本。上述边界由产品经理按固定量表记录为非阻断项，达到阈值后停止扩展优化。

## 复验

在安装项目依赖的环境中启动隔离预览：

```sh
python -m agent_framework --data-dir /tmp/agent-pm-review serve --port 8801
```

浏览器检查需要 Playwright 与 Chrome，并通过 `NODE_PATH` 指定可用的依赖目录：

```sh
AGENT_UI_BASE_URL=http://127.0.0.1:8801 MULTICA_REVIEW_OUTPUT=/tmp/agent-pm-browser node tests/verify_multica_agents.cjs
AGENT_UI_BASE_URL=http://127.0.0.1:8801 PM_AUDIT_LABEL=repeat PM_AUDIT_RACE=1 node docs/agent-pm-20261026/pm-audit.cjs
AGENT_UX_BASE_URL=http://127.0.0.1:8801 AGENT_UX_OUTPUT=/tmp/agent-pm-creation node tests/verify_agent_ux_browser.cjs
node tests/test_agent_interactions.js
node tests/test_journey_interactions.js
node tests/test_ui_session.js
python -m unittest discover -s tests -p 'test_agents.py' -v
python -m unittest discover -s tests -p 'test_web.py' -v
```
