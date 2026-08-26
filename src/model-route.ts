/** A concrete DSH model selection. `null` is the explicit inherit route. */
export const MODEL_ROUTE_SNAPSHOT_PATH = '/plugins/dsh-sidechat/model-route'
export const MODEL_ROUTE_EVENTS_PATH = '/plugins/dsh-sidechat/model-route/events'
export const MODEL_BINDINGS_PATH = '/plugins/dsh-sidechat/model-bindings'

export interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Host-authored route state sent to the browser. */
export interface ModelRouteSnapshot {
  revision: number
  route: ModelRoute | null
}

/** One browser page's ephemeral claim that a real child is an open Sidechat. */
export interface ModelBindingRequest {
  clientId: string
  childId: string
  parentSessionId: string
  parentRoute: ModelRoute | null
}

/** Effective route the Host will apply to that child's next model request. */
export interface ModelBindingSnapshot {
  revision: number
  route: ModelRoute | null
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function boundedId(value: unknown): value is string {
  return nonBlank(value) && value.length <= 256
}

/** Validate one route at an untyped boundary without accepting blank fields. */
export function isModelRoute(value: unknown): value is ModelRoute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const route = value as Record<string, unknown>
  return nonBlank(route.provider)
    && nonBlank(route.model)
    && (route.reasoningEffort === undefined || nonBlank(route.reasoningEffort))
}

/** Detached route copy so Settings and network callers cannot mutate hub state. */
export function copyModelRoute(route: ModelRoute | null): ModelRoute | null {
  if (route === null) return null
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

/** Structural equality used for revision de-duplication. */
export function sameModelRoute(left: ModelRoute | null, right: ModelRoute | null): boolean {
  if (left === null || right === null) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/** Parse one authoritative Host snapshot at the JSON/SSE client boundary. */
export function parseModelRouteSnapshot(value: unknown): ModelRouteSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const snapshot = value as Record<string, unknown>
  if (!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0) return undefined
  if (snapshot.route !== null && !isModelRoute(snapshot.route)) return undefined
  return {
    revision: snapshot.revision as number,
    route: copyModelRoute(snapshot.route as ModelRoute | null),
  }
}

/** Parse the small, lossless-JSON binding request accepted by the Host. */
export function parseModelBindingRequest(value: unknown): ModelBindingRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const request = value as Record<string, unknown>
  if (!boundedId(request.clientId)
    || !boundedId(request.childId)
    || !boundedId(request.parentSessionId)
    || (request.parentRoute !== null && !isModelRoute(request.parentRoute))) return undefined
  return {
    clientId: request.clientId,
    childId: request.childId,
    parentSessionId: request.parentSessionId,
    parentRoute: copyModelRoute(request.parentRoute as ModelRoute | null),
  }
}

/** Parse the Host reply used to release the Sidechat composer gate. */
export function parseModelBindingSnapshot(value: unknown): ModelBindingSnapshot | undefined {
  return parseModelRouteSnapshot(value)
}
