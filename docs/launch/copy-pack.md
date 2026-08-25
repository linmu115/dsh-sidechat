# dsh-sidechat 0.2.0 发布文案素材

## 一句话介绍

dsh-sidechat 为 DeepSeek Harness 提供可持久恢复的侧边会话，并把主输入框与侧聊统一到同一套 Codex 风格注释气泡。

## 主要功能

- 从当前会话完整 fork 出独立侧聊，不压缩历史，可多开；
- 侧聊自动归档，不污染左侧普通会话列表；
- 在 user 或 assistant 消息中划选原文，可加入主对话或真实侧聊 child；
- 引用显示为干净的「N 条注释」气泡，输入框没有 `> 引用`、蓝色 `@` 或隐藏字符；
- 气泡支持查看原文、填写可选注解、发送前删除与连续重编号；
- 发送后注释随会话历史持久保存，回答中的「注释 N」可点击回看。

## 安装

官方 `web` profile 按以下顺序安装：

```bash
dsh plugin --profile web add dsh-annotation-core
dsh plugin --profile web add dsh-better-sidebar
dsh plugin --profile web add dsh-sidechat
```

DSH Maintenance Engine 可自动处理依赖顺序。core 缺失或不兼容时，普通侧聊仍可用，只有划选引用入口停用。

## 对外说明

- `dsh-annotation-core` 是独立基础插件；sidechat 只通过 Cordis 服务消费它，不内嵌另一份实现。
- 侧聊是真实 DSH 会话，因此拥有正常模型、工具与后续 fork 能力。
- 关闭侧聊 Tab 只移除界面入口；会话日志仍遵循 DSH 自身的数据保留规则。
