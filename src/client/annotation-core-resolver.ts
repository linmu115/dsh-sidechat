import type {
  AnnotationCoreClient,
  AnnotationCoreFeature,
} from 'dsh-annotation-core/client-api'

import type { Context } from '../context-types.ts'

const SUPPORTED_CORE = /^0\.1\.\d+(?:[-+].*)?$/

/**
 * Resolve the optional shared annotation service through Cordis only.
 *
 * Sidechat deliberately does not import a core runtime value. A missing or
 * incompatible service disables only the feature requesting it; ordinary
 * side-chat tabs and plain prompts remain available.
 */
export function resolveAnnotationCore(
  ctx: Pick<Context, 'get'>,
  requiredFeatures: readonly AnnotationCoreFeature[],
): AnnotationCoreClient | undefined {
  let candidate: unknown
  try {
    candidate = ctx.get('annotationCore')
  } catch {
    return undefined
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const service = candidate as Partial<AnnotationCoreClient>
  if (typeof service.version !== 'string' || !SUPPORTED_CORE.test(service.version)) return undefined
  if (!Array.isArray(service.features)) return undefined
  if (!requiredFeatures.every(feature => service.features?.includes(feature) === true)) return undefined
  return service as AnnotationCoreClient
}

export interface AnnotationCoreAvailability {
  getSnapshot(): AnnotationCoreClient | undefined
  subscribe(listener: () => void): () => void
}

class AnnotationCoreAvailabilityStore implements AnnotationCoreAvailability {
  private current: AnnotationCoreClient | undefined
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): AnnotationCoreClient | undefined => this.current
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(service: AnnotationCoreClient | undefined): void {
    if (service === this.current) return
    this.current = service
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Observe the optional Cordis service without making the ordinary side-chat
 * tab depend on it. The injected context is the authority for the service;
 * panel contexts supplied by another plugin need not expose that scope.
 */
export function observeAnnotationCore(
  ctx: Context,
  requiredFeatures: readonly AnnotationCoreFeature[],
): AnnotationCoreAvailability {
  const store = new AnnotationCoreAvailabilityStore()
  ctx.inject(['annotationCore'], (injected) => {
    const ready = injected as Context
    const service = resolveAnnotationCore(ready, requiredFeatures)
    if (service === undefined) return
    ready.effect(() => {
      store.set(service)
      return () => { if (store.getSnapshot() === service) store.set(undefined) }
    }, 'dsh-sidechat: annotation core availability')
  })
  return store
}

export type { AnnotationCoreClient, AnnotationCoreFeature }
