# dsh-sidechat

DSH（DeepSeek Harness）web 插件：Codex 风格的**侧边聊天**与**划选注释**。[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的薄消费插件（thin consumer），通过 `ctx.betterSidebar` 服务注册侧边栏 Tab。

[English](README_EN.md) · 中文

## 功能一览

### 💬 侧边聊天

从当前主会话 **fork**（全量历史快照）出独立的侧边会话，在右侧栏的「侧边」Tab 里多轮对话——主线思路不打断，支线问题随手开：

- 右侧栏 `+` 菜单 →「侧边聊天」，或斜杠命令 `/side`；
- fork 时刻带主会话完整上下文，之后两个会话各自独立演进；
- 多实例并存（「侧边」「侧边 2」…），各自独立关闭；
- 模型可在 Manager 参数页从 DSH 当前模型目录选择，也可设为“跟随主会话”；
- 模型设置热载入：保存后所有已打开侧聊立即切换，正在生成的回答不中断，下一次提问使用新模型；
- 持久化：刷新/重启后随布局恢复；不进左侧会话列表（归档隐藏）；仅手动关闭 Tab 从界面消失。

![侧边聊天面板](docs/assets/04-side-chat-panel.png)

### 🗒️ 划选注释

在 user 或 assistant 消息上划选文本，把引用变成可查看、可注解的会话上下文：

- **添加到对话**：引用进入主输入框上方的 Codex 风格注释气泡；
- **在侧边聊天中提问**：先建立真实侧边会话，再把引用加入该侧聊的同款气泡；
- 点击气泡可查看完整原文并填写可选注解，发送前可删除；删除后剩余编号自动顺延为 1…N；
- 输入框始终只显示你输入的问题，不会出现 `> 引用` 明文、蓝色 `@` 或隐藏占位符；
- 发送后的气泡成为会话历史的一部分，模型回答中的「注释 N」可以点击回看对应内容。

## 安装

### 依赖关系

| 依赖 | 作用 | 当前状态 |
|---|---|---|
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 提供右侧栏容器与 Tab 注册服务 | 运行时需要；peer 仅提示安装，不限制版本 |
| [`dsh-annotation-core`](https://github.com/linmu115/dsh-annotation-core) | 提供统一注释气泡、发送上下文和已发送注释展示；不限制版本，按运行时接口实际结果验收 | 硬依赖 |
| `dsh-resource-management` | 在 Manager 参数页提供 DSH 模型目录选择器 | 可选，推荐安装 |

请按顺序安装 core → better-sidebar → sidechat；三个包都只需安装到官方 `web` profile 一次：

```bash
dsh plugin --profile web add dsh-annotation-core
dsh plugin --profile web add dsh-better-sidebar
dsh plugin --profile web add @evylynn/dsh-sidechat
```

如果通过 DSH Maintenance Engine 部署，依赖顺序会自动处理。Sidechat 不限制 Better Sidebar 版本，方便在 Maintenance 中试验不同组合；不兼容组合由部署预览和 staging 结果提示，不会仅因 peer 版本范围被拒绝。core 缺失或版本不兼容时，普通侧边聊天仍可使用，但划选引用入口会停用。

本地开发挂载：`dsh plugin --profile web add link:<本仓库路径>`（client 改动热重载，host 改动需重启 `dsh web`）。

## 模型配置

打开 Manager → 插件 → `@evylynn/dsh-sidechat` → 参数信息，在“侧边会话模型”中选择一个已登记模型，或选择“跟随主会话”，然后点击 Manager 的标准保存按钮。

- 保存本身是热载入，不需要刷新页面或重启 DSH；
- 当前页面里已打开的侧栏 tab 和自由浮窗都会立即切换；
- 选择“跟随主会话”时，每个 Sidechat 分别读取自己的主会话当前模型；
- 正在生成的回答不会被取消；切换结束后，下一次模型请求使用新设置；
- 路由仅绑定到当前已挂载的 Sidechat，不会改写 DSH 的全局默认模型或影响无关新会话；
- 未挂载的持久布局在恢复时对齐；显式关闭后仅存于归档的会话不会在后台被修改。

## 设计要点

- **真 fork，不压缩**：侧边会话是真实 DSH 会话（fork 全量历史），拥有与主会话对等的能力（工具调用、继续深挖、再 fork）；不是「压缩成摘要 + 一次性问答」。
- **列表卫生**：侧边会话归档隐藏，左侧列表永远干净。
- **统一注释工作流**：主输入框和侧边聊天共用同一套气泡、编号、注解、发送上下文和历史展示。

## 开发

| 命令 | 说明 |
|---|---|
| `pnpm typecheck` | tsc --noEmit |
| `pnpm test` | vitest 纯函数单测 |
| `pnpm build` | 类型声明 + tsdown（host ESM + client CJS bundle，纯度门） |
| `pnpm test:mount` | 挂载冒烟：scratch profile + 伪造会话 jsonl + 真实 `dsh web` + Playwright 七条 journey lane（支持 `BS_VERSION` 切换 better-sidebar 版本做前向兼容验证） |

## License

MIT
