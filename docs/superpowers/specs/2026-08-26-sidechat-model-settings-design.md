# Sidechat 模型设置设计

日期：2026-08-26
状态：已由用户确认

## 目标

让 `@evylynn/dsh-sidechat` 的参数信息页能够从当前 DSH 模型目录中选择侧边会话的 Provider、模型与推理强度，并让已经打开及之后新建的 Sidechat 真实使用该选择。

同时保持现有会话语义：Sidechat 仍然 fork 为真实子会话，立即归档隐藏，布局和子会话持久化；关闭浮窗或标签只移除界面引用，不删除归档子会话。布局恢复同一 tab 时继续使用原有子会话与上下文，并把该 session 的模型对齐到最新设置；显式关闭 tab 后，子会话仍可通过 DSH 的归档恢复能力找回。

## 用户体验

Manager 的插件参数页新增“侧边会话模型”分组，包含一个 Contract v2 `model-select` 字段：

- 标签：`默认侧边会话模型`
- 默认值：`null`
- 继承选项：`跟随主会话`
- 固定值：从 DSH 当前模型目录选择 `{ provider, model, reasoningEffort? }`
- Manager 契约：`apply: save`，不是 `restart-required`
- 生效方式：热载入；Manager 保存成功后立即更新当前运行进程，已经打开的 Sidechat 立刻切换，之后新建的 Sidechat 直接使用新值，无需重启插件或 DSH profile

模型选择控件本身承担“配置按钮”的交互：用户点击控件打开 DSH 模型目录，选择模型后使用 Manager 的标准保存按钮提交。这里不另建 action 按钮，也不维护第二套配置存储。

Manager 保存完成后不需要刷新页面或重启 profile。当前页面中已经打开的 Sidechat（包括未激活但仍挂载的侧栏 tab 和自由浮窗）立即切换到新路由；选择“跟随主会话”时，每个 Sidechat 分别读取自己的 `parentSessionId`，切回对应主会话的当前模型。正在生成的回答继续使用它启动时已经确定的模型，session 的模型选择立即更新，下一次模型请求使用新路由。

当前没有挂载的持久 Sidechat 不保持后台连接；它在布局恢复并重新挂载时立即对齐最新设置，然后才继续交互。已经显式关闭 tab、只剩 DSH 归档记录的子会话不再属于“打开的 Sidechat”，不会被后台批量改模。

## 配置契约

目标插件注册官方 DSH Settings namespace：

| 项目 | 值 |
| --- | --- |
| Namespace | `dsh-sidechat` |
| Key | `defaultModelRoute` |
| 类型 | `null \| { provider: string; model: string; reasoningEffort?: string }` |
| Cordis 配置 | `config.defaultModelRoute` 作为 base 层 |
| 用户持久化 | 当前 profile 的 DSH Settings Provider |
| 生效模式 | `live`；Manager 保存后当前进程立即更新并通知已打开的 Sidechat |
| 运行消费者 | Sidechat 模型协调器与子会话创建控制器 |

`null` 明确定义为继承发起 fork 的主会话当前模型。固定模型在真实 `sessions.selectModel` 调用时接受最终可用性校验；Manager 只保证选择时来自当前目录，不能保证该路由以后永远存在。

目标包新增 `dsh-management/panel.yaml`，使用 Contract v2，并把 `dsh-management` 加入发布文件列表。Manager 通过 `dsh-settings` binding 直接读写上述 namespace/key，不写入其私有 `panel-values.json`。

## 架构与数据流

### Host 半部

Host 注册 `dsh-sidechat` Settings namespace，并保留一个始终可读取的当前配置源：

1. 没有 Settings Provider 时，读取 Cordis entry 的 base 配置；默认是 `null`。
2. Settings Provider 挂载后，读取其解析值；用户层覆盖 base 层。Manager 保存触发 Settings commit 后，当前配置源立即反映新快照。
3. Settings Provider 卸载时，退回 base 配置，不影响插件继续工作。

Host 通过两个只读、同源受保护的 HTTP 端点向本插件 Client 暴露当前 `defaultModelRoute`：

- 快照端点返回 `{ revision, route }`，供首次创建、恢复和实时通道不可用时读取。
- Server-Sent Events 端点在连接建立时先发送当前快照，之后在 Settings 解析值改变时广播新 revision 与 route。

端点不接受写入；所有写入仍由 Manager 通过官方 Settings seam 完成。请求必须通过与 DSH Web API 等价的 Host、Origin 和 `Sec-Fetch-Site` 信任检查，并返回 `cache-control: no-store`。SSE 连接带有轻量保活，断线由浏览器自动重连；重连后的首帧携带完整当前快照，因此不依赖增量事件补齐断线期间的变化。

不直接从 Client 调用 Manager API，也不修改 DSH Settings RPC allowlist，避免目标插件依赖 Manager 私有协议或侵入 DSH 核心。

### Client 半部

Client 半部创建一个按插件 Context 共享的 Sidechat 模型协调器：

- 整个页面只维护一条 SSE 连接，不为每个 Sidechat 重复建连。
- 每个已挂载 Sidechat 在获得 `childId` 后登记 `{ childId, parentSessionId }`，卸载时注销。
- Better Sidebar 会让未激活 tab 保持挂载，自由浮窗也使用同一 tab renderer，因此当前页面内所有打开的 Sidechat 都进入同一登记表。
- 协调器为每个 child 串行化模型切换，并以 revision 去重；连续快速保存 A、B 时，较旧请求结束后继续应用最新 revision，最终状态必须是 B，不能被迟到的 A 覆盖。
- 协调器发布每个 child 的实际模型快照，面板底部模型标签在切换成功或回退成功后立即刷新。

