import { describe, expect, it, vi } from 'vitest'

import { ModelRouteHub } from '../src/host/model-settings.ts'
import {
  SidechatModelBindings,
  installSidechatModelRequestOverride,
  type LlmCallConfigLike,
  type ModelRequestEventContext,
} from '../src/host/model-bindings.ts'
import type { ModelBindingRequest, ModelRoute } from '../src/model-route.ts'

function request(parentRoute: ModelRoute | null): ModelBindingRequest {
  return {
    clientId: 'page-a',
    childId: 'child-a',
    parentSessionId: 'parent-a',
    parentRoute,
  }
}

function resolver(rejectModel?: string) {
  return {
    resolveCallConfig: vi.fn(async (route: ModelRoute) => {
      if (route.model === rejectModel) throw new Error('unavailable')
      return { ...route }
    }),
  }
}

describe('SidechatModelBindings', () => {
  it('uses the fixed Host route without invoking session model selection', async () => {
    const routes = new ModelRouteHub({ provider: 'fixed', model: 'pro', reasoningEffort: 'high' })
    const llm = resolver()
    const bindings = new SidechatModelBindings(routes, llm)

    await expect(bindings.bind(request({ provider: 'parent', model: 'flash' }))).resolves.toEqual({
      revision: 0,
      route: { provider: 'fixed', model: 'pro', reasoningEffort: 'high' },
    })
    expect(await bindings.routeForRequest('child-a')).toEqual({
      provider: 'fixed', model: 'pro', reasoningEffort: 'high',
    })
    expect(llm.resolveCallConfig).toHaveBeenCalledTimes(1)
  })

  it('follows the registered parent and falls back to it when a fixed route disappears', async () => {
    const routes = new ModelRouteHub(null)
    const llm = resolver('removed')
    const warn = vi.fn()
    const bindings = new SidechatModelBindings(routes, llm, 45_000, Date.now, warn)
    const parent = { provider: 'parent', model: 'flash' }

    expect((await bindings.bind(request(parent))).route).toEqual(parent)
    routes.setRoute({ provider: 'fixed', model: 'removed' })
    expect(await bindings.routeForRequest('child-a')).toEqual(parent)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('releases explicit and expired leases so closed Sidechats stop receiving overrides', async () => {
    let now = 100
    const bindings = new SidechatModelBindings(
      new ModelRouteHub({ provider: 'p', model: 'm' }),
      resolver(),
      50,
      () => now,
    )
    await bindings.bind(request(null))
    expect(bindings.has('child-a')).toBe(true)
    now = 151
    bindings.expire()
    expect(bindings.has('child-a')).toBe(false)

    now = 200
    await bindings.bind(request(null))
    bindings.unbind('page-a', 'child-a')
    expect(bindings.has('child-a')).toBe(false)
  })

  it('overrides only the next request config and preserves non-model controls', async () => {
    const bindings = new SidechatModelBindings(
      new ModelRouteHub({ provider: 'fixed', model: 'pro' }),
      resolver(),
    )
    await bindings.bind(request({ provider: 'parent', model: 'flash' }))

    let listener: ((payload: { agent: { id: string } }, next: () => Promise<LlmCallConfigLike>) => Promise<LlmCallConfigLike>) | undefined
    const context = {
      on: vi.fn((_name, callback, options) => {
        listener = callback
        expect(options).toEqual({ prepend: true })
        return () => true
      }),
    } as unknown as ModelRequestEventContext
    installSidechatModelRequestOverride(context, bindings)

    const selected = await listener!({ agent: { id: 'child-a' } }, async () => ({
      provider: 'base',
      model: 'old',
      reasoningEffort: 'low',
      temperature: 0.2,
      maxTokens: 400,
    }))
    expect(selected).toEqual({
      provider: 'fixed',
      model: 'pro',
      temperature: 0.2,
      maxTokens: 400,
    })
  })
})
