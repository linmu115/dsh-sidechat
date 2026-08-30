import type {
  ModelSelection,
  SessionsService,
} from '../../context-types.ts'
import type { ModelRouteSnapshot } from '../../model-route.ts'
import {
  createModelBindingClient,
  type ModelBindingClient,
} from './model-binding-client.ts'
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

/**
 * Applies the page-wide route to mounted real child sessions.
 *
 * Work is serialized per child. Each drain re-reads the route store after an
 * awaited selection, so a later revision is always applied after an older
 * in-flight call and therefore wins.
 */
export class SidechatModelCoordinator {
  private readonly entries = new Map<string, ChildEntry>()
  private readonly waitingListeners = new Map<string, Set<() => void>>()
  private readonly serialTails = new Map<string, Promise<void>>()
  private readonly unsubscribeRoute: () => void
  private disposed = false

  constructor(
    private readonly routes: ModelRouteStore,
    private readonly sessions: SessionsService,
    private readonly warn: Warn = (message, error) => {
      console.warn(`[dsh-sidechat] ${message}`, error)
    },
    private readonly bindings: ModelBindingClient = createModelBindingClient(),
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
        listeners: this.waitingListeners.get(childId) ?? new Set(),
        references: 0,
        active: true,
        running: false,
      }
      this.waitingListeners.delete(childId)
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
      this.bindings.unbind(childId)
      if (this.entries.get(childId) === entry) this.entries.delete(childId)
    }
  }

  getSnapshot(childId: string): ChildModelState {
    return this.entries.get(childId)?.state ?? MISSING_STATE
  }

  subscribe(childId: string, listener: () => void): () => void {
    const entry = this.entries.get(childId)
    if (this.disposed) return () => {}
    if (entry === undefined || !entry.active) {
      let waiting = this.waitingListeners.get(childId)
      if (waiting === undefined) {
        waiting = new Set()
        this.waitingListeners.set(childId, waiting)
      }
      waiting.add(listener)
      return () => {
        waiting!.delete(listener)
        if (waiting!.size === 0 && this.waitingListeners.get(childId) === waiting) {
          this.waitingListeners.delete(childId)
        }
      }
    }
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
    this.waitingListeners.clear()
    this.bindings.dispose()
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

      const applied = await this.applyTarget(entry, target)
      if (!entry.active || this.disposed) return
      const newerWaiting = this.routes.getSnapshot().revision > applied.revision
      this.publish(entry, {
        phase: newerWaiting ? 'switching' : 'ready',
        modelName: applied.modelName,
        appliedRevision: applied.revision,
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

  private async applyTarget(
    entry: ChildEntry,
    target: ModelRouteSnapshot,
  ): Promise<{ modelName: string | null; revision: number }> {
    let parentRoute: ModelSelection | null = null
    try {
      parentRoute = await this.current(entry.parentSessionId)
    } catch (error) {
      this.warn(`failed to read parent model ${entry.parentSessionId} for ${entry.childId}`, error)
    }

    try {
      const applied = await this.bindings.bind({
        childId: entry.childId,
        parentSessionId: entry.parentSessionId,
        parentRoute,
      })
      if (applied.route !== null) {
        return { modelName: applied.route.model, revision: applied.revision }
      }
    } catch (error) {
      this.warn(`failed to bind the isolated model route for ${entry.childId}`, error)
    }

    try {
      return { modelName: (await this.current(entry.childId)).model, revision: target.revision }
    } catch (error) {
      this.warn(`failed to read the retained model for ${entry.childId}`, error)
      return { modelName: entry.state.modelName, revision: target.revision }
    }
  }

  private async current(sessionId: string): Promise<ModelSelection> {
    const session = this.sessions.binding(sessionId)?.session
    if (session === undefined) throw new Error(`unable to resolve session ${sessionId}`)
    const value = session.projections.faceOf('modelSelection').getSnapshot()
    if (typeof value !== 'object' || value === null) {
      throw new Error(`session ${sessionId} has no model selection projection`)
    }
    const projection = value as { readonly next?: unknown; readonly lastUsed?: unknown }
    const selected = projection.next ?? projection.lastUsed
    if (typeof selected !== 'object' || selected === null) {
      throw new Error(`session ${sessionId} has no effective model selection`)
    }
    const route = selected as Partial<ModelSelection>
    if (typeof route.provider !== 'string' || route.provider === ''
      || typeof route.model !== 'string' || route.model === ''
      || (route.reasoningEffort !== undefined && typeof route.reasoningEffort !== 'string')) {
      throw new Error(`session ${sessionId} exposed an invalid model selection`)
    }
    return {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
  }
}
