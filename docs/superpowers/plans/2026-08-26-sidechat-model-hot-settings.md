# Sidechat Model Hot Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Manager 参数页从 DSH 已登记模型中配置 Sidechat 默认模型，并在保存后立即把当前页面所有已打开 Sidechat 切到新模型；会话归档、持久化、恢复和正在生成的回答保持原有语义。

**Architecture:** Host 使用官方 `@deepseek-ai/dsh-settings` 注册 `dsh-sidechat/defaultModelRoute`，通过受同源信任保护的 JSON 快照和单条 SSE 通道把 revisioned route 推给 Client。Client 共享一个 route store 和一个 per-child 串行 latest-wins 协调器；每个挂载面板用短租约登记真实 child session，Host 在该 child 的下一次 `agent/request` 边界覆盖模型，`null` 或固定路由失效时按自己的 parent 回退；切换期间阻止新提交但不取消在途回答。

**联调修订：** 一次性 profile 证明 rc.2 的 `session.selectModel` 会同时保存整个 profile 的默认模型，直接用于 Sidechat 会污染空白父会话和无关新会话。实现因此改为 Host 侧、仅对活动 Sidechat child 生效的请求路由 binding；该修订保持用户确认的热载入和会话生命周期语义，并新增“不改写全局默认模型”的回归覆盖。

