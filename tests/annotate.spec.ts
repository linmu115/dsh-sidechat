import { describe, expect, it } from 'vitest'

import {
  addSelectionReference,
  addSelectionToSideChat,
} from '../src/client/annotate/producer.ts'
import {
  ASSISTANT_KIND,
  USER_KINDS,
  isEligibleSelection,
  roleForMessageKind,
  type SelectionSnapshot,
} from '../src/client/annotate/selection.ts'
import {
  AnnotationSafetyGuard,
  type AnnotationSafetyRecord,
  type AnnotationSafetyRecordStore,
} from '../src/client/annotation-safety-guard.ts'

function selection(overrides: Partial<SelectionSnapshot> = {}): SelectionSnapshot {
  return {
    text: '完整引用内容',
    anchorId: 'input-message:42',
    messageId: 'message-42',
    occurrence: 2,
    role: 'assistant',
    rect: { left: 1, top: 2, width: 3 },
    range: {} as Range,
    sessionId: 'source-session',
    ...overrides,
  }
}

function fakeCore() {
  const captures: unknown[] = []
  const adds: Array<{ sessionId: string; source: unknown; operationId?: string }> = []
  return {
    captures,
    adds,
    version: '0.1.0',
    features: ['dsh-message-source-v1'],
    async createDshMessageSource(capture: unknown) {
      captures.push(capture)
      return { sourceType: 'dsh-message', selectedText: (capture as { selectedText: string }).selectedText, locator: {} }
    },
    async addReference(sessionId: string, source: unknown, options?: { operationId?: string }) {
      adds.push({ sessionId, source, operationId: options?.operationId })
      return { setId: 'set-1', referenceId: 'reference-1', created: true }
    },
    openAnnotation() {},
  }
}

describe('rc.2 selection contract', () => {
  const valid = {
    blank: false,
    sameMessage: true,
    kind: ASSISTANT_KIND,
    streaming: false,
    excluded: false,
    hasSession: true,
    hasAnchor: true,
  }

  it('supports both user and assistant message DOM kinds', () => {
    expect(ASSISTANT_KIND).toBe('assistant-step')
    expect(USER_KINDS).toEqual(new Set(['user', 'steering']))
    expect(roleForMessageKind('assistant-step')).toBe('assistant')
    expect(roleForMessageKind('user')).toBe('user')
    expect(roleForMessageKind('steering')).toBe('user')
    expect(isEligibleSelection(valid)).toBe(true)
    expect(isEligibleSelection({ ...valid, kind: 'user' })).toBe(true)
    expect(isEligibleSelection({ ...valid, kind: 'steering' })).toBe(true)
  })

  it('requires a real source anchor and rejects unsafe selections', () => {
    expect(isEligibleSelection({ ...valid, hasAnchor: false })).toBe(false)
    expect(isEligibleSelection({ ...valid, sameMessage: false })).toBe(false)
    expect(isEligibleSelection({ ...valid, blank: true })).toBe(false)
    expect(isEligibleSelection({ ...valid, kind: 'assistant' })).toBe(false)
    expect(isEligibleSelection({ ...valid, streaming: true })).toBe(false)
    expect(isEligibleSelection({ ...valid, excluded: true })).toBe(false)
    expect(isEligibleSelection({ ...valid, hasSession: false })).toBe(false)
  })
})

describe('unified annotation producer', () => {
  it('passes the complete selection and locator to core without truncation', async () => {
    const core = fakeCore()
    const full = 'x'.repeat(2_000)
    await addSelectionReference({
      core: core as never,
      snapshot: selection({ text: full }),
      targetSessionId: 'current-session',
    })

    expect(core.captures).toEqual([{
      selectedText: full,
      sourceSessionId: 'source-session',
      messageId: 'message-42',
      anchorId: 'input-message:42',
      role: 'assistant',
      occurrence: 2,
    }])
    expect(core.adds).toHaveLength(1)
    expect(core.adds[0]?.sessionId).toBe('current-session')
    expect((core.adds[0]?.source as { selectedText: string }).selectedText).toBe(full)
  })

  it('targets the real forked child session and creates nothing when the fork fails', async () => {
    const core = fakeCore()
    const open = async () => ({ tabId: 'side:1', sessionId: 'real-child' })
    await addSelectionToSideChat({
      core: core as never,
      snapshot: selection(),
      ctx: {} as never,
      openSideChat: open,
      guard: { runAdd: async (_tab: string, _session: string, task: (operationId: string, signal: AbortSignal) => Promise<unknown>) => task('op-1', new AbortController().signal) } as never,
    })
    expect(core.adds[0]).toMatchObject({ sessionId: 'real-child', operationId: 'op-1' })

    const failed = fakeCore()
    await expect(addSelectionToSideChat({
      core: failed as never,
      snapshot: selection(),
      ctx: {} as never,
      openSideChat: async () => { throw new Error('fork failed') },
      guard: {} as never,
    })).rejects.toThrow('fork failed')
    expect(failed.captures).toEqual([])
    expect(failed.adds).toEqual([])
  })
})

