import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'

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
  hooks: SettingsSectionHooks<SidechatSettings>,
) => void

/** RC1-native optional Settings wiring with provider-owned attach/detach. */
const installNativeSettingsSection: SettingsSectionInstaller = (ctx, ns, schema, entry, hooks) => {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks)
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