**Tech Stack:** TypeScript 5.6、React 18、Cordis/DSH 0.1.1-rc.2、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`、Node HTTP/SSE、Vitest、Playwright、pnpm、DSH Maintenance Engine。

**Spec:** `docs/superpowers/specs/2026-08-26-sidechat-model-settings-design.md`

## Global Constraints

- 保持 Sidechat 为真实 fork 子会话；创建后仍归档隐藏，关闭 tab 不删除子会话，恢复布局复用 `childId`。
- Manager 写入唯一官方 Settings namespace/key；不得写 Manager 私有 `panel-values.json`，不得新增第二套配置存储。
- `apply: save` 必须热生效：所有当前已登记 Sidechat 都收敛到最新 revision；未挂载和显式关闭的子会话不后台遍历。
- 热切换不取消当前回答；模型对齐期间阻止 Send 和 Enter，切换结束后下一次请求使用新模型。
- 浏览器 bundle 不得出现 `@deepseek-ai/*` Host value import、Node builtin 或目标插件之外的运行时副本。
- 每个任务先写失败测试，再写最小实现，通过对应测试后提交；不得留下 TODO、占位实现或跳过的验收。

---

### Task 1: Shared model-route contract and live Settings source

**Files:**
- Create: `src/model-route.ts`
- Create: `src/host/model-settings.ts`
- Modify: `src/index.ts`
- Modify: `src/context-types.ts`
- Test: `tests/model-settings.spec.ts`

- [ ] 写 `tests/model-settings.spec.ts`，先覆盖 route 校验/归一化、空 provider/model 拒绝、结构相等比较、base=`null`、Settings attach/watch/detach 与 revision 只在真实 route 变化时递增。

```ts
it('publishes a new revision only when the resolved route changes', async () => {
  const hub = new ModelRouteHub(null)
  expect(hub.getSnapshot()).toEqual({ revision: 0, route: null })
  hub.setRoute({ provider: 'deepseek', model: 'deepseek-chat' })
  hub.setRoute({ provider: 'deepseek', model: 'deepseek-chat' })
  expect(hub.getSnapshot()).toEqual({
    revision: 1,
    route: { provider: 'deepseek', model: 'deepseek-chat' },
  })
})
```

- [ ] 运行 `pnpm vitest run tests/model-settings.spec.ts`；预期失败，因为共享契约和 Settings 安装器尚不存在。
- [ ] 在 `src/model-route.ts` 定义并实现 `ModelRoute`、`ModelRouteSnapshot`、`isModelRoute`、`parseModelRouteSnapshot`、`sameModelRoute`；拒绝空白字段，保留可选 `reasoningEffort`。
- [ ] 在 `src/host/model-settings.ts` 用 `z.union([z.const(null), z.object(...)])` 建 schema，用 `installSettingsSection(ctx, settingsNamespace('dsh-sidechat'), ...)` 安装可选 Settings；实现 `ModelRouteHub` 的快照、订阅、相等去重和 dispose。
- [ ] 在 `src/index.ts` 导出 `Config`/schema，创建 hub；在 `src/context-types.ts` 把 Host Context 与 Client Context 分开，Host 基于 `@deepseek-ai/cordis`，Client 的 `cordis` type-only 边界保持可擦除。
- [ ] 运行 `pnpm vitest run tests/model-settings.spec.ts && pnpm typecheck`；预期全部通过。
- [ ] 提交：`git add src/model-route.ts src/host/model-settings.ts src/index.ts src/context-types.ts tests/model-settings.spec.ts && git commit -m "feat: register live sidechat model settings"`

### Task 2: Trusted JSON snapshot and SSE push surface

**Files:**
- Create: `src/host/trust-fence.ts`
- Create: `src/host/model-route-http.ts`
- Modify: `src/index.ts`
- Test: `tests/model-route-http.spec.ts`

- [ ] 写 HTTP 测试，使用真实 `node:http` 临时 server 或结构化 request/response fixture 覆盖：GET 快照、SSE 首帧、后续广播、keepalive、dispose 关闭连接、405、loopback/trusted host、cross-site/origin 拒绝和 `cache-control: no-store`。

```ts
expect(firstEvent).toEqual({ revision: 0, route: null })
hub.setRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' })
expect(await nextEvent()).toEqual({
  revision: 1,
  route: { provider: 'p', model: 'm', reasoningEffort: 'high' },
})
```

- [ ] 运行 `pnpm vitest run tests/model-route-http.spec.ts`；预期失败，因为路由处理器尚不存在。
- [ ] 从 `dsh-better-sidebar/src/trust-fence.ts` 复制与 DSH `/api` 等价的 Host/Origin/`Sec-Fetch-Site` fence，并在文件头保留 BSD-3-Clause 来源说明；读取 `webRuntime.trustedHosts` 时按请求取最新值。
- [ ] 实现 `createModelRouteSnapshotHandler` 和 `createModelRouteEventsHandler`：仅 GET；JSON 为 `{revision,route}`；SSE 建连即发送完整 `data:` 帧、每 15 秒 `: keepalive`、在 request close/dispose 时释放 hub listener 和 timer。
- [ ] 在 `src/index.ts` 以 `ctx.inject(['webServer', 'webRuntime'], ...)` 注册精确路径 `/plugins/dsh-sidechat/model-route` 与 `/plugins/dsh-sidechat/model-route/events`；插件 dispose 同时关闭所有 SSE response。
- [ ] 运行 `pnpm vitest run tests/model-route-http.spec.ts tests/model-settings.spec.ts && pnpm typecheck`；预期通过且无悬挂测试进程。
- [ ] 提交：`git add src/host src/index.ts tests/model-route-http.spec.ts && git commit -m "feat: stream sidechat model route changes"`

### Task 3: One reconnect-safe client route store

**Files:**
- Create: `src/client/sidechat/model-route-store.ts`
- Test: `tests/model-route-store.spec.ts`

- [ ] 写 fake `fetch`/`EventSource` 单测覆盖：初始 fallback revision `-1`、一次 JSON bootstrap、全页面一条 EventSource、首帧覆盖 fallback、重复/陈旧 revision 忽略、无效帧忽略、SSE 失败保留最后快照、重连首帧收敛以及 dispose 关闭连接。

```ts
const store = createModelRouteStore({ fetch: fakeFetch, EventSource: FakeEventSource })
expect(store.getSnapshot()).toEqual({ revision: -1, route: null })
events.emit({ revision: 4, route: { provider: 'p', model: 'b' } })
events.emit({ revision: 3, route: { provider: 'p', model: 'a' } })
expect(store.getSnapshot().revision).toBe(4)
```

- [ ] 运行 `pnpm vitest run tests/model-route-store.spec.ts`；预期失败。
- [ ] 实现 store：同步返回 identity-stable snapshot，构造时请求快照并建立 EventSource，统一经 `parseModelRouteSnapshot` 验证，只有更大 revision 才发布；浏览器自动重连，不自行复制定时器。
- [ ] 运行 `pnpm vitest run tests/model-route-store.spec.ts && pnpm typecheck`；预期通过。
- [ ] 提交：`git add src/client/sidechat/model-route-store.ts tests/model-route-store.spec.ts && git commit -m "feat: observe sidechat model routes in browser"`

### Task 4: Per-child latest-wins model coordinator

**Files:**
- Create: `src/client/sidechat/model-coordinator.ts`
- Modify: `src/client/sidechat/session-controller.ts`
- Modify: `tests/sidechat-unified.spec.ts`
- Test: `tests/model-coordinator.spec.ts`

- [ ] 写 coordinator 单测覆盖：固定路由含 reasoning effort、`null` 各自读取 parent、一次 revision 更新所有登记 child、重复 revision 去重、A/B 快速保存最终 B、固定路由失败回退 parent、两次都失败保留实际/fork 模型并 ready、注销不再热切换、重新登记立即应用最新 revision。

```ts
const releaseA = deferred<void>()
binding.bind.mockImplementationOnce(async () => { await releaseA.promise; return applied(1, 'a') })
store.publish({ revision: 1, route: route('a') })
store.publish({ revision: 2, route: route('b') })
releaseA.resolve()
await coordinator.whenIdle('child')
expect(coordinator.getSnapshot('child').modelName).toBe('b')
```

- [ ] 运行 `pnpm vitest run tests/model-coordinator.spec.ts tests/sidechat-unified.spec.ts`；预期失败。
- [ ] 实现 `SidechatModelCoordinator`：`register/unregister/subscribe/getSnapshot/dispose`，child 状态为 `pending|switching|ready`、`modelName`、`appliedRevision`；每个 child 单独 promise chain，队列每轮重新读取最新目标 revision，确保 latest-wins。
- [ ] 每轮先读取 `models(parent)`，再向 Host 登记带租约的 child/parent binding；Host 校验固定 route 并在 `agent/request` 外层覆盖模型，`null` 或固定失败时使用登记的 parent route；最终失败再 `models(child)` 获取保留模型标签，所有失败均记录诊断并释放 ready gate。
- [ ] 从 `session-controller.ts` 删除 `bestEffortModelSync` 和创建时的重复 model RPC，只保留 fork、tab meta 与 archive；更新原测试断言归档/复用不回归。
- [ ] 运行 `pnpm vitest run tests/model-coordinator.spec.ts tests/sidechat-unified.spec.ts && pnpm typecheck`；预期通过。
- [ ] 提交：`git add src/client/sidechat/model-coordinator.ts src/client/sidechat/session-controller.ts tests/model-coordinator.spec.ts tests/sidechat-unified.spec.ts && git commit -m "feat: coordinate live sidechat model switching"`

### Task 5: Mount registration, live labels, and submit gate

**Files:**
- Modify: `src/client/sidechat/index.tsx`
- Modify: `src/client/sidechat/SideChatPanel.tsx`
- Modify: `src/client/sidechat/composer.ts`
- Modify: `src/client/locales.ts`
- Modify: `src/client/sidechat/sidechat.module.css`
- Test: `tests/sidechat-model-ui.spec.tsx`

- [ ] 写 UI/纯函数测试，验证 renderer 共用一个 coordinator、child 获得后登记并在卸载时注销、模型标签取实际协调器状态、`pending|switching` 时按钮和 Enter 都不提交、ready 后可提交、回答 running 时切模不触发 cancel。
- [ ] 运行 `pnpm vitest run tests/sidechat-model-ui.spec.tsx`；预期失败。
- [ ] 在 `registerSideChat` 生命周期中创建唯一 route store/coordinator，tab component 注入 coordinator，Cordis effect dispose 二者；`onClose` 保持只 release controller/annotation guard。
- [ ] 在 `SideChatPanel` child 绑定后 `register(childId,parentSessionId)`，用 `useSyncExternalStore` 订阅 child 状态，删除旧的一次性 `sessions.models` effect；footer 显示实际 `modelName`，切换时显示本地化“正在切换模型”。
- [ ] 给 `ComposerBar` 增加 `modelReady`；Send 的 disabled 为 `!composer.canSubmit || !modelReady`，Enter 路径在 `!modelReady` 时只 `preventDefault` 不调用 submit；Stop 按钮继续只控制当前回答。
- [ ] 运行 `pnpm vitest run tests/sidechat-model-ui.spec.tsx tests/sidechat-unified.spec.ts && pnpm typecheck`；预期通过。
- [ ] 提交：`git add src/client tests/sidechat-model-ui.spec.tsx && git commit -m "feat: hot switch open sidechat panels"`

### Task 6: Manager panel contract, package metadata, and documentation

**Files:**
- Create: `dsh-management/panel.yaml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `cordis.patch.yml`
- Modify: `README.md`
- Modify: `README_EN.md`
- Create: `docs/changes/2026-08-26-sidechat-model-settings.md`
- Modify: `docs/release/verification.md`
- Modify: `tests/bundle-contract.spec.ts`

- [ ] 先扩充 bundle contract 测试：版本为 `0.3.0`；`files` 含 `dsh-management`/变更文档；panel 是 Contract v2 `model-select`、`default:null`、`allowInherit:true`、`apply:save`、binding 精确指向 `dsh-sidechat/defaultModelRoute`；Host peers 存在；Client bundle purity 保持。
- [ ] 运行 `pnpm vitest run tests/bundle-contract.spec.ts`；预期失败。
- [ ] 从 Manager skill 资产建立 `dsh-management/panel.yaml`，字段文案明确“Manager 保存后立即切换当前已打开 Sidechat；正在生成的回答不取消，下一次请求使用新模型”；`actions: []`。
- [ ] 将 package 版本升到 `0.3.0`，增加 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/schemastery` 的兼容 peers/dev deps 与 optional metadata；移除旧 public `cordis` Host 依赖但保留 Client external 所需的实际 peer；发布文件加入 panel 与 docs。
- [ ] 更新 Cordis patch 让 `config.defaultModelRoute` 可配置且默认为 `null`；更新中英文 README、变更说明和 release verification，写清热载入、回退与生命周期。
- [ ] 运行 `pnpm install --lockfile-only`，再运行 `pnpm vitest run tests/bundle-contract.spec.ts && pnpm typecheck && pnpm build && pnpm pack --dry-run --json`；预期 tarball 清单包含 `dsh-management/panel.yaml` 且 Client purity gate 通过。
- [ ] 提交：`git add package.json pnpm-lock.yaml cordis.patch.yml dsh-management README.md README_EN.md docs tests/bundle-contract.spec.ts && git commit -m "feat: expose sidechat model settings in Manager"`

### Task 7: Disposable-profile integration and regression verification

**Files:**
- Modify: `scripts/e2e-mount.ps1`
- Modify: `tests/e2e/mount.e2e.ts`
- Modify: `playwright.config.ts`

- [ ] 扩展 PowerShell runner 参数为 `ManagerTarball`，在 scratch profile 安装 `dsh-resource-management` 后安装 sidechat；保存/恢复 `DSH_E2E_MANAGER` 与测试模型路由环境变量，保持现有 marker 和临时路径校验。
- [ ] 增加 Playwright 场景：打开 Manager 的 Sidechat 参数页，确认 model-select 从当前目录呈现；打开两个 Sidechat，保存固定模型后不刷新/不重启，等待两个 footer 标签切换；保存继承后验证各 child 收敛到自己的 parent；切换期间当前回答不被 cancel；reload 仍复用 child 并对齐最新设置。
- [ ] 构建 Manager tarball与 Sidechat tarball：

```powershell
pnpm --dir D:\AI\DSH-Plugin-Repositories\dsh-resource-management build
pnpm --dir D:\AI\DSH-Plugin-Repositories\dsh-resource-management pack
pnpm build
pnpm pack
```

- [ ] 使用本机 DSH 运行 disposable profile：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-mount.ps1 `
  -DshCommand D:\AI\DeepSeek-Harness\runtime-0.1.1-rc.2\node_modules\.bin\dsh.cmd `
  -ManagerTarball D:\AI\DSH-Plugin-Repositories\dsh-resource-management\linmu-dsh-resource-management-0.3.3.tgz
```

预期 Manager lane 与既有 fork/history/reload/annotation/multi-tab lane 全通过；若 Manager 实际 tarball 文件名不同，用本次 `pnpm pack` 输出的绝对路径替换命令中的文件名并记录在验证文档。

- [ ] 运行完整质量门：`pnpm typecheck && pnpm test && pnpm build && pnpm pack --dry-run --json`；预期全部通过，无 `.only`、无新增 skip、无 Host import 泄漏到 `lib/client.js`。
- [ ] 提交：`git add scripts/e2e-mount.ps1 tests/e2e/mount.e2e.ts playwright.config.ts docs/release/verification.md && git commit -m "test: verify live sidechat model settings"`

### Task 8: Release, GitHub push, scoped deployment, and live acceptance

**Files:**
- Modify only if evidence needs recording: `docs/release/verification.md`

- [ ] 检查 `git status --short`、`git diff --check`、`git log --oneline --decorate -10`；确认只含本功能提交且工作区干净。
- [ ] 从干净 HEAD 重新运行 `pnpm check && pnpm build`，生成 `pnpm pack` tarball，记录 commit SHA 和包内 panel/Host/client 文件。
- [ ] 推送功能分支：`git push -u origin codex/sidechat-model-settings`；远端成功后 fast-forward `main` 并推送：`git switch main && git merge --ff-only codex/sidechat-model-settings && git push origin main`。
- [ ] 通过 Maintenance Engine 对同一 SHA 生成 deployment preview：

```powershell
$maintenanceCli = 'C:\Users\19717\OneDrive\文档\ChatGPT\dsh\dsh-maintenance-engine\dist\src\cli.js'
$sidechatSha = (& git rev-parse HEAD).Trim()
$previewJson = & node $maintenanceCli `
  --dsh-home D:\AI\DeepSeek-Harness\home --profile web `
  --state-root D:\AI\DSH-Maintenance-State --json `
  plugin deployment-preview '@evylynn/dsh-sidechat' $sidechatSha
$preview = $previewJson | ConvertFrom-Json
$preview.fingerprint
```

确认 preview 目标仅为 `@evylynn/dsh-sidechat`、版本 `0.3.0`、回滚目标为当前 `0.2.0`，并保留 `$preview.fingerprint`。

- [ ] 使用预览返回的精确 fingerprint 执行：

```powershell
& node $maintenanceCli `
  --dsh-home D:\AI\DeepSeek-Harness\home --profile web `
  --state-root D:\AI\DSH-Maintenance-State --json `
  plugin apply '@evylynn/dsh-sidechat' $sidechatSha --preview-fingerprint $preview.fingerprint
```

- [ ] 用当前 profile 的既有启动方式完整重启 `web`，而不是仅刷新浏览器；随后运行 deployment-status，确认 current commit/version/digest 与刚部署候选一致，rollback target 仍指向旧部署。
- [ ] 在真实 Manager 页面执行核心验收：保存固定模型后两个已打开 Sidechat 标签即时更新；切回继承后分别同步 parent；生成中切换不终止回答、下一次提问走新模型；刷新恢复 child；关闭 tab 后归档会话仍可恢复。
- [ ] 若任一真实验收失败，立即运行 `plugin rollback-preview`，使用其 fingerprint 执行 `plugin rollback`，重启 profile 并确认回到 `0.2.0`；成功时把 commit、部署状态、验收结果写入 verification 文档并提交/推送该纯证据更新。

## Final Review Checklist

- [ ] 对照设计规范逐条核查 Settings、Manager、SSE、latest-wins、submit gate、fallback、生命周期、一次性 profile、当前 profile 部署与 rollback 全覆盖。
- [ ] 运行 `rg -n "TODO|FIXME|PLACEHOLDER" src tests dsh-management docs/changes README.md README_EN.md`；实现产物不得含占位符。
- [ ] 运行 `pnpm typecheck && pnpm test && pnpm build && pnpm pack --dry-run --json`，并检查 `git diff --check` 与干净状态。
- [ ] 最终交付报告包含 GitHub 分支/main SHA、0.3.0 包、当前 `web` 部署状态、热切换验收、未中断回答语义、持久/归档恢复和可用 rollback target。
