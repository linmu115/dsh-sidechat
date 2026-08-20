/**
 * Codex-style composer references: one rounded preview card per active
 * annotation, plus the compact count chip. Hover/focus reveals the complete
 * quote and note; the × removes the annotation immediately.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { IconCloseOutline16, IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, InputZone } from '../../context-types.ts'
import { isSendEdge } from './format.ts'
import type { Annotation, AnnotationStore } from './model.ts'
import { t, useLocaleTick } from '../locales.ts'
import { AnnotateErrorBoundary } from './overlay.tsx'
import css from './annotate.module.css'

/** Props the dock skeleton hands us: the InputZone owner share (point-in-time). */
interface ChipProps {
  readonly session: InputZone['session']
  readonly input: InputZone['input']
}

function AnnotationReferenceCard(props: {
  annotation: Annotation
  onRemove: () => void
}): ReactNode {
  const { annotation } = props
  return (
    <div
      className={css.referenceCard}
      tabIndex={0}
      aria-label={t('referenceCardAria', { n: annotation.number, text: annotation.text })}
    >
      <span className={css.referenceNumber}>{annotation.number}</span>
      <span className={css.referencePreview}>{annotation.text}</span>
      <button
        type="button"
        className={css.referenceRemove}
        title={t('removeTitle')}
        aria-label={t('removeAria', { n: annotation.number })}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.onRemove()
        }}
      >
        <IconCloseOutline16 size={12} />
      </button>
      <div className={css.referenceTooltip} role="tooltip">
        <div className={css.referenceTooltipTitle}>{t('referenceNumber', { n: annotation.number })}</div>
        <div className={css.referenceTooltipQuote}>{annotation.text}</div>
        {annotation.note !== '' && (
          <div className={css.referenceTooltipNote}>{t('noteLine', { note: annotation.note })}</div>
        )}
      </div>
    </div>
  )
}

/** Create the slot component bound to one store instance. */
export function createAnnotationChip(_ctx: Context, store: AnnotationStore) {
  function AnnotationChip(props: ChipProps): ReactNode {
    useLocaleTick()
    const sessionId = props.session.sessionId
    useSyncExternalStore(
      useCallback((cb: () => void) => store.subscribe(cb), [store]),
      () => store.getSnapshot(),
    )
    const [expanded, setExpanded] = useState(false)

    // 发送沿检测：草稿非空→空 且伴随机器信号（提交相位/队列增长/running
    // 启动）。原生引用占位符也算草稿内容，因此纯引用消息同样可正确归档。
    const previous = useRef({
      sessionId,
      draft: props.input.draft,
      phase: props.input.phase,
      queueLen: props.input.queue?.length ?? 0,
      running: props.session.running,
    })
    useEffect(() => {
      const prev = previous.current
      previous.current = {
        sessionId,
        draft: props.input.draft,
        phase: props.input.phase,
        queueLen: props.input.queue?.length ?? 0,
        running: props.session.running,
      }
      if (prev.sessionId !== sessionId) return
      if (store.countActive(sessionId) === 0) return
      if (!isSendEdge(prev.draft, props.input.draft)) return
      const machineSignal = prev.phase !== 'plain'
        || (props.input.queue?.length ?? 0) > prev.queueLen
        || (props.session.running && !prev.running)
      if (!machineSignal) return
      store.markSessionSent(sessionId)
    })

    const active = store.listActive(sessionId)
    if (active.length === 0) return null

    return (
      <div className={css.referenceDock} data-dsh-sidechat-reference-dock="">
        <div className={css.referenceRail}>
          {active.map(annotation => (
            <AnnotationReferenceCard
              key={annotation.id}
              annotation={annotation}
              onRemove={() => { store.remove(annotation.id) }}
            />
          ))}
          <button
            type="button"
            className={css.chip}
            aria-expanded={expanded}
            onClick={() => { setExpanded(open => !open) }}
          >
            <IconListPenOutline16 size={12} />
            <span>{t(active.length === 1 ? 'chipOne' : 'chipMany', { n: active.length })}</span>
          </button>
        </div>
        {expanded && (
          <ul className={css.chipPanel}>
            {active.map(annotation => (
              <li key={annotation.id} className={css.chipRow}>
                <span className={css.chipNumber}>{annotation.number}</span>
                <span className={css.chipText} title={annotation.text}>
                  {annotation.text}
                  {annotation.note !== '' && <span className={css.chipNote}>（{annotation.note}）</span>}
                </span>
                <button
                  type="button"
                  className={css.chipRemove}
                  title={t('removeTitle')}
                  aria-label={t('removeAria', { n: annotation.number })}
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { store.remove(annotation.id) }}
                >
                  <IconCloseOutline16 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return function AnnotationChipEntry(props: ChipProps): ReactNode {
    return (
      <AnnotateErrorBoundary>
        <AnnotationChip {...props} />
      </AnnotateErrorBoundary>
    )
  }
}
