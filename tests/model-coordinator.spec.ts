import { describe, expect, it, vi } from 'vitest'

import type { ConnectionSessionsApi, ModelSelection } from '../src/context-types.ts'
import type { ModelRouteSnapshot } from '../src/model-route.ts'
import {
  SidechatModelCoordinator,
  type ChildModelState,
} from '../src/client/sidechat/model-coordinator.ts'
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

function okSelected(selected: ModelSelection) {
  return { result: { ok: true as const, value: { selected } } }
}

function failed(message: string) {
  return { result: { ok: false as const, error: { message } } }
}

function apiWithParents(parents: Record<string, ModelSelection>) {
  const selected = new Map<string, ModelSelection>()
  const api = {
    models: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const current = parents[sessionId] ?? selected.get(sessionId)
      return current === undefined ? failed('missing') : okModels(current)
    }),
    selectModel: vi.fn(async (input: { sessionId: string } & ModelSelection) => {
      const route = { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort }
      selected.set(input.sessionId, route)
      return okSelected(route)
    }),
  }
  return { api: api as unknown as ConnectionSessionsApi, mocks: api, selected }
}

describe('SidechatModelCoordinator', () => {
  it('applies one fixed route with reasoning effort and publishes the actual label', async () => {
    const store = new TestRouteStore({
      revision: 3,
      route: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
    })
    const { api, mocks } = apiWithParents({})
    const coordinator = new SidechatModelCoordinator(store, api)
    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')

    expect(mocks.selectModel).toHaveBeenCalledWith({
      sessionId: 'child',
      provider: 'deepseek',
      model: 'reasoner',
      reasoningEffort: 'high',
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
    const { api, mocks } = apiWithParents({
      'parent-a': { provider: 'p', model: 'main-a', reasoningEffort: 'medium' },
      'parent-b': { provider: 'q', model: 'main-b' },
    })
    const coordinator = new SidechatModelCoordinator(store, api)
    coordinator.register('child-a', 'parent-a')
    coordinator.register('child-b', 'parent-b')
    await Promise.all([coordinator.whenIdle('child-a'), coordinator.whenIdle('child-b')])

    expect(coordinator.getSnapshot('child-a').modelName).toBe('main-a')
    expect(coordinator.getSnapshot('child-b').modelName).toBe('main-b')

    store.publish({ revision: 1, route: { provider: 'fixed', model: 'hot' } })
    await Promise.all([coordinator.whenIdle('child-a'), coordinator.whenIdle('child-b')])
    expect(coordinator.getSnapshot('child-a')).toMatchObject({ modelName: 'hot', appliedRevision: 1 })
    expect(coordinator.getSnapshot('child-b')).toMatchObject({ modelName: 'hot', appliedRevision: 1 })
    expect(mocks.selectModel.mock.calls.filter(([value]) => value.model === 'hot')).toHaveLength(2)
    coordinator.dispose()
  })

  it('serializes rapid A/B saves so the latest revision wins', async () => {
    let releaseA!: () => void
    const waitA = new Promise<void>(resolve => { releaseA = resolve })
    const store = new TestRouteStore({ revision: 1, route: { provider: 'p', model: 'a' } })
    const calls: string[] = []
    const api = {
      models: vi.fn(async () => failed('unused')),
      selectModel: vi.fn(async (input: { sessionId: string } & ModelSelection) => {
        calls.push(input.model)
        if (input.model === 'a') await waitA
        return okSelected(input)
      }),
    }
    const coordinator = new SidechatModelCoordinator(store, api as unknown as ConnectionSessionsApi)
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
    let selects = 0
    const api = {
      models: vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === 'parent'
        ? okModels(parent)
        : okModels(parent)),
      selectModel: vi.fn(async (input: { sessionId: string } & ModelSelection) => {
        selects += 1
        return selects === 1 ? failed('route removed') : okSelected(input)
      }),
    }
    const warn = vi.fn()
    const coordinator = new SidechatModelCoordinator(store, api as unknown as ConnectionSessionsApi, warn)
    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')

    expect(api.selectModel.mock.calls.map(([value]) => value.model)).toEqual(['removed', 'safe'])
    expect(coordinator.getSnapshot('child')).toEqual({
      phase: 'ready', modelName: 'safe', appliedRevision: 5,
    })
    expect(warn).toHaveBeenCalled()
    coordinator.dispose()
  })

  it('deduplicates a revision, unregisters closed tabs, and aligns on remount', async () => {
    const store = new TestRouteStore({ revision: 1, route: { provider: 'p', model: 'one' } })
    const { api, mocks } = apiWithParents({})
    const coordinator = new SidechatModelCoordinator(store, api)
    const unregister = coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')

    store.publish({ revision: 1, route: { provider: 'p', model: 'one' } })
    await coordinator.whenIdle('child')
    expect(mocks.selectModel).toHaveBeenCalledTimes(1)

    unregister()
    store.publish({ revision: 2, route: { provider: 'p', model: 'two' } })
    await coordinator.whenIdle('child')
    expect(mocks.selectModel).toHaveBeenCalledTimes(1)

    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')
    expect(mocks.selectModel).toHaveBeenCalledTimes(2)
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
    const coordinator = new SidechatModelCoordinator(store, api as unknown as ConnectionSessionsApi, vi.fn())
    coordinator.register('child', 'parent')
    await coordinator.whenIdle('child')
    expect(coordinator.getSnapshot('child')).toEqual({
      phase: 'ready', modelName: 'existing', appliedRevision: 7,
    })
    coordinator.dispose()
  })
})
