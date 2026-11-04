# 日常任务流程的安装后验收

2026-11-04。将最近的对话草稿恢复、归档焦点和收藏恢复改进汇入独立候选包，并扩展安装校验器。当前候选仍为 1.3.0，尚未发布。

## 验收范围

`scripts/verify_release.py --browser-check` 现在在备份还原后启动的安装服务上运行六组用例：提交回执恢复、首次任务准备、任务名称、归档与移回、收藏、未发送消息草稿。之前覆盖前三组，本次补齐后三组。

名称、归档和收藏分别创建独立工作空间与空白切换空间，通过安装服务的 HTTP API 创建 mock 智能体和任务。每批最多四个任务，等待完成后再准备下一批。收藏使用 51 个已完成任务，并断言被收藏的旧任务已在默认第一页之外；筛选必须跨分页找回它。任务执行采用安装包中的实际 mock 实现，未从开发目录导入应用模块或直接修改数据库来伪造完成状态。

此次也修正并加强了两处已有浏览器验收：

- 收藏用例使用正确的 `workspace_id` 参数，并断言实际打开的工作空间。原来的 `workspace` 参数在默认空间测试时碰巧通过，不能验证独立空间。
- 归档后 Markdown 导出必须包含归档前的完整回复正文，不再只匹配合成数据中的固定短语。

加强后的归档和收藏用例也通过了原有 137 条历史任务的独立验收。

## 结果

- 新候选包含 167 个应用文件，与当前源码逐文件匹配；相较上一份任务恢复候选，应用差异为 4 个前端文件。随包安装、启动脚本和两份说明均匹配，六个历史发行产物的校验和未变。
- 25 项交付回归通过。全新离线安装成功，85 个应用模块来自新虚拟环境，71 个页面资源与 wheel 字节一致。
- 两次正常重启后，配置、任务、回执及草稿保存/删除版本保持正确；重放旧请求没有重复创建任务或回退数据。
- 安装后 CLI 完成备份、内容检查和恢复；原数据库未变，已有恢复目标被拒绝且未被覆盖。随后启动恢复后的服务执行全部浏览器检查。
- 六组共 42 项浏览器流程、60 组布局检查通过，页面错误为 0。安装后的草稿存储失败提示与收藏清理提示均已目视复核。

本轮修改交付校验器及两份浏览器用例，没有修改应用实现。上一轮同一应用源码的 1185 项前端测试结果仍适用。本次没有重复全量前端或后端单测。

候选位于 `/private/tmp/af-task-organization-candidate-20261104/`。完整报告、文件摘要与复核记录见 [交付证据](task-organization-delivery-verification-20261104.json)。验证环境为 macOS arm64 / Python 3.14.3 / PyYAML 6.0.3，使用 mock 运行时；真实模型服务、其他操作系统、断电恢复和跨版本升级不在本次验证范围内。

## 复现

准备本机适配的 PyYAML 6.0.3 wheel、Playwright 与 Chrome，使用尚不存在的候选目录和报告路径：

```sh
.venv/bin/python scripts/build_release.py --output-dir /tmp/agent-organization-candidate
.venv/bin/python scripts/verify_release.py \
  /tmp/agent-organization-candidate/agent-framework-1.3.0.tar.gz \
  --wheelhouse /tmp/agent-wheelhouse \
  --report /tmp/agent-organization-installed.json --browser-check
.venv/bin/python -m unittest tests.test_release_delivery
```

临时安装和数据库在结束时清理，指定报告及浏览器证据保留；候选构建不会覆盖已有同名版本。
