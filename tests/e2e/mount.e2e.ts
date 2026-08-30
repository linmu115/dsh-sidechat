import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, request, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) throw new Error('DSH_E2E_URL is not set — run via scripts/e2e-mount.sh')
const LAUNCH_URL = new URL(BASE_URL)
const ORIGIN = LAUNCH_URL.origin
const CORE_MODE = process.env.DSH_E2E_CORE_MODE ?? 'compatible'
const MANAGER_AVAILABLE = process.env.DSH_E2E_MANAGER === '1'
const PLUGIN_CONSOLE = /dsh-sidechat|dsh-annotation-core|Unhandled/

let hostApi: APIRequestContext | undefined
let authCookie: string | undefined

async function prepareAlphaHost(): Promise<void> {
  if (LAUNCH_URL.searchParams.has('token')) {
    const exchange = await fetch(BASE_URL!, { redirect: 'manual' })
    const setCookie = exchange.headers.get('set-cookie')
    if (setCookie === null) {
      throw new Error(`DSH token exchange failed: HTTP ${exchange.status} carried no set-cookie`)
    }
    authCookie = setCookie.split(';', 1)[0]
  }

  hostApi = await request.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: authCookie === undefined ? {} : { cookie: authCookie },
  })
  const workspacePath = process.env.DSH_E2E_WORKSPACE
  if (workspacePath === undefined) return
  const response = await hostApi.post('/api/workspace/create', {
    data: {
      type: 'client-request',
      rpcId: 'e2e-workspace',
      method: 'workspace/create',
      payload: { args: { request: { path: workspacePath } } },
    },
  })
  const body = await response.text()
  if (!response.ok() || !body.includes('"ok":true')) {
    throw new Error(`workspace/create failed: HTTP ${response.status()} ${body.slice(0, 400)}`)
  }
}

interface RouteSnapshot {
  revision: number
  route: null | { provider: string; model: string; reasoningEffort?: string }
}

async function dumpStep(page: Page, name: string): Promise<void> {
  try {
    mkdirSync('test-results/steps', { recursive: true })
    await page.screenshot({ path: `test-results/steps/${name}.png`, fullPage: false })
    writeFileSync(`test-results/steps/${name}.yml`, await page.locator('body').ariaSnapshot())
  } catch {}
}

async function dismissOnboarding(page: Page): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    let clicked = false
    for (const name of ['Continue', 'Configure later', '继续', '稍后再说']) {
      const button = page.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
      if (await button.isVisible().catch(() => false)) {
        try {
          // The rc.2 notice owns a full-screen mask during its opening
          // transition. A forced coordinate click still lands on that mask,
          // so invoke the known onboarding button itself in this test lane.
          await button.evaluate(element => (element as HTMLButtonElement).click())
          clicked = true
          await page.waitForTimeout(500)
        } catch {}
      }
    }
    if (!clicked) await page.waitForTimeout(250)
  }

  // A credential-free disposable profile can reject the notice acknowledgement
  // RPC. Keep the official modal mounted, but neutralize only its presentation
  // layer so this lane can test the three candidate plugins underneath it.
  const notice = page.getByRole('dialog', { name: /Internal Testing Notice|内部测试/ }).first()
  if (await notice.isVisible().catch(() => false)) {
    await notice.evaluate((element) => {
      const presentation = element.closest('[role="presentation"]') as HTMLElement | null
      if (presentation) {
        presentation.style.setProperty('display', 'none', 'important')
        presentation.style.setProperty('pointer-events', 'none', 'important')
      }
    })
  }
}

async function ensureSidebarExpanded(page: Page): Promise<void> {
  const expand = page.getByRole('button', { name: /Expand sidebar|展开/ }).first()
  if (await expand.count()) { await expand.click(); await page.waitForTimeout(500) }
}

async function openPlusMenu(page: Page): Promise<void> {
  await ensureSidebarExpanded(page)
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await sidebar.getByRole('button', { name: /New tab|新建|新标签/ }).first().click({ timeout: 10_000 })
}