Sidechat 完成真实子会话 fork、登记 tab metadata 后，为该子会话解析模型：

1. 从 Host 只读端点获取最新 `defaultModelRoute`。
2. 固定路由存在时，对子会话调用现有 `sessions.selectModel`，传入 provider、model 和可选 reasoning effort。
3. 值为 `null`、Host 端点不可用或响应无效时，读取主会话当前模型，并沿用现有同步逻辑。
4. 固定模型选择被 DSH 拒绝时，再尝试同步主会话模型。
5. 模型设置和归档并行完成；任一模型设置错误都不阻断 Sidechat 创建或持久化。

收到热更新事件时，协调器对登记表中的每个 child 执行同一模型解析流程。固定路由直接选择该模型；`null` 则按各自登记的 parent 读取当前模型。正在运行的回答不会被取消或迁移；`selectModel` 更新 session 的当前选择，影响下一次模型请求。

Sidechat 面板底部继续显示子会话的实际当前模型。因此发生回退后，用户看到的是最终真正使用的模型，而不是过期配置值。

## 生命周期

本功能不改变会话所有权：

- 子会话是真实、可持续的 DSH session。
- 创建后归档，从主会话列表隐藏。
- tab metadata 保存 `childId` 与 `parentSessionId`，同一 tab 被持久布局恢复时复用原有子会话。
- 关闭 tab 只释放前端控制器并移除界面引用，不删除或清理归档子会话；本功能不另建一套归档浏览器，恢复仍走 DSH 已有的 unarchive/restore 能力。
- 改变默认模型会立即更新当前页面中仍然打开、已登记的 Sidechat；未挂载布局在下次恢复时对齐。
- 已显式关闭 tab、只剩归档记录的子会话不在热更新登记表中，不做后台遍历。

## 错误处理

- Settings 服务缺失：使用 Cordis base；无显式 base 时跟随主会话。
- Host 配置读取失败：记录警告并跟随主会话。
- 固定路由字段为空：Settings 校验拒绝保存。
- 模型已从目录移除或不可路由：`selectModel` 失败后回退主会话。
- 主会话模型读取或回退选择也失败：保留 fork 自身带来的模型状态，Sidechat 仍可使用；只记录诊断。
- SSE 断线：保留各 session 当前模型，浏览器自动重连；重连首帧按完整快照对齐，不重放过期中间值。
- 连续快速保存：每个 child 的串行 latest-wins 队列保证最终应用最大 revision；重复 revision 不重复调用 `selectModel`。
- 热切换发生在回答生成期间：不取消当前回答，新的选择从下一次模型请求生效。
- tab 在 fork 期间关闭：沿用现有行为，归档已经产生的子会话并中止前端登记。

## 测试与验收

自动化测试覆盖：

1. Settings namespace、schema、base、live 模式、保存后无重启热更新和空字段校验。
2. `panel.yaml` 的 Contract v2、`model-select`、namespace/key 和发布文件契约。
3. `null` 时复制主会话模型。
4. 固定路由时直接选择配置模型及推理强度。
5. Host 读取失败、无效响应和固定模型拒绝时回退主会话。
6. SSE 首帧与热更新广播；断线重连用完整快照收敛。
7. 一次保存切换所有已挂载 Sidechat；不同 parent 在 `null` 路由下分别同步。
8. 重复 revision 去重，连续 A/B 保存最终落到 B，迟到响应不能回滚。
9. 切换完成后面板模型标签显示真实 selected/fallback 模型。
10. 卸载或显式关闭的 tab 注销，布局恢复时立即应用最新 revision。
11. 并发 fork 去重、归档隐藏、已登记子会话复用等现有行为不回归。
12. Host/client bundle 边界和浏览器 bundle purity 不回归。

集成验收在一次性 DSH profile 中进行：

1. 安装构建出的干净包。
2. 在 Manager 参数页确认模型选择器读取当前 DSH 模型目录。
3. 保存一个固定模型，创建新 Sidechat，确认底部实际模型与选择一致。
4. 切换为“跟随主会话”，创建另一个 Sidechat，确认复制主会话模型与推理强度。
5. 同时打开两个 Sidechat，在 profile 持续运行时改变并保存默认值，不刷新、不重启；确认两个面板的实际模型标签都立即切换，紧接着新建的 Sidechat 也使用新值。
6. 保存“跟随主会话”，确认来自不同 parent 的已打开 Sidechat 各自切回对应主会话当前模型。
7. 在一个 Sidechat 正在生成回答时保存新模型，确认当前回答不中断，结束后下一次提问使用新模型。
8. 刷新后恢复持久布局，确认同一 Sidechat 复用原有子会话并立即对齐最新设置；显式关闭 tab 后，确认归档子会话仍存在且可由 DSH unarchive 恢复。

最后从同一 Git 提交生成发布包，通过 Maintenance Engine 建立 checkpoint 后部署当前 `web` profile，再在真实界面重复核心验收。失败时使用 checkpoint 回退。

## 发布范围

- 功能版本提升为 `0.3.0`。
- 代码、声明、测试、参数页和变更说明进入同一 Git 历史。
- 推送到 `https://github.com/linmu115/dsh-sidechat.git`。
- 不在本任务中发布 npm；当前 DSH 从已验证的 Git 提交构建并部署。
