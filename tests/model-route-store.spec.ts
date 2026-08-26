import { describe, expect, it, vi } from 'vitest'

import {
  createModelRouteStore,
  type EventSourceLike,
  type ModelRouteStoreDependencies,
} from '../src/client/sidechat/model-route-store.ts'

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>)
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>)
  }

  close(): void { this.closed = true }
}

function dependencies(value: unknown = { revision: 0, route: null }): ModelRouteStoreDependencies {
  return {
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => value,
    })),
    EventSource: FakeEventSource,
    warn: vi.fn(),
  }
}

describe('model route store', () => {
  it('bootstraps once and owns one reconnecting EventSource', async () => {
    FakeEventSource.instances = []
    const deps = dependencies({
      revision: 2,
      route: { provider: 'p', model: 'bootstrap' },
    })
    const store = createModelRouteStore(deps)

    expect(store.getSnapshot()).toEqual({ revision: -1, route: null })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe('/plugins/dsh-sidechat/model-route/events')
    await vi.waitFor(() => {
      expect(store.getSnapshot()).toEqual({
        revision: 2,
        route: { provider: 'p', model: 'bootstrap' },
      })
    })
    expect(deps.fetch).toHaveBeenCalledTimes(1)
    expect(deps.fetch).toHaveBeenCalledWith('/plugins/dsh-sidechat/model-route', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    store.dispose()
  })

  it('publishes only valid newer snapshots and keeps state on stream errors', async () => {
    FakeEventSource.instances = []
    const store = createModelRouteStore(dependencies())
    const listener = vi.fn()
    store.subscribe(listener)
    const events = FakeEventSource.instances[0]!

    events.emit({ revision: 4, route: { provider: 'p', model: 'b' } })
    const newest = store.getSnapshot()
    events.emit({ revision: 3, route: { provider: 'p', model: 'a' } })
    events.emit({ revision: 4, route: { provider: 'p', model: 'duplicate' } })
    events.emit({ revision: 5, route: { provider: '', model: 'invalid' } })
    events.emitRaw('{')
    events.onerror?.(new Event('error'))

    expect(store.getSnapshot()).toBe(newest)
    expect(store.getSnapshot()).toEqual({
      revision: 4,
      route: { provider: 'p', model: 'b' },
    })
    expect(listener).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('accepts a reconnect full snapshot and closes without later notifications', () => {
    FakeEventSource.instances = []
    const store = createModelRouteStore(dependencies())
    const listener = vi.fn()
    store.subscribe(listener)
    const events = FakeEventSource.instances[0]!

    events.emit({ revision: 8, route: null })
    expect(store.getSnapshot().revision).toBe(8)
    store.dispose()
    expect(events.closed).toBe(true)
    events.emit({ revision: 9, route: { provider: 'p', model: 'late' } })
    expect(store.getSnapshot().revision).toBe(8)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps the inherit fallback when bootstrap and EventSource construction fail', async () => {
    class BrokenEventSource {
      constructor() { throw new Error('stream unavailable') }
    }
    const warn = vi.fn()
    const store = createModelRouteStore({
      fetch: vi.fn(async () => { throw new Error('offline') }),
      EventSource: BrokenEventSource as never,
      warn,
    })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
    expect(store.getSnapshot()).toEqual({ revision: -1, route: null })
    store.dispose()
  })
})
