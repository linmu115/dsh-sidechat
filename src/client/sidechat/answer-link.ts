import type { AnnotationCoreClient } from 'dsh-annotation-core/client-api'

export function handleSideChatAnswerLink(
  core: Pick<AnnotationCoreClient, 'handleAnswerLink'> | undefined,
  sessionId: string,
  href: string,
): boolean {
  return core?.handleAnswerLink(sessionId, href) === true
}
