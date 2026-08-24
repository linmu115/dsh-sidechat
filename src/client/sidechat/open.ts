import type { Context } from '../../context-types.ts'
import { collectSideTabs, collectTabs, SIDE_TAB_TYPE } from './model.ts'
import { ensureSideChatSession, readSideChatTab } from './session-controller.ts'

export { readSideChatTab as readTab }

/** Open/focus a side tab and resolve only after its real forked session exists. */
export async function openOrFocusSideChat(
  ctx: Context,
  parentSessionId: string,
): Promise<{ tabId: string; sessionId: string }> {
  const snapshot = ctx.betterSidebar.getSnapshot()
  if (snapshot.sessionId !== parentSessionId || snapshot.state === undefined) {
    throw new Error('The source session is not the active sidebar session')
  }

  const existing = collectSideTabs(snapshot.state)
  let tabId: string
  if (existing.length > 0) {
    tabId = existing[existing.length - 1]!.id
  } else {
    const before = new Set(collectTabs(snapshot.state).map(tab => tab.id))
    ctx.betterSidebar.openTab({ type: SIDE_TAB_TYPE }, { sessionId: parentSessionId })
    const created = collectSideTabs(ctx.betterSidebar.getSnapshot().state).find(tab => !before.has(tab.id))
    if (created === undefined) throw new Error('The side-chat tab could not be created')
    tabId = created.id
  }

  ctx.betterSidebar.activateTab(tabId, { sessionId: parentSessionId })
  const sessionId = await ensureSideChatSession(ctx, tabId, parentSessionId)
  return { tabId, sessionId }
}
