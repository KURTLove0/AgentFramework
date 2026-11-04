# 任务恢复功能的安装后验收

2026-11-04。将任务准备取消、迟到响应处理和任务名称草稿清理的最新实现打入独立候选包，并完成全新离线安装验收。候选仍为 1.3.0，保存在临时目录；本轮没有发布版本。

## 补齐的交付检查

`scripts/verify_release.py --browser-check` 现在依次执行提交回执恢复、任务准备和任务名称恢复三组浏览器检查。沿用已有浏览器用例，通过安装后服务的 HTTP API 创建独立工作空间和模拟任务，不导入开发目录的应用模块来准备数据。三组结果分别记录检查数、布局数、日志和截图；任一进程失败、结果缺失或存在页面错误都会使验收失败。

浏览器连接的是用安装后 CLI 还原备份后重新启动的服务。任务准备在新建的空白空间验证首次创建流程；名称恢复另建四个已完成的模拟任务，覆盖保存冲突、丢失回执、页面刷新、清理失败、继续编辑及切换空间。

## 本次结果

- 候选包中的 167 个应用文件与当前源码逐一匹配，安装、启动脚本及随包说明也匹配。相较上一份管理流程候选，应用变化仅有 5 个前端文件。
- 25 项交付回归通过。全新虚拟环境离线安装通过，85 个应用模块来自该环境，71 个页面资源与 wheel 字节一致。
- 两次正常重启通过，配置、任务、回执以及草稿保存和删除版本均保留；旧请求重放未重复创建任务或回退数据。
- 安装后 CLI 备份、检查和恢复通过，原数据库未变，覆盖已有恢复目录被拒绝且该目录未变。
- 恢复后的服务通过 15 项浏览器流程：提交恢复 4 项、任务准备 4 项、名称恢复 7 项。页面错误为 0；任务准备和名称编辑共记录 18 组明暗主题、窗口宽度及放大文字布局检查。已目视复核安装后截图中的失败提示和清理按钮布局。
- `dist/` 的六个历史发行文件仍符合原有校验和。

本轮只扩展交付校验器，没有修改应用实现。前一轮同一份应用源码的 1160 项前端测试结果仍适用，记录见 [任务名称清理验证](../reliability/task-name-cleanup-verification-20261104.json)。本次没有重复全量应用单测。

候选与完整验收摘要见 [交付证据](task-recovery-delivery-verification-20261104.json)。范围为 macOS arm64 / Python 3.14.3、mock 运行时和正常进程重启；没有验证真实模型服务、其他平台、断电恢复或跨版本升级。

## 复现

准备本机适配的 PyYAML 6.0.3 wheel 后，使用尚不存在的候选目录和报告路径：

```sh
.venv/bin/python scripts/build_release.py --output-dir /tmp/agent-task-recovery-candidate
.venv/bin/python scripts/verify_release.py \
  /tmp/agent-task-recovery-candidate/agent-framework-1.3.0.tar.gz \
  --wheelhouse /tmp/agent-wheelhouse \
  --report /tmp/agent-task-recovery-installed.json --browser-check
.venv/bin/python -m unittest tests.test_release_delivery
```

浏览器验收需要开发环境已安装 Playwright 和 Chrome。运行结束后清理临时安装与数据库；指定报告、浏览器日志和截图保留供核对。
