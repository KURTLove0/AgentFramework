# 与智能体对话的界面优化

本次范围为任务持续对话和工作流设计对话，沿用项目的 Deep Space Glass 配色、系统字体和桌面 Web/PC 范围。

2026-10-29 细节评审按固定标准从 82 分复评至 95 分，修正输入文字错位、发送字号差异、标题层级、智能体名称截断和长提案操作位置。分项评分及测量证据见 [细节复评](../conversation-detail-review-20261029/FINAL_REVIEW.md)。

## 界面调整

- 页头以智能体、当前状态和任务目标为主，编号、模型和用量放入按需展开的任务信息。展开和关闭不替换输入框，也不清空草稿。
- 提问靠右呈现，回复以无外框正文展示；阅读列最大 800px，正文与输入使用 14px，主要辅助说明使用 13px。长回复、列表和代码块保留层级与内部滚动。
- 已完成的过程摘要降低视觉权重；正在生成、等待补充、排队、失败和停止状态继续明确显示。复制、导出和完整运行记录保留原入口。
- 输入区集中在底部，保留可见标签、键盘提示、焦点边界、发送中状态和原地错误。消息更新不打断输入法、草稿、光标和历史阅读位置。
- 工作流设计使用同样的消息语言；桌面上将提案放在独立侧栏，提案滚动不挤走输入区，仍可进入画布审查智能体和节点。

## 验证

```sh
.venv/bin/python scripts/run_browser_tests.py --suite conversation-ui --suite conversations --suite streaming --suite workflow-agents
npm test
PYTHONPATH=tests .venv/bin/python -m unittest test_web.HTTPTests.test_static_session_and_download
```

布局验证覆盖两类对话、1024/1280/1440/1920px、深浅主题，共 16 个正常场景；另在 1024/1440px、深浅主题验证两类对话的 200% 文字，共 8 个场景。检查正文行宽、横向溢出、发送按钮可达、任务信息键盘展开、草稿保存、失败重试和提案进入画布。

持续对话与流式回归继续验证中文输入、光标稳定、历史阅读不抢滚动、断线恢复、取消、排队、追问与复制/导出入口。新增样式加入原静态资源白名单并接受相同安全策略。模型响应来自临时测试服务；未以这些自动检查声称完成真实用户研究或真实输入法设备认证。

布局及截图报告：`/private/tmp/af-conversation-ui-complete-20261028/conversation-ui/`。持续对话和流式报告：`/private/tmp/af-conversation-ui-20261028/conversations/`、`/private/tmp/af-conversation-ui-20261028/streaming/`。工作流智能体回归报告：`/private/tmp/af-conversation-ui-accessibility-20261028/workflow-agents/`。

本轮上述 16 个常规布局、8 个文字放大场景通过，持续对话与流式回归通过，53 项前端测试及静态资源 HTTP 检查通过。另复核了历史运行记录入口和 1280×720 窗口中的发送操作。人工查看了深浅主题的消息层级、正文密度、输入区与工作流提案分栏。可直接打开的本地示例位于 `http://127.0.0.1:8892/#/workbench/task-a9cdccca3bc891f608ecdf1226735b13`，使用独立临时目录和模拟回复；日常工作台保留在 8787 端口。
