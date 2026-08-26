import { describe, expect, it, vi } from 'vitest'

import {
  isModelRoute,
  parseModelRouteSnapshot,
  sameModelRoute,
  type ModelRoute,
} from '../src/model-route.ts'
import {
  ModelRouteHub,
  installSidechatModelSettings,
  validateSidechatSettings,
  type SidechatSettings,
  type SettingsSectionInstaller,
} from '../src/host/model-settings.ts'

describe('model route contract', () => {
  it('accepts complete routes and rejects empty or extra snapshot shapes', () => {
    expect(isModelRoute({ provider: 'deepseek', model: 'deepseek-chat' })).toBe(true)
    expect(isModelRoute({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })).toBe(true)
    expect(isModelRoute({ provider: '', model: 'deepseek-chat' })).toBe(false)
    expect(isModelRoute({ provider: 'deepseek', model: '   ' })).toBe(false)
    expect(isModelRoute({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' })).toBe(false)
    expect(parseModelRouteSnapshot({ revision: 2, route: null })).toEqual({ revision: 2, route: null })
    expect(parseModelRouteSnapshot({ revision: -1, route: null })).toBeUndefined()
    expect(parseModelRouteSnapshot({ revision: 1.5, route: null })).toBeUndefined()
    expect(parseModelRouteSnapshot({ revision: 1, route: { provider: 'p', model: '' } })).toBeUndefined()
  })

  it('compares provider, model, and optional reasoning effort', () => {
    const route: ModelRoute = { provider: 'p', model: 'm' }
    expect(sameModelRoute(route, { provider: 'p', model: 'm' })).toBe(true)
    expect(sameModelRoute(route, { provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe(false)
    expect(sameModelRoute(null, null)).toBe(true)
  })
})

describe('model route hub', () => {
  it('publishes a new immutable revision only when the route changes', () => {
    const hub = new ModelRouteHub(null)
    const listener = vi.fn()
    hub.subscribe(listener)

    expect(hub.getSnapshot()).toEqual({ revision: 0, route: null })
    hub.setRoute({ provider: 'deepseek', model: 'deepseek-chat' })
    const first = hub.getSnapshot()
    hub.setRoute({ provider: 'deepseek', model: 'deepseek-chat' })

    expect(hub.getSnapshot()).toBe(first)
    expect(hub.getSnapshot()).toEqual({
      revision: 1,
      route: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after disposal', () => {
    const hub = new ModelRouteHub(null)
    const listener = vi.fn()
    hub.subscribe(listener)
    hub.dispose()
    hub.setRoute({ provider: 'p', model: 'm' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('optional DSH Settings wiring', () => {
  it('uses the Cordis base, follows attach/watch, and returns to base on detach', () => {
    const base: SidechatSettings = {
      defaultModelRoute: { provider: 'base', model: 'main' },
    }
    const hub = new ModelRouteHub(base.defaultModelRoute)
    let hooks!: Parameters<SettingsSectionInstaller>[4]
    const installer: SettingsSectionInstaller = (_ctx, _ns, _schema, _entry, nextHooks) => {
      hooks = nextHooks
    }

    installSidechatModelSettings({} as never, base, hub, installer)
    expect(hub.getSnapshot().route).toEqual(base.defaultModelRoute)

    let live: SidechatSettings = {
      defaultModelRoute: { provider: 'live', model: 'configured', reasoningEffort: 'high' },
    }
    hooks.setSource(() => live)
    hooks.onChange()
    expect(hub.getSnapshot()).toEqual({ revision: 1, route: live.defaultModelRoute })

    live = { defaultModelRoute: null }
    hooks.onChange()
    expect(hub.getSnapshot()).toEqual({ revision: 2, route: null })

    hooks.setSource(() => base)
    hooks.onChange()
    expect(hub.getSnapshot()).toEqual({ revision: 3, route: base.defaultModelRoute })
  })

  it('rejects blank model route fields', () => {
    expect(() => validateSidechatSettings({
      defaultModelRoute: { provider: ' ', model: 'm' },
    })).toThrow(/provider/)
    expect(() => validateSidechatSettings({
      defaultModelRoute: { provider: 'p', model: ' ' },
    })).toThrow(/model/)
  })
})
