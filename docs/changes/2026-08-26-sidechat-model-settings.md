# Sidechat 0.3.0：Manager 模型配置与热切换

日期：2026-08-26

## 变更

- 注册官方 DSH Settings namespace `dsh-sidechat`，字段 `defaultModelRoute`。
- 在 Manager 参数页加入 Contract v2 `model-select`，模型列表直接来自当前 DSH 模型目录；`null` 表示“跟随主会话”。
- Manager 保存后通过 Host SSE 把完整 revision 快照推给浏览器，不刷新页面、不重启 profile。
- 当前页面所有已打开 Sidechat（侧栏 tab 与自由浮窗）按 child 串行切换，连续快速保存以最新 revision 为准。
- 固定模型失效时回退该 Sidechat 自己的主会话模型；底部标签显示最终实际模型。
- 切换期间禁用新提交；已经开始生成的回答不取消，新设置从下一次请求生效。

## 会话兼容性

Sidechat 仍是真实 fork 子会话，创建后归档隐藏。关闭 tab 只移除界面引用，不删除归档会话；恢复布局继续复用原 `childId` 并对齐最新模型设置。未挂载或已显式关闭的 Sidechat 不做后台批量切换。

## 验证

本变更由 Settings/HTTP-SSE/store/coordinator/UI gate/bundle contract 单测、浏览器 bundle 纯度门、一次性 DSH profile 和当前 `web` profile 现场验收共同覆盖。最终提交、包摘要与部署记录写入 `docs/release/verification.md`。

## 回退

通过 DSH Maintenance Engine 的该插件独立 rollback target 回到 0.2.0；回退不会删除 Settings 文档中的新 namespace，也不会删除或改写已有 Sidechat 子会话。
