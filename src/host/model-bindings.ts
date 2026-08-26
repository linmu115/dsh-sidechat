import type {
  ModelBindingRequest,
  ModelBindingSnapshot,
  ModelRoute,
  ModelRouteSnapshot,
} from '../model-route.ts'
import { copyModelRoute } from '../model-route.ts'
import type { ModelRouteHub } from './model-settings.ts'

export interface LlmCallConfigLike {
  provider: string
  model: string
  reasoningEffort?: string
  [key: string]: unknown
}

export interface ModelRouteResolver {
  resolveCallConfig(config: ModelRoute): Promise<LlmCallConfigLike>
}

interface LiveBinding extends ModelBindingRequest {
  expiresAt: number
}

type Warn = (message: string, error?: unknown) => void

function routeOf(config: LlmCallConfigLike): ModelRoute {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  }
}

function routeKey(route: ModelRoute): string {
  return `${route.provider}\u0000${route.model}\u0000${route.reasoningEffort ?? ''}`
}

/** Replace only model-routing fields while preserving the assembled call controls. */
export function withModelRoute(base: LlmCallConfigLike, route: ModelRoute): LlmCallConfigLike {
  const {
    provider: _provider,
    model: _model,
    reasoningEffort: _reasoningEffort,
    ...rest
  } = base
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

/**
 * Host-owned leases for Sidechats that are actually mounted in a browser page.
 *
 * The request hook uses these leases instead of `session.selectModel`: DSH's
 * public selection RPC also persists the selected route as the global default,
 * which would make an isolated Sidechat choice leak into unrelated sessions.
 */
export class SidechatModelBindings {
  private readonly byChild = new Map<string, Map<string, LiveBinding>>()
  private readonly routeResolutions = new Map<string, Promise<ModelRoute | null>>()
  private readonly warnedRoutes = new Set<string>()
  private disposed = false

  constructor(
    private readonly routes: ModelRouteHub,
    private readonly resolver: ModelRouteResolver,
    private readonly leaseMs = 45_000,
    private readonly now: () => number = Date.now,
    private readonly warn: Warn = (message, error) => {
      console.warn(`[dsh-sidechat] ${message}`, error)
    },
  ) {}

  async bind(request: ModelBindingRequest): Promise<ModelBindingSnapshot> {
    if (this.disposed) throw new Error('sidechat model bindings are disposed')
    this.put(request)
    const snapshot = this.routes.getSnapshot()
    return {
      revision: snapshot.revision,
      route: await this.resolveEffective(snapshot, request.parentRoute),
    }
  }

  unbind(clientId: string, childId?: string): void {
    if (childId === undefined) {
      for (const id of [...this.byChild.keys()]) this.unbind(clientId, id)
      return
    }
    const claims = this.byChild.get(childId)
    if (claims === undefined) return
    claims.delete(clientId)
    if (claims.size === 0) this.byChild.delete(childId)
  }

  expire(now = this.now()): void {
    for (const [childId, claims] of this.byChild) {
      for (const [clientId, binding] of claims) {
        if (binding.expiresAt <= now) claims.delete(clientId)
      }
      if (claims.size === 0) this.byChild.delete(childId)
    }
  }

  has(childId: string): boolean {
    return this.currentBinding(childId) !== undefined
  }

  async routeForRequest(childId: string): Promise<ModelRoute | null> {
    if (this.disposed) return null
    const binding = this.currentBinding(childId)
    if (binding === undefined) return null
    return await this.resolveEffective(this.routes.getSnapshot(), binding.parentRoute)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.byChild.clear()
    this.routeResolutions.clear()
    this.warnedRoutes.clear()
  }

  private put(request: ModelBindingRequest): void {
    let claims = this.byChild.get(request.childId)
    if (claims === undefined) {
      claims = new Map()
      this.byChild.set(request.childId, claims)
    }
    // Reinsert so the most recently renewed page wins only if two restored
    // layouts somehow disagree about one child's parent.
    claims.delete(request.clientId)
    claims.set(request.clientId, {
      clientId: request.clientId,
      childId: request.childId,
      parentSessionId: request.parentSessionId,
      parentRoute: copyModelRoute(request.parentRoute),
      expiresAt: this.now() + this.leaseMs,
    })
  }

  private currentBinding(childId: string): LiveBinding | undefined {
    const claims = this.byChild.get(childId)
    if (claims === undefined) return undefined
    const now = this.now()
    let current: LiveBinding | undefined
    for (const [clientId, binding] of claims) {
      if (binding.expiresAt <= now) claims.delete(clientId)
      else current = binding
    }
    if (claims.size === 0) this.byChild.delete(childId)
    return current
  }

  private async resolveEffective(
    snapshot: ModelRouteSnapshot,
    parentRoute: ModelRoute | null,
  ): Promise<ModelRoute | null> {
    if (snapshot.route !== null) {
      const configured = await this.resolveRoute(snapshot.route, `configured revision ${snapshot.revision}`)
      if (configured !== null) return configured
    }
    if (parentRoute === null) return null
    return await this.resolveRoute(parentRoute, 'parent fallback')
  }

  private resolveRoute(route: ModelRoute, source: string): Promise<ModelRoute | null> {
    const key = routeKey(route)
    let pending = this.routeResolutions.get(key)
    if (pending !== undefined) return pending
    pending = this.resolver.resolveCallConfig(copyModelRoute(route)!)
      .then(routeOf)
      .catch((error: unknown) => {
        // A provider or credential can recover without a Settings revision.
        // Keep successful exact-route resolutions, but let a later lease/request
        // retry a failed one.
        this.routeResolutions.delete(key)
        if (!this.warnedRoutes.has(key)) {
          this.warnedRoutes.add(key)
          this.warn(`${source} model route is unavailable`, error)
        }
        return null
      })
    this.routeResolutions.set(key, pending)
    return pending
  }
}

export interface AgentRequestPayloadLike {
  agent: { id: string }
}

export interface ModelRequestEventContext {
  on(
    name: 'agent/request',
    listener: (
      payload: AgentRequestPayloadLike,
      next: () => Promise<LlmCallConfigLike>,
    ) => Promise<LlmCallConfigLike>,
    options: { prepend: true },
  ): () => boolean
}

/** Install the outermost request-route override; it never cancels a live step. */
export function installSidechatModelRequestOverride(
  ctx: ModelRequestEventContext,
  bindings: SidechatModelBindings,
): () => boolean {
  return ctx.on('agent/request', async ({ agent }, next) => {
    // Snapshot the Sidechat route at this model request boundary. A later
    // Manager save affects the next request, never rewrites this one mid-flight.
    const routePromise = bindings.routeForRequest(agent.id)
    const base = await next()
    const route = await routePromise
    return route === null ? base : withModelRoute(base, route)
  }, { prepend: true })
}
