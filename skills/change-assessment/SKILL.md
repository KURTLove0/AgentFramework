---
name: change-assessment
description: 评估指定变更并创建草稿的 MVP 方法包。
---

可执行版本的规范源位于 `agent_framework/resources/change-assessment.md`，结构化清单位于同目录 `capability.json`。
每次运行将其与 Agent 配置一起冻结并保存 SHA-256 摘要。此入口用于开发者发现方法包；运行时不从工作目录动态覆盖已冻结的版本。
