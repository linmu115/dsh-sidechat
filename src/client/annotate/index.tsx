/**
 * Workitem 02 — 划选注释：selection listener + numbered badges + annotation
 * editor + the composer「N 条注释」chip. Wiring only: one annotation store,
 * one selection controller, one overlay React root (appended to document.body
 * and marked `data-dsh-sidechat` so the listener excludes our own DOM), and
 * one `conversation.input.dock` slot entry. 全部 additive、页面级生命周期,
 * and every seam degrades to a logged no-op instead of crashing the host page.
 *
 * 整个模块包在一个 ctx.effect 里：HMR/插件禁用时 fiber 撤销即全部清理
 * （store 退订、document 监听器移除、overlay unmount、host div 移除、受管
 * 草稿头清空）——否则重挂后双重挂载（两层工具条、双份监听、新旧 store
 * 分裂）。slot 注册的 disposer 由 cordis 服务代理路由进调用方 fiber，
 * 无需手动回收。
 */
import { createRoot } from 'react-dom/client'
import type { Context } from '../../context-types.ts'
import { createAnnotationStore } from './model.ts'
import { createSelectionController } from './selection.ts'
import { AnnotateOverlay } from './overlay.tsx'
import { createAnnotationChip } from './chip.tsx'
import {
  clearAllReferences,
  registerAnnotationReferenceSource,
  syncAllReferences,
} from './draft.ts'

export function registerAnnotations(ctx: Context): void {
  ctx.effect(() => {
    try {
      const store = createAnnotationStore()
      const controller = createSelectionController(() => ctx.sessions.list.getSnapshot().current ?? '')
      const unregisterReferenceSource = registerAnnotationReferenceSource(ctx, store)

      // The overlay root: toolbar + badges + highlight + editor.
      const host = document.createElement('div')
      host.dataset.dshSidechat = ''
      document.body.appendChild(host)
      const root = createRoot(host)
      root.render(<AnnotateOverlay ctx={ctx} store={store} controller={controller} />)

      // 发送携带：草稿只保存一个 DSH 原生引用占位符；真正的引用块由注册的
      // codec 在发送瞬间序列化，因此输入框不再暴露大段 `> ...` 文本。
      const offStore = store.subscribe(() => { syncAllReferences(ctx, store) })

      // The「N 条注释」chip: conversation.input.dock is the official composer
      // attachment seat; slots.inject waits for the shell's declaration (the
      // ui-conversation todo/queue docks register the same way)。disposer 由
      // cordis 服务代理级联进本 fiber，随 effect 撤销自动回收。
      ctx.slots.inject('conversation.input.dock', () => {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-sidechat-annotations',
          order: 10,
          registrant: 'dsh-sidechat',
        }, createAnnotationChip(ctx, store))
      })

      return () => {
        offStore()
        clearAllReferences(ctx, store)
        unregisterReferenceSource()
        controller.dispose()
        // 同帧 render/unmount 会触发 React 警告——推迟到下一帧。
        setTimeout(() => { root.unmount() })
        host.remove()
      }
    } catch (error) {
      console.error('[dsh-sidechat] annotate setup failed:', error)
      return () => {}
    }
  }, 'dsh-sidechat: annotations')
}
