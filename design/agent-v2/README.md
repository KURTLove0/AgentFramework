# Agent v2 设计契约样例

这里验证优化方案中的引用关系与关键边界。它与现有 MVP 运行时分开，不执行模型调用、数据库操作或业务工具，也不签发授权。

```bash
python3 design/agent-v2/validate.py
python3 design/agent-v2/validate.py --self-test
```

- `example.json`：岗位身份、职责、标准、Skill、能力、知识资产、任务和上下文的模拟注册数据。
- `validate.py`：结构引用和作用域检查；输出 `execution_authorized: false`，供设计评审与后续编译器实现参考。
- `compiled-example.json`：正例编译结果，分别记录定义、任务和上下文摘要。
- `validation-cases.json`：12 个负例的拒绝原因。

负例覆盖跨租户、跨项目、无读取权限、过期知识、未发布经验、未知能力、写入无核对、原生写入绕过、模型生成幂等身份、未知验收器、缺少标准证据和内容摘要不一致。

本样例没有实现完整 JSON Schema 校验、真实身份授权、检索、MCP/CLI 适配或动作分发。`input_schema_ref` 等引用展示目标契约；生产编译器还须解析对应的已发布 Schema 和受信实现。

后续改造步骤见 [优化方案](../../docs/optimization/proposal.md)。
