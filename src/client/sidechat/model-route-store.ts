import {
  MODEL_ROUTE_EVENTS_PATH,
  MODEL_ROUTE_SNAPSHOT_PATH,
  parseModelRouteSnapshot,
  type ModelRouteSnapshot,
} from '../../model-route.ts'

export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  close(): void
}

export interface EventSourceConstructor {
  new(url: string): EventSourceLike
}

interface FetchResponseLike {
  ok: boolean
  json(): Promise<unknown>
}

export interface ModelRouteStoreDependencies {
  fetch(input: string, init: { cache: 'no-store'; credentials: 'same-origin' }): Promise<FetchResponseLike>
  EventSource: EventSourceConstructor
  warn(message: string, error?: unknown): void
}

export interface ModelRouteStore {
  getSnapshot(): ModelRouteSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}

function browserDependencies(): ModelRouteStoreDependencies {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    EventSource: globalThis.EventSource as unknown as EventSourceConstructor,
    warn: (message, error) => { console.warn(`[dsh-sidechat] ${message}`, error) },
  }
}

/** One page-wide, reconnect-safe model-route source. */
export function createModelRouteStore(
  dependencies: ModelRouteStoreDependencies = browserDependencies(),
): ModelRouteStore {
  let snapshot: ModelRouteSnapshot = Object.freeze({ revision: -1, route: null })
  const listeners = new Set<() => void>()
  let disposed = false

  const accept = (value: unknown): void => {
    if (disposed) return
    const next = parseModelRouteSnapshot(value)
    if (next === undefined || next.revision <= snapshot.revision) return
    snapshot = Object.freeze(next)
    for (const listener of [...listeners]) listener()
  }

  void dependencies.fetch(MODEL_ROUTE_SNAPSHOT_PATH, {
    cache: 'no-store',
    credentials: 'same-origin',
  }).then(async (response) => {
    if (!response.ok) throw new Error(`snapshot request failed with status ${String((response as { status?: unknown }).status ?? 'unknown')}`)
    accept(await response.json())
  }).catch((error: unknown) => {
    if (!disposed) dependencies.warn('model route snapshot is unavailable; following the parent session', error)
  })

  let events: EventSourceLike | undefined
  try {
    events = new dependencies.EventSource(MODEL_ROUTE_EVENTS_PATH)
    events.onmessage = (event) => {
      if (disposed) return
      try {
        accept(JSON.parse(event.data))
      } catch (error) {
        dependencies.warn('ignored an invalid model route event', error)
      }
    }
    events.onerror = () => {
      // EventSource owns reconnect/backoff. Preserve the last selected route.
    }
  } catch (error) {
    dependencies.warn('model route stream is unavailable; using snapshot/fallback', error)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      if (events !== undefined) {
        events.onmessage = null
        events.onerror = null
        events.close()
      }
    },
  }
}
