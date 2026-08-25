import { createRoot } from 'react-dom/client'

import type { Context } from '../../context-types.ts'
import { resolveAnnotationCore } from '../annotation-core-resolver.ts'
import { AnnotateOverlay } from './overlay.tsx'
import { createSelectionController } from './selection.ts'

/** Install only the selection producer. Core owns all reference state and UI. */
export function registerAnnotations(ctx: Context): void {
  ctx.inject(['annotationCore'], (injected) => {
    const ready = injected as Context
    const core = resolveAnnotationCore(ready, ['dsh-message-source-v1'])
    if (core === undefined) {
      console.warn('[dsh-sidechat] compatible dsh-annotation-core unavailable; selection actions are disabled')
      return
    }
    ready.effect(() => {
      const controller = createSelectionController(() => ready.sessions.list.getSnapshot().current ?? '')
      const host = document.createElement('div')
      host.dataset.dshSidechat = ''
      document.body.appendChild(host)
      const root = createRoot(host)
      root.render(<AnnotateOverlay ctx={ready} core={core} controller={controller} />)
      return () => {
        controller.dispose()
        setTimeout(() => { root.unmount() })
        host.remove()
      }
    }, 'dsh-sidechat: annotation producer')
  })
}
