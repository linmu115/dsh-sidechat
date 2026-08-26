import { describe, expect, it, vi } from 'vitest'

import type { ConnectionSessionsApi, ModelSelection } from '../src/context-types.ts'
import type { ModelRouteSnapshot } from '../src/model-route.ts'
import {
  SidechatModelCoordinator,
  type ChildModelState,
} from '../src/client/sidechat/model-coordinator.ts'
import type { ModelBindingClient } from '../src/client/sidechat/model-binding-client.ts'
import type { ModelRouteStore } from '../src/client/sidechat/model-route-store.ts'

class TestRouteStore implements ModelRouteStore {
  private listeners = new Set<() => void>()
  constructor(private snapshot: ModelRouteSnapshot) {}
  getSnapshot(): ModelRouteSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(snapshot: ModelRouteSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) listener()
  }
  dispose(): void { this.listeners.clear() }
}

function okModels(current: ModelSelection) {
  return { result: { ok: true as const, value: { current, routable: true, groups: [] } } }
}

function failed(message: string) {
  return { result: { ok: false as const, error: { message } } }
}

function apiWithParents(parents: Record<string, ModelSelection>) {
  const api = {
    models: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const current = parents[sessionId]
      return current === undefined ? failed('missing') : okModels(current)
    }),
  }
  return { api: api as unknown as ConnectionSessionsApi, mocks: api }
}

function bindingFor(store: TestRouteStore) {
  const binding = {
    bind: vi.fn(async (input: { parentRoute: ModelSelection | null }) => {
      const snapshot = store.getSnapshot()
      return { revision: snapshot.revision, route: snapshot.route ?? input.parentRoute }
    }),
    unbind: vi.fn(),
    dispose: vi.fn(),
  }
  return binding as unknown as ModelBindingClient & typeof binding
}

