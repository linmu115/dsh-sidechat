import type { AnnotationCoreClient } from 'dsh-annotation-core/client-api'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IconNewChatOutline16, IconSendOutline16, IconStopFill16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Context, SessionFace, TabComponentProps } from '../../context-types.ts'
import type { AnnotationCoreAvailability } from '../annotation-core-resolver.ts'
import { t, useLocaleTick } from '../locales.ts'
import { useComposer, type Composer } from './composer.ts'
import { handleSideChatAnswerLink } from './answer-link.ts'
import {
  parseSideChatMeta,
  phaseOf,
  transcriptEntriesOf,
  type ChatMessage,
  type TranscriptEntry,
} from './model.ts'
import { ensureSideChatSession } from './session-controller.ts'
import {
  type ChildModelPhase,
  type SidechatModelCoordinator,
} from './model-coordinator.ts'
import { canSubmitWithModel, isComposerSubmitKey } from './model-submit-gate.ts'
import css from './sidechat.module.css'

const NOOP_UNSUBSCRIBE = (): void => {}
function codeLabels() { return { copyLabel: t('codeCopy'), copiedLabel: t('codeCopied') } }

function openSessionWindow(session: SessionFace | undefined): void {
  const openable = session as unknown as { open?: () => Promise<void> } | undefined
  if (typeof openable?.open !== 'function') return
  openable.open().catch(error => { console.warn('[dsh-sidechat] failed to open session window:', error) })
}

