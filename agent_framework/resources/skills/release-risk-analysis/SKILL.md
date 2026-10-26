---
name: release-risk-analysis
description: "评估模拟发布变更风险并形成可核对的报告草稿。用于变更评审、测试与依赖影响分析，以及草稿验收。"
metadata:
  version: "1.0.0"
  author: "Agent Framework"
---

# 变更风险评估

依据任务范围内的可信变更、测试和依赖证据判断风险。生成报告前读取 [评估与恢复方法](references/method.md)。

对每个关键结论绑定证据；写入前取得具体任务范围授权，写入响应不明时先按原幂等键核对。完成由运行时独立验收决定。