describe('SidechatModelCoordinator', () => {
  it('applies one fixed route with reasoning effort and publishes the actual label', async () => {
    const store = new TestRouteStore({
      revision: 3,
      route: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
    })
    const { api } = apiWithParents({})
    const binding = bindingFor(store)
    const coordinator = new SidechatModelCoordinator(store, api, undefined, binding)
    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')

    expect(binding.bind).toHaveBeenCalledWith({
      childId: 'child',
      parentSessionId: 'parent',
      parentRoute: null,
    })
    expect(coordinator.getSnapshot('child')).toEqual<ChildModelState>({
      phase: 'ready',
      modelName: 'reasoner',
      appliedRevision: 3,
    })
    coordinator.dispose()
  })

  it('follows each registered parent and hot-switches every open child', async () => {
    const store = new TestRouteStore({ revision: 0, route: null })
    const { api } = apiWithParents({
      'parent-a': { provider: 'p', model: 'main-a', reasoningEffort: 'medium' },
      'parent-b': { provider: 'q', model: 'main-b' },
    })
    const binding = bindingFor(store)
    const coordinator = new SidechatModelCoordinator(store, api, undefined, binding)
    coordinator.register('child-a', 'parent-a')
    coordinator.register('child-b', 'parent-b')
    await Promise.all([coordinator.whenIdle('child-a'), coordinator.whenIdle('child-b')])

    expect(coordinator.getSnapshot('child-a').modelName).toBe('main-a')
    expect(coordinator.getSnapshot('child-b').modelName).toBe('main-b')

    store.publish({ revision: 1, route: { provider: 'fixed', model: 'hot' } })
    await Promise.all([coordinator.whenIdle('child-a'), coordinator.whenIdle('child-b')])
    expect(coordinator.getSnapshot('child-a')).toMatchObject({ modelName: 'hot', appliedRevision: 1 })
    expect(coordinator.getSnapshot('child-b')).toMatchObject({ modelName: 'hot', appliedRevision: 1 })
    expect(binding.bind).toHaveBeenCalledTimes(4)
    coordinator.dispose()
  })

  it('serializes rapid A/B saves so the latest revision wins', async () => {
    let releaseA!: () => void
    const waitA = new Promise<void>(resolve => { releaseA = resolve })
    const store = new TestRouteStore({ revision: 1, route: { provider: 'p', model: 'a' } })
    const calls: string[] = []
    const api = {
      models: vi.fn(async () => failed('unused')),
      selectModel: vi.fn(async () => failed('must not be called')),
    }
    const binding = {
      bind: vi.fn(async () => {
        const snapshot = store.getSnapshot()
        const route = snapshot.route!
        calls.push(route.model)
        if (route.model === 'a') await waitA
        return { revision: snapshot.revision, route }
      }),
      unbind: vi.fn(),
      dispose: vi.fn(),
    }
    const coordinator = new SidechatModelCoordinator(
      store,
      api as unknown as ConnectionSessionsApi,
      undefined,
      binding,
    )
    coordinator.register('child', 'parent')
    await vi.waitFor(() => { expect(calls).toEqual(['a']) })

    store.publish({ revision: 2, route: { provider: 'p', model: 'b' } })
    releaseA()
    await coordinator.whenIdle('child')

    expect(calls).toEqual(['a', 'b'])
    expect(coordinator.getSnapshot('child')).toMatchObject({
      phase: 'ready', modelName: 'b', appliedRevision: 2,
    })
    coordinator.dispose()
  })

  it('falls back from a rejected fixed route to the parent route', async () => {
    const store = new TestRouteStore({ revision: 5, route: { provider: 'gone', model: 'removed' } })
    const parent = { provider: 'p', model: 'safe', reasoningEffort: 'low' }
    const api = {
      models: vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === 'parent'
        ? okModels(parent)
        : okModels(parent)),
      selectModel: vi.fn(async () => failed('must not be called')),
    }
    const binding = {
      bind: vi.fn(async (input: { parentRoute: ModelSelection | null }) => ({
        revision: store.getSnapshot().revision,
        route: input.parentRoute,
      })),
      unbind: vi.fn(),
      dispose: vi.fn(),
    }
    const warn = vi.fn()
    const coordinator = new SidechatModelCoordinator(
      store,
      api as unknown as ConnectionSessionsApi,
      warn,
      binding,
    )
    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')

    expect(api.selectModel).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot('child')).toEqual({
      phase: 'ready', modelName: 'safe', appliedRevision: 5,
    })
    expect(warn).not.toHaveBeenCalled()
    coordinator.dispose()
  })

  it('deduplicates a revision, unregisters closed tabs, and aligns on remount', async () => {
    const store = new TestRouteStore({ revision: 1, route: { provider: 'p', model: 'one' } })
    const { api } = apiWithParents({})
    const binding = bindingFor(store)
    const coordinator = new SidechatModelCoordinator(store, api, undefined, binding)
    const unregister = coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')

    store.publish({ revision: 1, route: { provider: 'p', model: 'one' } })
    await coordinator.whenIdle('child')
    expect(binding.bind).toHaveBeenCalledTimes(1)

    unregister()
    store.publish({ revision: 2, route: { provider: 'p', model: 'two' } })
    await coordinator.whenIdle('child')
    expect(binding.bind).toHaveBeenCalledTimes(1)
    expect(binding.unbind).toHaveBeenCalledWith('child')

    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')
    expect(binding.bind).toHaveBeenCalledTimes(2)
    expect(coordinator.getSnapshot('child')).toMatchObject({ modelName: 'two', appliedRevision: 2 })
    coordinator.dispose()
  })

  it('releases the send gate and keeps the child current model when all changes fail', async () => {
    const store = new TestRouteStore({ revision: 7, route: { provider: 'gone', model: 'bad' } })
    const api = {
      models: vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === 'child'
        ? okModels({ provider: 'fork', model: 'existing' })
        : failed('parent unavailable')),
      selectModel: vi.fn(async () => failed('selection unavailable')),
    }
    const binding = {
      bind: vi.fn(async () => ({ revision: 7, route: null })),
      unbind: vi.fn(),
      dispose: vi.fn(),
    }
    const coordinator = new SidechatModelCoordinator(
      store,
      api as unknown as ConnectionSessionsApi,
      vi.fn(),
      binding,
    )
    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')
    expect(coordinator.getSnapshot('child')).toEqual({
      phase: 'ready', modelName: 'existing', appliedRevision: 7,
    })
    coordinator.dispose()
  })
})
