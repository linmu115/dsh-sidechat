/** A concrete DSH model selection. `null` is the explicit inherit route. */
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

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
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