async function readModelRoute(page: Page): Promise<RouteSnapshot> {
  return await page.evaluate(async () => {
    const response = await fetch('/plugins/dsh-sidechat/model-route', {
      cache: 'no-store', credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`model route snapshot failed: ${response.status}`)
    return await response.json() as RouteSnapshot
  })
}

async function saveManagerDraft(page: Page, manager: Locator): Promise<void> {
  const response = page.waitForResponse((candidate) => {
    if (!candidate.url().endsWith('/dsh-resource-management/api')) return false
    const body = candidate.request().postData() ?? ''
    return body.includes('"method":"save"')
  })
  await manager.getByRole('button', { name: '保存更改', exact: true }).click()
  expect((await response).ok()).toBe(true)
}

async function openSeedSession(page: Page): Promise<void> {
  const openSidebar = page.getByRole('button', { name: 'Open sidebar' }).first()
  if (await openSidebar.count()) { await openSidebar.click(); await page.waitForTimeout(500) }
  let row = page.getByText('Side chat plugin review').first()
  if ((await row.count()) === 0) row = page.locator('[role="treeitem"]:not([aria-expanded])', { hasText: /workspace/ }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(page.getByText(/Forking into a side panel is the right call/).first()).toBeVisible({ timeout: 30_000 })
}

async function injectSelection(page: Page, needle = 'full history snapshot'): Promise<void> {
  const ok = await page.evaluate((selected) => {
    for (const message of document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')) {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf(selected)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at); range.setEnd(node, at + selected.length)
        const selection = window.getSelection()
        selection?.removeAllRanges(); selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return true
      }
    }
    return false
  }, needle)
  expect(ok, 'unable to inject an rc.2 message selection').toBe(true)
}

function collectErrors(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const state = { pageErrors: [] as string[], consoleErrors: [] as string[] }
  page.on('pageerror', error => state.pageErrors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') state.consoleErrors.push(message.text()) })
  return state
}

function mainComposer(page: Page): Locator {
  // Alpha.1's native composer no longer exposes the rc.x accessible name.
  // Keep this tied to editable controls instead of a translated label; the
  // conversation is already open before callers use it.
  return page.locator('textarea:visible, [contenteditable="true"]:visible').last()
}

function expectClean(errors: ReturnType<typeof collectErrors>): void {
  expect(errors.pageErrors).toEqual([])
  expect(errors.consoleErrors.filter(text => PLUGIN_CONSOLE.test(text))).toEqual([])
}

test.beforeAll(async () => {
  await prepareAlphaHost()
})

test.afterAll(async () => {
  await hostApi?.dispose()
})

test.beforeEach(async ({ page }) => {
  if (authCookie !== undefined) {
    const separator = authCookie.indexOf('=')
    await page.context().addCookies([{
      name: authCookie.slice(0, separator),
      value: authCookie.slice(separator + 1),
      url: ORIGIN,
    }])
  }
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await dismissOnboarding(page)
})

test('mounts the available plugin set without a client crash', async ({ page }) => {
  const errors = collectErrors(page)
  await openPlusMenu(page)
  await expect(page.getByRole('menuitem', { name: /Side chat/ }).first()).toHaveCount(1)
  await page.keyboard.press('Escape')
  expectClean(errors)
})

test('forks a real child, renders history, and restores it after reload', async ({ page }) => {
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  const errors = collectErrors(page)
  await openSeedSession(page)
  await openPlusMenu(page)
  await page.getByRole('menuitem', { name: /Side chat/ }).first().click()
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar.getByText(/full history snapshot/).first()).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(2_000)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)
  await expect(sidebar.getByText(/full history snapshot/).first()).toBeVisible({ timeout: 90_000 })
  expectClean(errors)
})

