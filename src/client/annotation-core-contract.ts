import type { ReactNode } from 'react'

/**
 * Structural contract consumed by Sidechat.
 *
 * This is intentionally local: Annotation Core is an optional runtime service,
 * not a build-time package dependency. New Core release lines are accepted as
 * long as they advertise and implement the capabilities used below.
 */
export type AnnotationCoreFeature =
  | 'dsh-message-source-v1'
  | 'embedded-composer-v1'
  | 'embedded-conversation-node-v1'
  | 'answer-link-v1'
  | 'backlink-retry-v1'
  | 'sent-reference-delete-v1'
  | 'session-open-annotation-v1'

export interface PlainComposerSnapshot {
  readonly draft: string
  readonly revision: number
}

export type PlainSubmitResult =
  | { readonly kind: 'success'; readonly submittedRevision: number }
  | { readonly kind: 'error'; readonly submittedRevision: number; readonly message: string }

export interface PlainComposerPort {
  getSnapshot(): PlainComposerSnapshot
  subscribe(listener: () => void): () => void
  setDraft(text: string): void
  submitPlain(input: { text: string; revision: number }): Promise<PlainSubmitResult>
}

export interface EmbeddedComposerSnapshot {
  readonly visibleDraft: string
  readonly pendingCount: number
  readonly canSubmit: boolean
  readonly commitState: 'idle' | 'committing' | 'failed'
  readonly error?: string
  readonly transport: 'native-command-claim' | 'core-host' | 'plain-fallback' | 'blocked'
  readonly fallbackPolicy: 'plain-allowed' | 'native-required' | 'unknown'
}

export interface EmbeddedComposerHandle {
  getSnapshot(): EmbeddedComposerSnapshot
  subscribe(listener: () => void): () => void
  setVisibleDraft(text: string): void
  submit(): Promise<void>
  renderReferenceRail(): ReactNode
  dispose(): void
}

export interface AnnotationCoreClient {
  readonly version: string
  readonly features: readonly AnnotationCoreFeature[]
  readPendingState(sessionId: string): Promise<{ revision: number; pendingCount: number }>
  createDshMessageSource(input: {
    readonly selectedText: string
    readonly sourceSessionId: string
    readonly messageId?: string
    readonly anchorId: string
    readonly role: 'user' | 'assistant'
    readonly occurrence: number
  }): Promise<unknown>
  addReference(
    sessionId: string,
    source: unknown,
    options?: { operationId?: string; referenceId?: string; signal?: AbortSignal },
  ): Promise<{ setId: string; referenceId: string; created: boolean }>
  fenceReferenceOperation(
    sessionId: string,
    operationId: string,
  ): Promise<{ state: 'canceled' | 'committed' | 'failed'; fenceRevision: number }>
  discardPendingOperation(sessionId: string, operationId: string): Promise<void>
  bindComposer(input: {
    sessionId: string
    layout: 'default' | 'narrow'
    plainPort?: PlainComposerPort
  }): EmbeddedComposerHandle
  renderConversationNode(input: {
    sessionId: string
    node: unknown
    layout: 'default' | 'narrow'
  }): { key: string; node: ReactNode } | undefined
  handleAnswerLink(sessionId: string, href: string): boolean
}
