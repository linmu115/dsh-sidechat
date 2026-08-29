import { describe, expect, it } from 'vitest'

import {
  RevisionedPlainComposerPort,
  bindSharedSideChatComposer,
  fallbackTransport,
} from '../src/client/sidechat/composer.ts'
import {
  ensureSideChatSession,
  resetSideChatSessionControllersForTests,
} from '../src/client/sidechat/session-controller.ts'
import { transcriptEntriesOf } from '../src/client/sidechat/model.ts'
import { handleSideChatAnswerLink } from '../src/client/sidechat/answer-link.ts'

function sideState(meta?: unknown) {
  return {
    splits: {
      kind: 'leaf', id: 'leaf', active: 'side:1',
      tabs: [{ id: 'side:1', type: 'dsh-sidechat:side', title: 'Side', meta }],
    },
    bottomSplits: { kind: 'leaf', id: 'bottom', active: null, tabs: [] },
  }
}

describe('sidechat session controller', () => {
  it('deduplicates concurrent fork requests and resolves the real child session', async () => {
    resetSideChatSessionControllersForTests()
    let state = sideState()
    let forks = 0
    let resolveFork!: (id: string) => void
    const forked = new Promise<string>(resolve => { resolveFork = resolve })
    const archived: string[] = []
    const ctx = {
      sessions: { fork: async () => { forks += 1; return forked } },
      workspaces: { archiveSession: async (id: string) => { archived.push(id) } },
      betterSidebar: {
        getSnapshot: () => ({ sessionId: 'parent', state }),
        updateTab: (_id: string, patch: { meta?: unknown }) => { state = sideState(patch.meta) },
      },
    }
    const first = ensureSideChatSession(ctx as never, 'side:1', 'parent')
    const second = ensureSideChatSession(ctx as never, 'side:1', 'parent')
    expect(forks).toBe(1)
    resolveFork('child-real')
    await expect(Promise.all([first, second])).resolves.toEqual(['child-real', 'child-real'])
    expect(archived).toEqual(['child-real'])
    expect((state.splits.tabs[0]?.meta as { childId?: string }).childId).toBe('child-real')
  })

  it('reuses a registered child without forking', async () => {
    resetSideChatSessionControllersForTests()
    const ctx = {
      sessions: { fork: async () => { throw new Error('must not fork') } },
      betterSidebar: { getSnapshot: () => ({ state: sideState({ childId: 'existing', parentSessionId: 'parent' }) }) },
    }
    await expect(ensureSideChatSession(ctx as never, 'side:1', 'parent')).resolves.toBe('existing')
  })
})

describe('revisioned plain composer port', () => {
  it('submits and clears only the captured revision', async () => {
    const prompts: string[] = []
    const port = new RevisionedPlainComposerPort(() => ({
      prompt: async (parts: Array<{ text: string }>) => { prompts.push(parts[0]!.text); return { ok: true } },
    } as never))
    port.setDraft('plain question')
    const snapshot = port.getSnapshot()
    await expect(port.submitPlain({ text: snapshot.draft, revision: snapshot.revision })).resolves.toEqual({
      kind: 'success', submittedRevision: snapshot.revision,
    })
    expect(prompts).toEqual(['plain question'])
    expect(port.getSnapshot().draft).toBe('')
  })

  it('retains a newer draft and retains text on transport failure', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const port = new RevisionedPlainComposerPort(() => ({
      prompt: async () => { await pending; return { ok: true } },
    } as never))
    port.setDraft('old')
    const old = port.getSnapshot()
    const submission = port.submitPlain({ text: old.draft, revision: old.revision })
    port.setDraft('new')
    release()
    await submission
    expect(port.getSnapshot().draft).toBe('new')

    const failing = new RevisionedPlainComposerPort(() => ({
      prompt: async () => { throw new Error('offline') },
    } as never))
    failing.setDraft('keep me')
    const state = failing.getSnapshot()
    await expect(failing.submitPlain({ text: state.draft, revision: state.revision })).resolves.toMatchObject({ kind: 'error' })
    expect(failing.getSnapshot().draft).toBe('keep me')
  })
})

describe('shared embedded composer contract', () => {
  it('binds the core narrow layout, exposes the shared rail, and delegates disposal', () => {
    const calls: unknown[] = []
    let disposed = false
    const handle = {
      getSnapshot: () => ({ visibleDraft: '', pendingCount: 1, canSubmit: false, commitState: 'idle', transport: 'core-host', fallbackPolicy: 'native-required' }),
      subscribe: () => () => {},
      setVisibleDraft() {},
      submit: async () => {},
      renderReferenceRail: () => 'shared rail',
      dispose: () => { disposed = true },
    }
    const core = { bindComposer: (options: unknown) => { calls.push(options); return handle } }
    const port = new RevisionedPlainComposerPort(() => undefined)
    const bound = bindSharedSideChatComposer(core as never, 'child', port)
    expect(calls).toEqual([{ sessionId: 'child', layout: 'narrow', plainPort: port }])
    expect(bound.renderReferenceRail()).toBe('shared rail')
    bound.dispose()
    expect(disposed).toBe(true)
  })

  it('allows plain fallback only for a clean guard; core loss with uncertain state blocks', () => {
    expect(fallbackTransport(true, true)).toBe('core')
    expect(fallbackTransport(false, false)).toBe('plain')
    expect(fallbackTransport(false, true)).toBe('blocked')
  })
})

describe('embedded conversation projection', () => {
  it('delegates native custom Chat nodes to core and merges them with legacy rows', () => {
    const calls: unknown[] = []
    const core = {
      renderConversationNode(input: { node: unknown }) {
        calls.push(input.node)
        const node = input.node as { kind?: string; anchorSeq?: number }
        return node.kind === 'dsh-annotation'
          ? { key: `annotation:${node.anchorSeq}`, node: 'shared annotation bubble' }
          : undefined
      },
    }
    const entries = transcriptEntriesOf({
      nodes: [
        { kind: 'user', seq: 1, content: [{ type: 'text', text: 'question' }] },
        { kind: 'assistant', seq: 3, blocks: [{ kind: 'text', text: 'answer' }] },
      ],
      chatNodes: [{ key: 'annotation-context', kind: 'dsh-annotation', anchorSeq: 2, data: { count: 1 } }],
      running: false,
      sessionId: 'child',
    } as never, core as never, 'child')
    expect(calls).toHaveLength(1)
    expect(entries.map(entry => entry.key)).toEqual(['u:1', 'annotation:2', 'a:3'])
    expect(entries[1]).toMatchObject({ kind: 'custom', node: 'shared annotation bubble' })
  })
})

describe('sidechat answer links', () => {
  it('routes real Markdown hrefs through the shared core handler', () => {
    const calls: unknown[] = []
    const core = { handleAnswerLink: (sessionId: string, href: string) => { calls.push([sessionId, href]); return true } }
    expect(handleSideChatAnswerLink(core as never, 'child', 'dsh-annotation://set/1')).toBe(true)
    expect(calls).toEqual([['child', 'dsh-annotation://set/1']])
    expect(handleSideChatAnswerLink(undefined, 'child', 'https://example.com')).toBe(false)
  })
})