test('main reference uses a clean shared rail and renumbers after deletion', async ({ page }) => {
  test.skip(CORE_MODE !== 'compatible', 'compatible annotation core required')
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  const errors = collectErrors(page)
  await openSeedSession(page)
  const overlay = page.locator('[data-dsh-sidechat]')
  await injectSelection(page)
  await page.waitForTimeout(500)
  await expect(overlay.getByText('Add to conversation')).toBeVisible({ timeout: 10_000 })
  await overlay.getByText('Add to conversation').click()
  await expect(page.locator('[data-annotation-chip]')).toHaveCount(1, { timeout: 15_000 })

  const composer = mainComposer(page)
  await expect(composer).toBeVisible({ timeout: 15_000 })
  const draft = await composer.evaluate((element) =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element.textContent ?? '')
  expect(draft).not.toContain('full history snapshot')
  expect(draft).not.toContain('@')

  await page.getByRole('button', { name: '打开注释 1' }).click()
  const comment = page.locator('.dshAnnotationComment').first()
  await expect(comment).toBeVisible()
  await comment.fill('watch the memory cost')
  await comment.blur()
  await page.getByRole('button', { name: '关闭注释详情' }).click()

  await injectSelection(page, 'the right call')
  await overlay.getByText('Add to conversation').click()
  await expect(page.locator('[data-annotation-chip]')).toHaveCount(2, { timeout: 15_000 })
  await page.getByRole('button', { name: '删除注释 1' }).click()
  await expect(page.locator('[data-annotation-chip]')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByRole('button', { name: '打开注释 1' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '打开注释 2' })).toHaveCount(0)
  await dumpStep(page, 'annotation-shared-rail')
  expectClean(errors)
})

test('sidechat reference targets the real child and leaves its textarea clean', async ({ page }) => {
  test.skip(CORE_MODE !== 'compatible', 'compatible annotation core required')
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  const errors = collectErrors(page)
  await openSeedSession(page)
  await injectSelection(page)
  const overlay = page.locator('[data-dsh-sidechat]')
  await overlay.getByText('Ask in side chat').click()

  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar.getByText(/full history snapshot/).first()).toBeVisible({ timeout: 60_000 })
  await expect(sidebar.locator('[data-annotation-chip]')).toHaveCount(1, { timeout: 20_000 })
  const sideComposer = sidebar.getByRole('textbox').first()
  await expect(sideComposer).toHaveValue('')
  await expect(sidebar.getByRole('button', { name: '打开注释 1' })).toHaveCount(1)
  await dumpStep(page, 'sidechat-shared-rail')
  expectClean(errors)
})

test('ordinary sidechat remains usable without a compatible annotation core', async ({ page }) => {
  test.skip(CORE_MODE === 'compatible', 'fault lane only')
  const errors = collectErrors(page)
  await openSeedSession(page)
  await openPlusMenu(page)
  await page.getByRole('menuitem', { name: /Side chat/ }).first().click()
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar.getByText(/full history snapshot/).first()).toBeVisible({ timeout: 60_000 })
  const composer = sidebar.getByRole('textbox').first()
  await composer.fill('plain fallback remains available')
  await expect(composer).toHaveValue('plain fallback remains available')
  await expect(sidebar.locator('[data-annotation-chip]')).toHaveCount(0)
  expectClean(errors)
})

test('multiple manual tabs keep independent real child sessions', async ({ page }) => {
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  await openSeedSession(page)
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await openPlusMenu(page); await page.getByRole('menuitem', { name: /Side chat/ }).first().click()
  await expect(sidebar.getByText(/full history snapshot/).first()).toBeVisible({ timeout: 60_000 })
  await openPlusMenu(page); await page.getByRole('menuitem', { name: /Side chat/ }).first().click()
  await expect(sidebar.getByText('Side 2', { exact: true })).toBeVisible({ timeout: 30_000 })
})

