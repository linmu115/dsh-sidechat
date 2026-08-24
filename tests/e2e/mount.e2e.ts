import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) throw new Error('DSH_E2E_URL is not set — run via scripts/e2e-mount.sh')
const CORE_MODE = process.env.DSH_E2E_CORE_MODE ?? 'compatible'
const PLUGIN_CONSOLE = /dsh-sidechat|dsh-annotation-core|Unhandled/

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

function expectClean(errors: ReturnType<typeof collectErrors>): void {
  expect(errors.pageErrors).toEqual([])
  expect(errors.consoleErrors.filter(text => PLUGIN_CONSOLE.test(text))).toEqual([])
}

test.beforeEach(async ({ page }) => {
  await page.goto(BASE_URL!, { waitUntil: 'domcontentloaded' })
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

  const composer = page.getByRole('textbox', { name: /Message the agent|输入消息|随心输入/ }).first()
  const draft = await composer.inputValue().catch(async () => composer.textContent() ?? '')
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

test('/side command opens the side chat', async ({ page }) => {
  test.skip(!process.env.DSH_E2E_SEED_SESSION, 'no seeded session')
  await openSeedSession(page)
  const composer = page.getByRole('textbox', { name: /Message the agent|输入消息|随心输入/ }).first()
  await composer.click(); await page.keyboard.type('/')
  const entry = page.getByRole('option', { name: /side/ }).first()
  await expect(entry).toBeVisible({ timeout: 10_000 }); await entry.click()
  await page.getByText('New side chat').first().click()
  await expect(page.locator('[data-dsh-better-sidebar]').getByText(/full history snapshot/).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 })
})
