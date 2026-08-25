import type { AnnotationCoreClient } from 'dsh-annotation-core/client-api'

import type { Context } from '../../context-types.ts'
import { annotationSafetyGuard } from '../annotation-safety-guard.ts'
import { openOrFocusSideChat } from '../sidechat/open.ts'
import type { SelectionSnapshot } from './selection.ts'

interface AddOptions {
  readonly core: AnnotationCoreClient
  readonly snapshot: SelectionSnapshot
  readonly targetSessionId: string
  readonly operationId?: string
  readonly signal?: AbortSignal
}

export async function addSelectionReference(options: AddOptions): Promise<{ setId: string; referenceId: string; created: boolean }> {
  const source = await options.core.createDshMessageSource({
    selectedText: options.snapshot.text,
    sourceSessionId: options.snapshot.sessionId,
    ...(options.snapshot.messageId === undefined ? {} : { messageId: options.snapshot.messageId }),
    anchorId: options.snapshot.anchorId,
    role: options.snapshot.role,
    occurrence: options.snapshot.occurrence,
  })
  const added = await options.core.addReference(options.targetSessionId, source, {
    ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return added
}

export interface SideChatAddGuard {
  runAdd<T>(
    tabId: string,
    sessionId: string,
    task: (operationId: string, signal: AbortSignal) => Promise<T>,
    core: AnnotationCoreClient,
  ): Promise<T>
}

export async function addSelectionToSideChat(input: {
  readonly core: AnnotationCoreClient
  readonly snapshot: SelectionSnapshot
  readonly ctx: Context
  readonly guard?: SideChatAddGuard
  readonly openSideChat?: typeof openOrFocusSideChat
}): Promise<{ setId: string; referenceId: string; created: boolean }> {
  const target = await (input.openSideChat ?? openOrFocusSideChat)(input.ctx, input.snapshot.sessionId)
  const guard = input.guard ?? annotationSafetyGuard
  return guard.runAdd(target.tabId, target.sessionId, (operationId, signal) => addSelectionReference({
    core: input.core,
    snapshot: input.snapshot,
    targetSessionId: target.sessionId,
    operationId,
    signal,
  }), input.core)
}
