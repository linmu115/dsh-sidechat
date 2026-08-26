import type { Context } from '@deepseek-ai/cordis'

import {
  ModelRouteHub,
  SidechatSettingsSchema,
  installSidechatModelSettings,
  type SidechatSettings,
} from './host/model-settings.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-sidechat'

export interface Config extends SidechatSettings {}
export const Config = SidechatSettingsSchema

export function apply(ctx: Context, config: Config): void {
  const entry: SidechatSettings = {
    defaultModelRoute: config.defaultModelRoute ?? null,
  }
  const hub = new ModelRouteHub(entry.defaultModelRoute)
  installSidechatModelSettings(ctx, entry, hub)
  ctx.effect(() => () => { hub.dispose() }, 'dsh-sidechat: model route source')
}

export type { ModelRoute, ModelRouteSnapshot } from './model-route.ts'
