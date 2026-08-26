import type {
  ConnectionSessionsApi,
  ModelSelection,
} from '../../context-types.ts'
import type { ModelRoute, ModelRouteSnapshot } from '../../model-route.ts'
import type { ModelRouteStore } from './model-route-store.ts'

export type ChildModelPhase = 'pending' | 'switching' | 'ready'

export interface ChildModelState {
  phase: ChildModelPhase
  modelName: string | null
  appliedRevision: number
}

interface ChildEntry {
  childId: string
  parentSessionId: string
  state: ChildModelState
  listeners: Set<() => void>
  references: number
  active: boolean
  running: boolean
}

const MISSING_STATE: ChildModelState = Object.freeze({
  phase: 'pending',
  modelName: null,
  appliedRevision: Number.MIN_SAFE_INTEGER,
})

type Warn = (message: string, error?: unknown) => void

function routePayload(sessionId: string, route: ModelRoute): Parameters<ConnectionSessionsApi['selectModel']>[0] {
  return {
    sessionId,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

function envelopeError(value: { result: { ok: boolean; error?: { message?: string } } }, fallback: string): Error {
  return new Error(value.result.error?.message ?? fallback)
}

/**
 * Applies the page-wide route to mounted real child sessions.
 *
 * Work is serialized per child. Each drain re-reads the route store after an
 * awaited selection, so a later revision is always applied after an older
 * in-flight call and therefore wins.
 */
export class SidechatModelCoordinator {
  private readonly entries = new Map<string, ChildEntry>()
  private readonly serialTails = new Map<string, Promise<void>>()
  private readonly unsubscribeRoute: () => void
  private disposed = false

  constructor(
    private readonly routes: ModelRouteStore,
    private readonly api: ConnectionSessionsApi,
    private readonly warn: Warn = (message, error) => {
      console.warn(`[dsh-sidechat] ${message}`, error)
    },
  ) {
    this.unsubscribeRoute = routes.subscribe(() => {
      for (const entry of this.entries.values()) this.schedule(entry)
    })
  }

  register(childId: string, parentSessionId: string): () => void {
    if (this.disposed) return () => {}
    let entry = this.entries.get(childId)
    if (entry === undefined) {
      entry = {
        childId,
        parentSessionId,
        state: MISSING_STATE,
        listeners: new Set(),
        references: 0,
        active: true,
        running: false,
      }
      this.entries.set(childId, entry)
    } else {
      entry.parentSessionId = parentSessionId
      entry.active = true
    }
    entry.references += 1
    this.schedule(entry)

    let released = false
    return () => {
      if (released) return
      released = true
      entry!.references -= 1
      if (entry!.references > 0) return
      entry!.active = false
      entry!.listeners.clear()
      if (this.entries.get(childId) === entry) this.entries.delete(childId)
    }
  }

  getSnapshot(childId: string): ChildModelState {
    return this.entries.get(childId)?.state ?? MISSING_STATE
  }

  subscribe(childId: string, listener: () => void): () => void {
    const entry = this.entries.get(childId)
    if (entry === undefined || !entry.active || this.disposed) return () => {}
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener) }
  }

  async whenIdle(childId: string): Promise<void> {
    while (true) {
      const tail = this.serialTails.get(childId)
      if (tail === undefined) return
      await tail
      if (this.serialTails.get(childId) === tail) return
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRoute()
    for (const entry of this.entries.values()) {
      entry.active = false
      entry.listeners.clear()
    }
    this.entries.clear()
  }

  private schedule(entry: ChildEntry): void {
    if (this.disposed || !entry.active || entry.running) return
    if (this.routes.getSnapshot().revision <= entry.state.appliedRevision) return
    entry.running = true
    const previous = this.serialTails.get(entry.childId) ?? Promise.resolve()
    const task = previous
      .catch(() => {})
      .then(async () => { if (entry.active && !this.disposed) await this.drain(entry) })
      .catch((error: unknown) => {
        this.warn(`unexpected model coordinator failure for ${entry.childId}`, error)
      })
    this.serialTails.set(entry.childId, task)
    void task.then(() => {
      entry.running = false
      if (entry.active
        && !this.disposed
        && this.routes.getSnapshot().revision > entry.state.appliedRevision) {
        this.schedule(entry)
      } else if (this.serialTails.get(entry.childId) === task) {
        this.serialTails.delete(entry.childId)
      }
    })
  }

  private async drain(entry: ChildEntry): Promise<void> {
    while (entry.active && !this.disposed) {
      const target = this.routes.getSnapshot()
      if (target.revision <= entry.state.appliedRevision) return
      this.publish(entry, {
        ...entry.state,
        phase: 'switching',
      })

      const modelName = await this.applyTarget(entry, target)
      if (!entry.active || this.disposed) return
      const newerWaiting = this.routes.getSnapshot().revision > target.revision
      this.publish(entry, {
        phase: newerWaiting ? 'switching' : 'ready',
        modelName,
        appliedRevision: target.revision,
      })
      if (!newerWaiting) return
    }
  }

  private publish(entry: ChildEntry, state: ChildModelState): void {
    if (entry.state.phase === state.phase
      && entry.state.modelName === state.modelName
      && entry.state.appliedRevision === state.appliedRevision) return
    entry.state = Object.freeze(state)
    for (const listener of [...entry.listeners]) listener()
  }

  private async applyTarget(entry: ChildEntry, target: ModelRouteSnapshot): Promise<string | null> {
    if (target.route !== null) {
      try {
        return (await this.select(entry.childId, target.route)).model
      } catch (error) {
        this.warn(`configured model was rejected for ${entry.childId}; following its parent`, error)
      }
    }

    try {
      const parent = await this.current(entry.parentSessionId)
      return (await this.select(entry.childId, parent)).model
    } catch (error) {
      this.warn(`failed to synchronize ${entry.childId} with parent ${entry.parentSessionId}`, error)
    }

    try {
      return (await this.current(entry.childId)).model
    } catch (error) {
      this.warn(`failed to read the retained model for ${entry.childId}`, error)
      return entry.state.modelName
    }
  }

  private async current(sessionId: string): Promise<ModelSelection> {
    const response = await this.api.models({ sessionId })
    if (!response.result.ok) throw envelopeError(response, `unable to read model for ${sessionId}`)
    return response.result.value.current
  }

  private async select(sessionId: string, route: ModelRoute): Promise<ModelSelection> {
    const response = await this.api.selectModel(routePayload(sessionId, route))
    if (!response.result.ok) throw envelopeError(response, `unable to select model for ${sessionId}`)
    return response.result.value.selected
  }
}
