# 工作台界面更新与验证

1.1.0 将九个模块统一为系统字体、语义配色、分组导航，以及浅色、深色和跟随系统三种外观。手机使用导航抽屉；主要操作保持可见焦点与足够触控面积。内容面板使用实色，半透明材质仅用于导航和工具栏。

Agent 分段配置、Skills 文件与固定版本选择、知识库四模块、工作空间管理、工作流画布及对话提案均已适配。表单提供未保存提示、字段错误定位和忙碌状态；任务界面展示授权、客观验收、外部草稿与恢复事实。会话更新只允许明确的会话过期响应触发一次重试，超时或未知写入结果不会自动重放。

设计约束见 [design.md](../../design.md)。参考 Apple [设计原则](https://developer.apple.com/design/human-interface-guidelines/design-principles)、[材质](https://developer.apple.com/design/human-interface-guidelines/materials)与[无障碍](https://developer.apple.com/design/human-interface-guidelines/accessibility)，结合 Web 操作和开发者工作台使用方式进行适配。

验证记录见 [verification.json](verification.json)：45 个布局检查覆盖九个模块及 320、414、768、1024、1440px 宽度，另有九个 375px 模块检查；检查范围内未发现页面横向溢出。28 个核心不透明色对通过文本 4.5:1、焦点及控件边界 3:1 对比度要求。透明材质和每个可能的内容组合没有穷举验证。

隔离模拟任务经界面验证：未授权时草稿为零；授权后写入响应丢失仍只创建一份草稿并通过三项验收。写入后实际停止并重启服务，浏览器未刷新即可续办，冻结的 Agent/Skill 快照保持一致，草稿和创建调用仍各为一。详见 restart-before.json、restart-after.json 与 ui-auth-recovery.json。没有调用真实模型。

发布前已备份并移除验收数据库。正式工作台和全新安装包的任务、草稿、自定义 Agent、工作流、知识、记忆、经验均为零，仅保留默认工作空间与两个系统 Skill。184 项单元测试、44 项安装包故障矩阵、15 项页面会话检查及安装启动结果见 [正式版验证记录](../release/verification.json)。