test('Manager model-select hot-switches every mounted sidechat and persists inheritance', async ({ page }) => {
  test.skip(!MANAGER_AVAILABLE, 'dsh-resource-management tarball not installed')
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  const errors = collectErrors(page)
  await openSeedSession(page)

  const panels = page.locator('[data-dsh-sidechat-panel]')
  for (let expected = 1; expected <= 2; expected += 1) {
    await openPlusMenu(page)
    await page.getByRole('menuitem', { name: /Side chat/ }).first().click()
    await expect(panels).toHaveCount(expected, { timeout: 60_000 })
  }
  const labels = panels.locator('[data-sidechat-model-label]')
  await expect.poll(async () => labels.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sidechat-model-phase'))))
    .toEqual(['ready', 'ready'])
  const initialLabels = (await labels.allTextContents()).sort()
  const initialChildren = (await panels.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sidechat-child-id')).sort()))
  expect(initialChildren.every(Boolean)).toBe(true)
  expect(new Set(initialChildren).size).toBe(2)
  const initialRoute = await readModelRoute(page)

  await openPlusMenu(page)
  await page.getByRole('menuitem', { name: '插件管理', exact: true }).click()
  const manager = page.locator('.dsh-management-shell[data-resource-kind="plugin"]')
  await expect(manager).toBeVisible({ timeout: 60_000 })
  await manager.getByPlaceholder('搜索插件').fill('dsh-sidechat')
  const card = manager.locator('[data-resource-id="plugin:@evylynn/dsh-sidechat"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()
  await manager.getByRole('button', { name: '参数设置', exact: true }).click()
  await expect(manager.getByRole('heading', { name: '侧边会话模型', exact: true })).toBeVisible()

  const trigger = manager.locator('.dsh-management-model-trigger')
  await expect(trigger).toHaveText(/跟随主会话/)
  await trigger.click()
  const modelButtons = manager.locator('.dsh-management-model-list button')
  await expect(modelButtons.nth(1)).toBeVisible({ timeout: 30_000 })
  await modelButtons.nth(1).click()
  await trigger.click()
  await saveManagerDraft(page, manager)

  await expect.poll(async () => (await readModelRoute(page)).revision).toBeGreaterThan(initialRoute.revision)
  const fixed = await readModelRoute(page)
  expect(fixed.route).not.toBeNull()
  await expect.poll(async () => labels.evaluateAll(nodes => nodes.map(node => ({
    phase: node.getAttribute('data-sidechat-model-phase'),
    revision: Number(node.getAttribute('data-sidechat-model-revision')),
    text: node.textContent ?? '',
  })))).toEqual([
    { phase: 'ready', revision: fixed.revision, text: expect.stringContaining(fixed.route!.model) },
    { phase: 'ready', revision: fixed.revision, text: expect.stringContaining(fixed.route!.model) },
  ])

  await trigger.click()
  await manager.getByRole('button', { name: /跟随主会话/ }).click()
  await trigger.click()
  await saveManagerDraft(page, manager)
  await expect.poll(async () => (await readModelRoute(page)).revision).toBeGreaterThan(fixed.revision)
  const inherited = await readModelRoute(page)
  expect(inherited.route).toBeNull()
  await expect.poll(async () => labels.evaluateAll(nodes => nodes.map(node => ({
    phase: node.getAttribute('data-sidechat-model-phase'),
    revision: Number(node.getAttribute('data-sidechat-model-revision')),
  })))).toEqual([
    { phase: 'ready', revision: inherited.revision },
    { phase: 'ready', revision: inherited.revision },
  ])
  expect((await labels.allTextContents()).sort()).toEqual(initialLabels)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)
  await expect(panels).toHaveCount(2, { timeout: 90_000 })
  const restoredChildren = await panels.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sidechat-child-id')).sort())
  expect(restoredChildren).toEqual(initialChildren)
  await expect.poll(async () => panels.locator('[data-sidechat-model-label]').evaluateAll(nodes => nodes.map(
    node => Number(node.getAttribute('data-sidechat-model-revision')),
  ))).toEqual([inherited.revision, inherited.revision])
  expectClean(errors)
})

test('/side command opens the side chat', async ({ page }) => {
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  await openSeedSession(page)
  const composer = mainComposer(page)
  await expect(composer).toBeVisible({ timeout: 15_000 })
  await composer.click(); await page.keyboard.type('/')
  const entry = page.getByRole('option', { name: /side/ }).first()
  await expect(entry).toBeVisible({ timeout: 10_000 }); await entry.click()
  await page.getByText('New side chat').first().click()
  await expect(page.locator('[data-dsh-better-sidebar]').getByText(/full history snapshot/).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 })
})
