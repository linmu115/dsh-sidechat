# Sidechat 0.4.2：修复 Better Sidebar 子上下文与 Markdown 注入

## 问题

Sidechat 0.4.0 已迁移到 DSH 0.1.2-alpha.1 的 `uiConversation`，但面板从
Better Sidebar 的 Tab 属性读取 `ctx.uiConversation`。该 `ctx` 属于 Sidebar 的
渲染作用域，并不携带 Sidechat 自己声明的注入，因此打开面板会报：

`cannot get property "uiConversation" without inject`

## 修改

- 在 Sidechat 注册 Tab 时捕获已经完成注入的根上下文。
- 通过面板的 `runtime` 小接口显式传入 `sessions`、`workspaces`、
  `betterSidebar` 和 `uiConversation`。
- Tab 属性中的 `ctx` 只属于宿主面板，不再作为 Sidechat 运行能力来源。
- 使用 alpha.1 的完整 Markdown labels 接口，恢复已有侧聊回答、代码块和脚注渲染。

## 验证

- 单元测试覆盖 Tab 注册时根上下文与 Sidebar 子上下文的隔离。
- 完整类型检查、测试、构建、打包与实际 WebUI 面板打开、已有消息渲染测试。
