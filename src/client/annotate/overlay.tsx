import type { AnnotationCoreClient } from 'dsh-annotation-core/client-api'
import { Component, useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import type { Context } from '../../context-types.ts'
import { t, useLocaleTick } from '../locales.ts'
import { addSelectionReference, addSelectionToSideChat } from './producer.ts'
import type { SelectionController, SelectionSnapshot } from './selection.ts'
import css from './annotate.module.css'

interface OverlayProps {
  readonly ctx: Context
  readonly core: AnnotationCoreClient
  readonly controller: SelectionController
}

export class AnnotateErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  override componentDidCatch(error: unknown): void { console.error('[dsh-sidechat] annotation overlay crashed:', error) }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}

export function AnnotateOverlay(props: OverlayProps): ReactNode {
  return <AnnotateErrorBoundary><AnnotateOverlayInner {...props} /></AnnotateErrorBoundary>
}

function AnnotateOverlayInner({ ctx, core, controller }: OverlayProps): ReactNode {
  useLocaleTick()
  const state = useSyncExternalStore(
    useCallback((notify: () => void) => controller.subscribe(notify), [controller]),
    () => controller.getSnapshot(),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshot = state.selection
  if (snapshot === null) return null

  const finish = (): void => {
    controller.clear()
    window.getSelection()?.removeAllRanges()
  }
  const run = async (action: (selection: SelectionSnapshot) => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await action(snapshot); finish() }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('referenceFailed')) }
    finally { setBusy(false) }
  }
  const x = snapshot.rect.left + snapshot.rect.width / 2
  const y = Math.max(8, snapshot.rect.top - 10)
  return (
    <div className={css.toolbarWrap} style={{ left: x, top: y }}>
      <div className={css.toolbar} role="toolbar" aria-label={t('toolbarAria')}>
        <button type="button" disabled={busy} onMouseDown={event => { event.preventDefault() }} onClick={() => {
          void run(selection => addSelectionReference({ core, snapshot: selection, targetSessionId: selection.sessionId }))
        }}>{t('addToConversation')}</button>
        <button type="button" disabled={busy} onMouseDown={event => { event.preventDefault() }} onClick={() => {
          void run(selection => addSelectionToSideChat({ core, snapshot: selection, ctx }))
        }}>{t('askInSideChat')}</button>
      </div>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </div>
  )
}
