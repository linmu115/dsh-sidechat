import type { AnnotationCoreClient } from '../annotation-core-contract.ts'

export function handleSideChatAnswerLink(
  core: Pick<AnnotationCoreClient, 'handleAnswerLink'> | undefined,
  sessionId: string,
  href: string,
): boolean {
  return core?.handleAnswerLink(sessionId, href) === true
}