class MemorySafetyStore implements AnnotationSafetyRecordStore {
  readonly rows = new Map<string, AnnotationSafetyRecord>()
  async read(sessionId: string) { return this.rows.get(sessionId) }
  async addOperation(sessionId: string, operationId: string) {
    const current = this.rows.get(sessionId)
    const row: AnnotationSafetyRecord = {
      schemaVersion: 1,
      sessionId,
      blocked: true,
      operationIds: [...new Set([...(current?.operationIds ?? []), operationId])],
    }
    this.rows.set(sessionId, row)
    return row
  }
  async deleteIfOperationsMatch(sessionId: string, operationIds: readonly string[]) {
    const current = this.rows.get(sessionId)
    if (current === undefined || JSON.stringify(current.operationIds) !== JSON.stringify(operationIds)) return false
    this.rows.delete(sessionId)
    return true
  }
}

describe('durable sidechat safety guard', () => {
  it('persists only opaque operation ids before an add may start', async () => {
    const store = new MemorySafetyStore()
    const guard = new AnnotationSafetyGuard(store)
    await guard.arm('child', 'operation-a')
    expect(store.rows.get('child')).toEqual({
      schemaVersion: 1,
      sessionId: 'child',
      blocked: true,
      operationIds: ['operation-a'],
    })
    expect(Object.keys(store.rows.get('child') ?? {})).toEqual(['schemaVersion', 'sessionId', 'blocked', 'operationIds'])
  })

  it('does not clear on a stale zero snapshot and clears only after fenced fresh zero', async () => {
    const store = new MemorySafetyStore()
    const guard = new AnnotationSafetyGuard(store)
    await guard.arm('child', 'operation-a')
    const core = {
      fenceReferenceOperation: async () => ({ state: 'canceled' as const, fenceRevision: 5 }),
      readPendingState: async () => ({ revision: 4, pendingCount: 0 }),
    }
    expect(await guard.reconcile('child', core as never)).toBe(false)
    expect(await guard.isBlocked('child')).toBe(true)
    core.readPendingState = async () => ({ revision: 5, pendingCount: 0 })
    expect(await guard.reconcile('child', core as never)).toBe(true)
    expect(await guard.isBlocked('child')).toBe(false)
  })

  it('keeps the guard when an operation cannot be fenced or a pending item remains', async () => {
    const store = new MemorySafetyStore()
    const guard = new AnnotationSafetyGuard(store)
    await guard.arm('child', 'operation-a')
    expect(await guard.reconcile('child', {
      fenceReferenceOperation: async () => { throw new Error('offline') },
      readPendingState: async () => ({ revision: 99, pendingCount: 0 }),
    } as never)).toBe(false)
    expect(await guard.reconcile('child', {
      fenceReferenceOperation: async () => ({ state: 'committed', fenceRevision: 5 }),
      readPendingState: async () => ({ revision: 6, pendingCount: 1 }),
    } as never)).toBe(false)
    expect(await guard.isBlocked('child')).toBe(true)
  })

  it('cancels a host-persisted add whose response is lost and then clears the verified guard', async () => {
    const store = new MemorySafetyStore()
    const guard = new AnnotationSafetyGuard(store)
    let pending = 0
    const discarded: string[] = []
    const core = {
      discardPendingOperation: async (_session: string, operationId: string) => { discarded.push(operationId); pending = 0 },
      fenceReferenceOperation: async () => ({ state: 'canceled' as const, fenceRevision: 3 }),
      readPendingState: async () => ({ revision: 3, pendingCount: pending }),
    }
    await expect(guard.runAdd('side:1', 'child', async () => {
      pending = 1 // Host committed the add, but the Client never receives its response.
      throw new Error('response lost')
    }, core as never)).rejects.toThrow('response lost')
    expect(discarded).toHaveLength(1)
    expect(await guard.isBlocked('child')).toBe(false)
  })

  it('aborts a tab closed before the IndexedDB barrier completes and never starts Host add', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    class SlowStore extends MemorySafetyStore {
      override async addOperation(sessionId: string, operationId: string) {
        await barrier
        return super.addOperation(sessionId, operationId)
      }
    }
    const store = new SlowStore()
    const guard = new AnnotationSafetyGuard(store)
    let hostCalls = 0
    const core = {
      discardPendingOperation: async () => {},
      fenceReferenceOperation: async () => ({ state: 'canceled' as const, fenceRevision: 1 }),
      readPendingState: async () => ({ revision: 1, pendingCount: 0 }),
    }
    const adding = guard.runAdd('side:1', 'child', async () => { hostCalls += 1 }, core as never)
    const closing = guard.closeTab('side:1')
    release()
    await closing
    await expect(adding).rejects.toMatchObject({ name: 'AbortError' })
    expect(hostCalls).toBe(0)
    expect(await guard.isBlocked('child')).toBe(false)
  })
})
