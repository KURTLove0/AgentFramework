# 历史任务的只读查询

2026-10-30。当前源码改进，尚未重新生成发行包。

`show`、`events`、`stats` 和独立的 `export` 命令现在直接读取已有数据库，不构造执行运行时、模型、业务工具或网关，也不执行数据库初始化与结构迁移。路径填错或数据库缺失时明确失败，不再生成新的空工作台。

## 使用

```bash
python -m agent_framework --data-dir /path/to/workbench show RUN_ID
python -m agent_framework --data-dir /path/to/workbench show RUN_ID --full
python -m agent_framework --data-dir /path/to/workbench events RUN_ID
python -m agent_framework --data-dir /path/to/workbench stats RUN_ID
python -m agent_framework --data-dir /path/to/workbench export RUN_ID /tmp/new-export-folder
```

其他租户使用全局 `--tenant` 选择原有租户。命令先核对该租户中运行是否存在，再读取统计或生成导出，错误的运行身份不会创建导出目录。

数据目录沿用创建命令的路径解释规则：相对路径按当前工作目录解析，不在查询阶段另外展开带引号的 `~`，避免同一参数在创建和查询时指向两个目录。通常可直接提供绝对路径，或让终端展开未加引号的用户主目录路径。

查询不加载本机模型配置，不要求原运行所用的模型 CLI 可用，也不使用执行租约和模型超时参数。运行中的任务仍可查看，不会因为检查历史而接管、续约或释放它的执行占用。

## 数据要求与错误处理

| 情况 | 行为 |
| --- | --- |
| 找不到已有的 `runtime.sqlite3` | 返回错误，请检查 `--data-dir`；不创建目录或新库 |
| 模拟业务库缺失或结构不完整 | `stats` 返回错误，不将无法确认的业务效果显示为零 |
| 仅需运行结果、事件或导出 | 不要求模拟业务库存在，也不会补建它 |
| 旧版本尚无停止、原生读取、经验候选或上下文表 | 按旧记录返回相应的空值，不迁移来源数据库 |
| 可选表存在但字段损坏 | 返回错误，不把损坏伪装成空记录 |
| 数据库损坏或必需结构不匹配 | 返回读取错误，不执行自动初始化或修复 |
| 存在未完成恢复的标记 | 在打开数据库前拒绝查询或导出 |

`stats` 沿用原有输出结构，业务调用次数与草稿记录在同一业务库读取事务中获取。`show`、`events` 和 `export` 沿用原有运行与事件数据；导出继续使用一致快照、拒绝覆盖及校验清单，见 [任务导出与完整记录包](exports.md)。

## 读取方式与兼容

存储层增加已有文件的只读打开模式：SQLite 使用 `mode=ro`，连接启用 `query_only`，不进入普通 `Store` 的建表流程；显式写事务和 SQL 写入也会被拒绝。正常启动、提交、恢复、授权和停止继续使用原有可写运行时。

读取保留 SQLite 的正常并发协调方式，不使用把数据库视为永不变化文件的 `immutable` 模式。测试确认，可以读取已提交但尚在 WAL 中的最新记录，同时保持主库与 WAL 中的业务内容不变。

WAL/SHM 是 SQLite 管理的并发协调文件；当前桌面环境中，只读连接仍可能创建或更新这些辅助文件。历史命令不会自行删除它们，也不会主动回写或清理 WAL。因此这里的只读保证针对任务、业务记录与数据库结构，不承诺辅助文件和目录元数据完全不变。闭库且使用回滚日志的只读目录也已验证可查询和导出。

工作台恢复是否完成，与正常运行时使用同一组目录内及目录旁恢复标记判断；即使恢复目录尚未创建，也先检查保护标记。需要恢复完整工作台时，使用 [核心数据备份与恢复](../data-protection/implementation.md) 中的配对备份流程。

## 复验

```bash
python -m unittest discover -s tests -p 'test_inspection.py' -q
python -m unittest discover -s tests -q
python scripts/run_browser_tests.py --suite exports --suite conversations --suite daily-recovery --suite workspace-safety
```

新增 15 项回归，覆盖缺失路径不建库、不构造运行时或模型、业务库缺失时仍可查运行与导出、统计不误报零效果、旧表缺失不迁移、禁止写入及执行占用保持、WAL 最新提交可见、两类恢复标记、损坏或空数据库、租户与运行隔离、原业务统计一致、只读目录、可选表字段损坏、空业务库不被初始化，以及独立子进程中创建与查询采用同一路径规则。验证使用隔离临时数据，不调用真实模型或修改现有业务数据。

最终完整后端 **541 项通过**；新增 15 项专项全部通过。`exports`、`conversations`、`daily-recovery`、`workspace-safety` 四套浏览器验收通过。另已核对 CLI 帮助，明确显示历史查询的只读行为；本轮没有改动界面布局。
