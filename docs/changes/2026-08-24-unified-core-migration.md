# Sidechat 统一注释 Core 迁移记录

日期：2026-08-24 至 2026-08-25  
版本：`dsh-sidechat 0.2.0`  
适配目标：DeepSeek Harness `0.1.1-rc.2` 官方 `web` profile

## 修改前

- 插件自行保存注释、编号、隐藏引用文本和输入框 UI，与 Obsidian 引用无法共享状态和提示词协议。
- 引用可能转化成正文/隐藏文本进入输入框；主会话与侧边子会话存在两套发送路径。
- sidechat 面板内的 fork、会话登记、模型同步和注释操作互相耦合。

## 修改后

- sidechat 只负责捕获 DSH 选段及创建/定位真实子会话；引用状态、编号、气泡、详情、发送事务、历史节点和回答链接统一交给 `dsh-annotation-core`。
- 输入框正文保持干净，不再写入 `@`、蓝色原生引用、引号块、XML 或隐藏 token；删除待发送注释后由 Core 立即重新编号。
- 主输入框和窄侧边输入框使用相同 Core 服务与 UI；侧边引用明确写入真实 child session，而不是父会话或 tab metadata。
- 抽出并发去重的子会话控制器，集中处理 fork、归档、模型同步、关闭清理和持久化 meta。
- sidechat-target add 之前写入仅含不透明 operation ID 的 IndexedDB 安全栅栏；Core 丢失或状态不确定时阻止可能丢上下文的普通发送。
- Core 仍是可选运行服务：缺失或不兼容时只停用注释功能，普通 sidechat tab、fork 和允许的纯文本发送继续工作。通过 Cordis 注入观察器把正确作用域中的 Core 显式传给第三方侧栏组件。
- 删除旧注释模型、codec、chip、draft、anchor、bridge 和 mutation-observer 路径；运行时只使用 Cordis 服务，不导入 Core 实现。

## 主要改动位置

- `src/client/annotate/producer.ts`、`selection.ts`、`overlay.tsx`：完整选段捕获和 Core producer。
- `src/client/annotation-core-resolver.ts`：版本/能力校验及可选服务观察器。
- `src/client/annotation-safety-guard.ts`：sidechat 引用 admission 安全栅栏。
- `src/client/sidechat/session-controller.ts`、`open.ts`：真实子会话生命周期。
- `src/client/sidechat/composer.ts`、`SideChatPanel.tsx`：共享窄输入绑定、历史投影和回答链接。
- `tests/e2e/mount.e2e.ts`、`scripts/e2e-mount.ps1`：Windows 官方 rc.2 一次性 profile 验收。
- `package.json`、`README.md`、`README_EN.md`：0.2.0 与 Core/better-sidebar 依赖及安装顺序。

## 验收

- `pnpm typecheck`：通过。
- `pnpm test`：6 个测试文件、65 项测试通过。
- `pnpm build`、`pnpm pack`：通过。
- 一次性官方 rc.2 `web` profile：按 Core → better-sidebar → sidechat 安装，6 项兼容链路 Playwright 测试全部通过。
- Core 缺失与 Client 服务版本不兼容两个故障车道分别通过 5 项、跳过 2 项 Core 专属断言；普通 fork、历史恢复、输入、多个 tab 和 `/side` 均保持可用。
- 浏览器验收覆盖：无 Client 崩溃、真实子会话 fork/reload、主输入框统一气泡与删除顺延、侧边子会话统一气泡且 textarea 为空、多 tab 独立子会话、`/side` 入口。

## 边界

- 未修改正式 `web` profile、用户会话或任何正式插件目录。
- 未发布 npm、未推送远端、未创建 Generation。
- Obsidian 协议 v2 与 sticker-board 来源适配器由后续任务实现。
