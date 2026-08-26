import type { Context, SidebarTab } from '../../context-types.ts'
import { collectTabs, parseSideChatMeta } from './model.ts'

const pendingByTab = new Map<string, Promise<string>>()
const abortByTab = new Map<string, AbortController>()

export function readSideChatTab(ctx: Context, tabId: string): SidebarTab | undefined {
  return collectTabs(ctx.betterSidebar.getSnapshot().state).find(tab => tab.id === tabId)
}

async function bestEffortArchive(ctx: Context, sessionId: string): Promise<void> {
  try { await ctx.workspaces.archiveSession(sessionId) } catch (error) {
    console.warn('[dsh-sidechat] failed to archive side session:', error)
  }
}

/** Fork and register one durable child session, deduplicated per sidebar tab. */
export function ensureSideChatSession(ctx: Context, tabId: string, parentSessionId: string): Promise<string> {
  const registered = parseSideChatMeta(readSideChatTab(ctx, tabId)?.meta).childId
  if (registered !== undefined) return Promise.resolve(registered)
  const current = pendingByTab.get(tabId)
  if (current !== undefined) return current

  const controller = new AbortController()
  abortByTab.set(tabId, controller)
  const operation = (async () => {
    const childId = await ctx.sessions.fork({ sessionId: parentSessionId })
    if (controller.signal.aborted) {
      await bestEffortArchive(ctx, childId)
      throw new DOMException('Side-chat tab closed while forking', 'AbortError')
    }
    const latest = parseSideChatMeta(readSideChatTab(ctx, tabId)?.meta)
    ctx.betterSidebar.updateTab(tabId, {
      meta: { ...latest, childId, parentSessionId },
    })
    await bestEffortArchive(ctx, childId)
    return childId
  })().finally(() => {
    if (pendingByTab.get(tabId) === operation) pendingByTab.delete(tabId)
    if (abortByTab.get(tabId) === controller) abortByTab.delete(tabId)
  })
  pendingByTab.set(tabId, operation)
  return operation
}

export function releaseSideChatSession(tabId: string): void {
  abortByTab.get(tabId)?.abort()
  abortByTab.delete(tabId)
  pendingByTab.delete(tabId)
}

export function resetSideChatSessionControllersForTests(): void {
  for (const controller of abortByTab.values()) controller.abort()
  abortByTab.clear()
  pendingByTab.clear()
}