export function SideChatPanel(props: TabComponentProps & {
  annotationCore: AnnotationCoreAvailability
  modelCoordinator: SidechatModelCoordinator
}) {
  useLocaleTick()
  const { ctx, scope, tab, visible, store } = props
  const tabMeta = parseSideChatMeta(tab.meta)
  const registeredChildId = tabMeta.childId
  const parentSessionId = tabMeta.parentSessionId ?? scope.sessionId
  const [provisionedChildId, setProvisionedChildId] = useState<string | undefined>(registeredChildId)
  const [forkError, setForkError] = useState<string | null>(null)

  useEffect(() => {
    const mutable = store as { update?: (mutate: (state: { panelOpen?: boolean }) => void) => void } | undefined
    try { mutable?.update?.(state => { if (state.panelOpen === false) state.panelOpen = true }) } catch {}
  }, [store])

  useEffect(() => {
    if (registeredChildId !== undefined) { setProvisionedChildId(registeredChildId); return }
    let active = true
    void ensureSideChatSession(ctx, tab.id, scope.sessionId)
      .then(childId => { if (active) { setProvisionedChildId(childId); setForkError(null) } })
      .catch(error => { if (active) setForkError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [ctx, tab.id, scope.sessionId, registeredChildId])

  const childId = registeredChildId ?? provisionedChildId
  useEffect(() => {
    if (childId === undefined) return
    return props.modelCoordinator.register(childId, parentSessionId)
  }, [props.modelCoordinator, childId, parentSessionId])
  const childModel = useSyncExternalStore(
    useCallback(
      (notify: () => void) => childId === undefined
        ? NOOP_UNSUBSCRIBE
        : props.modelCoordinator.subscribe(childId, notify),
      [props.modelCoordinator, childId],
    ),
    () => props.modelCoordinator.getSnapshot(childId ?? ''),
  )
  const listSnapshot = useSyncExternalStore(
    useCallback((notify: () => void) => ctx.sessions.list.subscribe(notify), [ctx]),
    () => ctx.sessions.list.getSnapshot(),
  )
  const listed = childId !== undefined && listSnapshot.byId?.[childId] !== undefined
  const session = childId === undefined ? undefined : ctx.sessions.binding(childId)?.session
  useEffect(() => { openSessionWindow(session) }, [session])
  const phase = phaseOf({
    childId,
    forkError,
    bound: session !== undefined,
    listPhase: listSnapshot.phase,
    listed,
  })

  const snapshot = useSyncExternalStore(
    useCallback((notify: () => void) => visible && session !== undefined ? session.subscribe(notify) : NOOP_UNSUBSCRIBE, [visible, session]),
    () => session?.getSnapshot() ?? null,
  )
  const annotationCore = useSyncExternalStore(props.annotationCore.subscribe, props.annotationCore.getSnapshot)
  const projectionCore = annotationCore
  const answerCore = annotationCore
  const entries = useMemo(
    () => childId === undefined ? [] : transcriptEntriesOf(snapshot, projectionCore, childId),
    [snapshot, projectionCore, childId],
  )
  const composer = useComposer(session, childId, annotationCore)

  const bodyRef = useRef<HTMLDivElement>(null)
  const tail = entries.at(-1)
  const tailKey = tail === undefined ? '' : `${tail.key}:${tail.kind === 'message' ? tail.message.text.length : 'custom'}`
  useEffect(() => {
    const element = bodyRef.current
    if (element !== null && visible) element.scrollTop = element.scrollHeight
  }, [tailKey, visible])

  if (phase === 'fork-error') return <StateScreen title={t('forkErrorTitle')} detail={forkError ?? undefined} hint={t('forkErrorHint')} />
  if (phase === 'missing') return <StateScreen title={t('missingTitle')} detail={t('missingDetail')} hint={t('missingHint')} />
  if (phase === 'forking' || phase === 'loading') return <StateScreen title={t('preparing')} />

  const running = snapshot?.running === true
  return (
    <div className={css.root}>
      <div ref={bodyRef} className={css.body}>
        {entries.length === 0 && !running
          ? <EmptyState />
          : <MessageList entries={entries} sessionId={childId!} answerCore={answerCore} />}
        {snapshot?.openState === 'error' && <div className={css.errorRow}>{t('historyFailed')}</div>}
      </div>
      <ComposerBar
        session={session}
        composer={composer}
        running={running}
        visible={visible}
        modelName={childModel.modelName}
        modelPhase={childModel.phase}
      />
    </div>
  )
}

function EmptyState() {
  useLocaleTick()
  return <div className={css.empty}><div className={css.emptyIcon}><IconNewChatOutline16 size={32} /></div><div className={css.emptyTitle}>{t('emptyTitle')}</div><div className={css.emptyText}>{t('emptyText')}</div></div>
}

function StateScreen(props: { title: string; detail?: string; hint?: string }) {
  useLocaleTick()
  return (
    <div className={css.stateScreen}>
      <div className={css.emptyIcon}><IconNewChatOutline16 size={32} /></div>
      <div className={css.emptyTitle}>{props.title}</div>
      {props.detail !== undefined && props.detail !== '' && <div className={css.stateDetail}>{props.detail}</div>}
      {props.hint !== undefined && props.hint !== '' && <div className={css.emptyText}>{props.hint}</div>}
    </div>
  )
}

function MessageList(props: {
  readonly entries: readonly TranscriptEntry[]
  readonly sessionId: string
  readonly answerCore: Pick<AnnotationCoreClient, 'handleAnswerLink'> | undefined
}) {
  return (
    <div className={css.transcript}>
      {props.entries.map(entry => entry.kind === 'custom'
        ? <div className={css.annotationRow} key={entry.key}>{entry.node}</div>
        : <MessageRow key={entry.key} message={entry.message} sessionId={props.sessionId} answerCore={props.answerCore} />)}
    </div>
  )
}

function answerClick(core: Pick<AnnotationCoreClient, 'handleAnswerLink'> | undefined, sessionId: string, event: React.MouseEvent): void {
  const element = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (element === null || !handleSideChatAnswerLink(core, sessionId, element.href)) return
  event.preventDefault()
  event.stopPropagation()
}

function MessageRow(props: { message: ChatMessage; sessionId: string; answerCore: Pick<AnnotationCoreClient, 'handleAnswerLink'> | undefined }) {
  useLocaleTick()
  const { message } = props
  switch (message.role) {
    case 'user': return <div className={css.userRow}><div className={css.userBubble}>{message.text}</div></div>
    case 'assistant': return (
      <div className={css.assistantRow} onClickCapture={event => { answerClick(props.answerCore, props.sessionId, event) }}>
        <div className={css.assistantBody}>
          {message.reasoning && <details className={css.reasoning}><summary>{t('thinking')}</summary><div className={css.reasoningBody}>{message.reasoning}</div></details>}
          {message.text !== '' ? <MarkdownText text={message.text} streaming={message.streaming} codeLabels={codeLabels()} /> : message.streaming === true && <div className={css.streamingHint}>{t('writing')}</div>}
          {message.interrupted === true && <div className={css.noticeRow}>{t('stopped')}</div>}
        </div>
      </div>
    )
    case 'tool': return <div className={css.toolCard}><div className={css.toolHead}>{t('toolLabel')} · {message.toolName}{message.isError === true && <span className={css.toolError}>{t('failed')}</span>}{message.streaming === true && <span className={css.toolRunning}>{t('running')}</span>}</div>{message.text !== '' && <div className={css.toolBody}>{message.text}</div>}</div>
    case 'error': return <div className={css.errorRow}>{message.text}</div>
    case 'notice': return <div className={css.noticeRow}>{message.text}</div>
  }
}

function ComposerBar(props: {
  session: SessionFace | undefined
  composer: Composer
  running: boolean
  visible: boolean
  modelName: string | null
  modelPhase: ChildModelPhase
}) {
  useLocaleTick()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const canSubmit = canSubmitWithModel(props.composer.canSubmit, props.modelPhase)
  useEffect(() => { if (props.visible) inputRef.current?.focus() }, [props.visible])
  return (
    <div className={css.composer}>
      {props.composer.referenceRail}
      <textarea
        ref={inputRef}
        className={css.input}
        placeholder={t('inputPlaceholder')}
        value={props.composer.draft}
        onChange={event => { props.composer.setDraft(event.target.value) }}
        onKeyDown={event => {
          if (!isComposerSubmitKey({
            key: event.key,
            shiftKey: event.shiftKey,
            isComposing: event.nativeEvent.isComposing,
            keyCode: event.nativeEvent.keyCode,
          })) return
          event.preventDefault()
          if (props.modelPhase !== 'ready') return
          void props.composer.submit()
        }}
      />
      <div className={css.composerFoot}>
        <span className={css.modelLabel}>{t('modelLabel', {
          name: props.modelPhase === 'ready'
            ? props.modelName ?? t('modelFollowsMain')
            : t('modelSwitching'),
        })}</span>
        {props.running
          ? <button type="button" className={css.stopButton} title={t('stopReplyTitle')} onClick={() => { props.session?.cancel().catch(() => {}) }}><IconStopFill16 size={14} /> {t('stopReply')}</button>
          : <button type="button" className={css.sendButton} disabled={!canSubmit} onClick={() => { void props.composer.submit() }}><IconSendOutline16 size={14} /> {t('send')}</button>}
      </div>
      {props.composer.sendError !== null && <div className={css.errorRow}>{props.composer.sendError}</div>}
    </div>
  )
}
