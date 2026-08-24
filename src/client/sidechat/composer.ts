import type {
  AnnotationCoreClient,
  EmbeddedComposerHandle,
  PlainComposerPort,
  PlainComposerSnapshot,
  PlainSubmitResult,
} from 'dsh-annotation-core/client-api'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import type { SessionFace } from '../../context-types.ts'
import { annotationSafetyGuard } from '../annotation-safety-guard.ts'

const NOOP_UNSUBSCRIBE = (): void => {}

export class RevisionedPlainComposerPort implements PlainComposerPort {
  private snapshot: PlainComposerSnapshot = { draft: '', revision: 0 }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly session: () => SessionFace | undefined) {}

  getSnapshot(): PlainComposerSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  setDraft(text: string): void {
    if (text === this.snapshot.draft) return
    this.snapshot = { draft: text, revision: this.snapshot.revision + 1 }
    for (const listener of [...this.listeners]) listener()
  }

  async submitPlain(input: { text: string; revision: number }): Promise<PlainSubmitResult> {
    const submittedRevision = input.revision
    if (this.snapshot.revision !== input.revision || this.snapshot.draft !== input.text) {
      return { kind: 'error', submittedRevision, message: 'Draft changed before submission' }
    }
    if (input.text.trim() === '') return { kind: 'error', submittedRevision, message: 'Message is empty' }
    const session = this.session()
    if (session === undefined) return { kind: 'error', submittedRevision, message: 'Side session is unavailable' }
    try {
      const response = await session.prompt([{ type: 'text', text: input.text }], 'queue')
      const envelope = response as { ok?: boolean; error?: { message?: string } } | undefined
      if (envelope?.ok === false) {
        return { kind: 'error', submittedRevision, message: envelope.error?.message ?? 'Send failed' }
      }
      if (this.snapshot.revision === input.revision && this.snapshot.draft === input.text) this.setDraft('')
      return { kind: 'success', submittedRevision }
    } catch (error) {
      return { kind: 'error', submittedRevision, message: error instanceof Error ? error.message : 'Send failed' }
    }
  }
}

export interface Composer {
  readonly draft: string
  readonly sendError: string | null
  readonly canSubmit: boolean
  readonly referenceRail: ReactNode
  readonly transport: 'core' | 'plain' | 'blocked'
  setDraft(text: string): void
  submit(): Promise<void>
}

export function bindSharedSideChatComposer(
  core: Pick<AnnotationCoreClient, 'bindComposer'>,
  sessionId: string,
  plainPort: PlainComposerPort,
): EmbeddedComposerHandle {
  return core.bindComposer({ sessionId, layout: 'narrow', plainPort })
}

export function fallbackTransport(coreAvailable: boolean, guardBlocked: boolean): 'core' | 'plain' | 'blocked' {
  if (coreAvailable) return 'core'
  return guardBlocked ? 'blocked' : 'plain'
}

function useHandleSnapshot(handle: EmbeddedComposerHandle | undefined) {
  return useSyncExternalStore(
    useCallback((notify: () => void) => handle?.subscribe(notify) ?? NOOP_UNSUBSCRIBE, [handle]),
    () => handle?.getSnapshot(),
  )
}

/** Shared-core narrow composer with a revisioned plain fallback. */
export function useComposer(session: SessionFace | undefined, childId: string | undefined, core: AnnotationCoreClient | undefined): Composer {
  const sessionRef = useRef(session)
  sessionRef.current = session
  const port = useMemo(() => new RevisionedPlainComposerPort(() => sessionRef.current), [childId])
  const handle = useMemo(
    () => childId === undefined || core === undefined
      ? undefined
      : bindSharedSideChatComposer(core, childId, port),
    [childId, core, port],
  )
  useEffect(() => () => { handle?.dispose() }, [handle])

  const handleSnapshot = useHandleSnapshot(handle)
  const plainSnapshot = useSyncExternalStore(
    useCallback((notify: () => void) => port.subscribe(notify), [port]),
    () => port.getSnapshot(),
  )
  const [guardBlocked, setGuardBlocked] = useState(childId !== undefined)
  const [plainError, setPlainError] = useState<string | null>(null)

  useEffect(() => {
    if (childId === undefined) { setGuardBlocked(false); return }
    let active = true
    void annotationSafetyGuard.isBlocked(childId).then(blocked => { if (active) setGuardBlocked(blocked) })
    return () => { active = false }
  }, [childId])

  useEffect(() => {
    if (childId === undefined || core === undefined || handleSnapshot?.pendingCount !== 0 || !guardBlocked) return
    let active = true
    void annotationSafetyGuard.reconcile(childId, core)
      .then(cleared => { if (active && cleared) setGuardBlocked(false) })
      .catch(() => {})
    return () => { active = false }
  }, [childId, core, handleSnapshot?.pendingCount, guardBlocked])

  if (handle !== undefined && handleSnapshot !== undefined) {
    return {
      draft: handleSnapshot.visibleDraft,
      sendError: handleSnapshot.error ?? null,
      canSubmit: handleSnapshot.canSubmit,
      referenceRail: handle.renderReferenceRail(),
      transport: 'core',
      setDraft: text => { handle.setVisibleDraft(text) },
      submit: async () => { await handle.submit() },
    }
  }

  const blocked = fallbackTransport(false, childId !== undefined && guardBlocked) === 'blocked'
  return {
    draft: plainSnapshot.draft,
    sendError: plainError,
    canSubmit: !blocked && plainSnapshot.draft.trim() !== '',
    referenceRail: null,
    transport: blocked ? 'blocked' : 'plain',
    setDraft: text => { setPlainError(null); port.setDraft(text) },
    submit: async () => {
      if (blocked) { setPlainError('Annotation state is unavailable; plain fallback is blocked to protect context.'); return }
      const current = port.getSnapshot()
      const result = await port.submitPlain({ text: current.draft, revision: current.revision })
      setPlainError(result.kind === 'error' ? result.message : null)
    },
  }
}
