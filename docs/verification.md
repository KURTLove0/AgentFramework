# MVP 验证记录

验证日期：2026-10-21；执行环境 Python 3.14.3，macOS。测试不需要网络或模型凭据。

- `python3 -m unittest discover -s tests -v`：**29 项全部通过**，最后一轮耗时 5.904 秒。覆盖正常闭环、读重试、写入响应丢失、写后进程退出与跨进程恢复、权威查询确认未发生后重试、无法核对、草稿篡改、报告修复、畸形模型输出、来源版本冲突、权限缺失/撤销/过期/参数绑定、租户隔离、租约 fencing、预算与取消。
- `python3 -m agent_framework.evaluate`：**11/11 场景符合预期**。正常、读瞬时失败、响应丢失、写后进程退出、报告修复与版本冲突最终成功；持续读失败、证据缺失、权限缺失与无法核对场景按预期停止或等待。
- 响应丢失和写后进程退出场景均为 **1 次 create 调用、1 份外部草稿**。来源版本冲突有 2 次 create 调用，但第一次条件写被拒绝，最终仅 1 份草稿。
- CLI 冒烟验证通过：demo、submit、show、grant、resume、stats、events、export、revoke、cancel；确认导出的报告文件存在。
- `python3 -m compileall -q agent_framework tests`：通过。

本次原始产物位于项目 `.agent-data/`，该目录已从版本控制中排除：

- `test-results.txt`：29 项测试输出。
- `cli-smoke.json`：CLI 检查记录。
- `evaluation/evaluation-653b620a3c/summary.json`：11 场景状态、创建调用数、草稿数和判定。
- 各评测场景的 `export/`：完整结果 JSON、事件日志和报告。

运行评测会产生新的唯一目录，不覆盖之前的证据。测试均为有限、确定性的模拟回归，不代表真实模型质量、真实业务接口兼容性、性能、生产鉴权或开放环境成功率。
