import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes the Alpha.2 settings service visible on Context.
import type {} from '@deepseek-ai/dsh-settings'

import {
  copyModelRoute,
  sameModelRoute,
  type ModelRoute,
  type ModelRouteSnapshot,
} from '../model-route.ts'

export const SIDECHAT_SETTINGS_NAMESPACE = 'dsh-sidechat' as const

/** Cordis composition base plus the live user override owned by DSH Settings. */
export interface SidechatSettings {
  defaultModelRoute: ModelRoute | null
}

const ModelRouteSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

export const SidechatSettingsSchema: z<SidechatSettings> = z.object({
  defaultModelRoute: z.union([z.const(null), ModelRouteSchema]).default(null),
})

/** Cross-field validation shared by Cordis base and Settings writes. */
export function validateSidechatSettings(value: SidechatSettings): void {
  const route = value.defaultModelRoute
  if (route === null) return
  const raw = route as unknown as Record<string, unknown>
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') {
    throw new Error('defaultModelRoute.provider must not be empty')
  }
  if (typeof raw.model !== 'string' || raw.model.trim() === '') {
    throw new Error('defaultModelRoute.model must not be empty')
  }
  if (raw.reasoningEffort !== undefined
    && (typeof raw.reasoningEffort !== 'string' || raw.reasoningEffort.trim() === '')) {
    throw new Error('defaultModelRoute.reasoningEffort must not be empty')
  }
}

/** Minimal observable route source shared by the Host HTTP routes. */
export class ModelRouteHub {
  private snapshot: ModelRouteSnapshot
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(route: ModelRoute | null) {
    this.snapshot = Object.freeze({ revision: 0, route: copyModelRoute(route) })
  }

  getSnapshot(): ModelRouteSnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setRoute(route: ModelRoute | null): void {
    if (sameModelRoute(this.snapshot.route, route)) return
    this.snapshot = Object.freeze({
      revision: this.snapshot.revision + 1,
      route: copyModelRoute(route),
    })
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

export type SettingsSectionInstaller = (
  ctx: Context,
  ns: typeof SIDECHAT_SETTINGS_NAMESPACE,
  schema: z<SidechatSettings>,
  entry: SidechatSettings,
  hooks: {
    setSource(source: () => SidechatSettings): void
    onChange(): void
    validate?(value: SidechatSettings): void
  },
) => void

const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

function isUnloading(ctx: Context): boolean {
  const state = ctx.fiber.state as number
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/** Alpha.2-native optional Settings wiring using the public service directly. */
const installNativeSettingsSection: SettingsSectionInstaller = (ctx, ns, schema, entry, hooks) => {
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(ns, schema, {
      base: entry,
      ...(hooks.validate === undefined ? {} : { validate: hooks.validate }),
    })
    hooks.setSource(() => scope.get())
    settingsCtx.effect(() => () => {
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

/** Install the canonical optional Settings seam and keep the hub in sync. */
export function installSidechatModelSettings(
  ctx: Context,
  entry: SidechatSettings,
  hub: ModelRouteHub,
  installer: SettingsSectionInstaller = installNativeSettingsSection,
): void {
  validateSidechatSettings(entry)
  let current = (): SidechatSettings => entry
  installer(ctx, SIDECHAT_SETTINGS_NAMESPACE, SidechatSettingsSchema, entry, {
    setSource(source) { current = source },
    onChange() {
      const next = current()
      validateSidechatSettings(next)
      hub.setRoute(next.defaultModelRoute)
    },
    validate: validateSidechatSettings,
  })
}
