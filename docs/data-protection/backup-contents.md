# 恢复前核对备份内容

2026-11-04。`verify-backup` 现在除完整性校验外，还提供备份内容摘要，便于恢复前确认工作空间和历史记录。当前源码版本仍为 1.3.0，改进已进入隔离候选，尚未发布。

## 使用

```sh
python -m agent_framework verify-backup agent-data-backup.zip
```

成功输出的原有 `valid`、版本、时间和文件摘要保持兼容，新增 `contents`。例如：

```json
{
  "version": 1,
  "counts": {
    "execution_records": 2,
    "conversations": 1,
    "agents": 1,
    "workspaces": 1,
    "workflows": 0,
    "workflow_runs": 0,
    "runtime_configurations": 1,
    "saved_task_drafts": 0,
    "business_drafts": 1
  },
  "workspaces": {
    "total": 1,
    "offset": 0,
    "limit": 100,
    "has_more": false,
    "next_offset": null,
    "items": [{
      "tenant": "delivery-tenant",
      "id": "workspace-default",
      "project_id": "project-demo",
      "name": "默认工作空间",
      "deleted": false
    }]
  }
}
```

工作空间按租户和 ID 稳定排序，每页最多 100 条。`has_more` 为真时，使用返回的 `next_offset` 继续查看同一备份：

```sh
python -m agent_framework verify-backup agent-data-backup.zip --workspace-offset 100
```

每一页仍会完整校验备份，记录总数不随翻页变化。超出目录末尾返回空列表和原总数；负数等无效起始位置明确报错。

## 数量的含义

| 字段 | 统计范围 |
| --- | --- |
| `execution_records` | 所有持久执行记录，含后续轮次和工作流节点；不是界面中的任务根数量 |
| `conversations` | 已登记的对话，包含归档对话；早期仅有执行记录的备份可以为 0 |
| `agents` | 已保存的智能体，包含已归档配置 |
| `workspaces` | 所有租户的空间，包含已删除空间；目录明确显示 `deleted` |
| `workflows` / `workflow_runs` | 已保存的流程定义及流程执行记录，包含历史记录 |
| `runtime_configurations` | 已持久保存的租户运行配置；未保存的默认值不计入 |
| `saved_task_drafts` | 服务端仍有内容的任务草稿；删除后的版本记录不计入 |
| `business_drafts` | 模拟业务库中已保存的外部草稿 |

摘要覆盖整个备份的所有租户、空间和主体，与已有全库维护命令的范围一致。目录显示空间名称和标识；任务正文、Agent 指令、配置值和草稿正文不输出。浏览器中尚未提交到服务端的编辑和恢复记录不属于数据库备份。

## 读取与兼容

只有归档成员、文件摘要和数据库完整性全部通过后，才从校验用的临时数据库读取数量和目录。读取使用只读连接，不创建应用、不迁移数据库、不启动任务；源备份和日常工作台不被修改。早期只包含核心执行表的备份仍可检查，尚未存在的功能表显示 0，不补建表。

备份格式保持 v1，摘要不写进原清单。内容摘要自身带 `version: 1`。无法读取的目录结构或损坏的 JSON 返回明确错误，不能以 `valid: true` 掩盖摘要失败；创建备份的发布前自检也遵循这一规则。

## 验收

新增 9 项回归覆盖轮次与对话计数、归档和删除状态、多租户、已删除草稿、106 个空间的完整翻页、旧核心数据库、只读权限、备份快照与后续数据的区别、CLI 输出范围、非法起始位置及损坏目录的失败处理。最初 7 项用例在原实现上均因缺少摘要失败，补充功能后通过。

完整后端 **1401 项通过**；58 项相关回归在将数据库资源泄漏警告视为错误的模式下通过。初次相关测试因流程设计测试的顶层夹具导入路径缺失而未能加载该模块，补上 `PYTHONPATH=tests` 后完整重跑通过。界面代码没有变化，本轮未重复全量前端单测。

安装验收执行归档内真实安装和启动脚本；从新环境中的 CLI 创建、校验和恢复备份，核对内容摘要，拒绝覆盖已有目标并确认原数据库摘要不变。随后从恢复目录启动工作台，重新核对配置、草稿删除版本、任务结果和原回执，并运行浏览器恢复流程。

新候选位于 `/private/tmp/af-backup-contents-source-candidate-20261104/`：166 个应用文件与保存源码逐项匹配，仅备份模块和 CLI 相比上一候选发生改变。全新环境内 85 个应用模块来自安装目录，70 个页面资源与 wheel 字节一致；两次重启、安装后备份恢复及恢复后的 4 项浏览器检查通过，页面错误为 0。六个历史发行产物的校验和保持不变。

完整结果及摘要见 [验收证据](backup-contents-verification-20261104.json)。测试使用临时数据和模拟运行时，没有访问日常业务数据库或调用真实模型。正常重启与备份恢复结果不能代替断电故障或跨版本迁移验证。
