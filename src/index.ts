import type { Context } from '@deepseek-ai/cordis'

import {
  ModelRouteHub,
  SidechatSettingsSchema,
  installSidechatModelSettings,
  type SidechatSettings,
} from './host/model-settings.ts'
import {
  MODEL_ROUTE_EVENTS_PATH,
  MODEL_ROUTE_SNAPSHOT_PATH,
  createModelRouteHttpSurface,
} from './host/model-route-http.ts'
import {
  MODEL_BINDINGS_PATH,
  createModelBindingsHttpSurface,
} from './host/model-bindings-http.ts'
import {
  SidechatModelBindings,
  installSidechatModelRequestOverride,
  type ModelRequestEventContext,
  type ModelRouteResolver,
} from './host/model-bindings.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-sidechat'

export interface Config extends SidechatSettings {}
export const Config = SidechatSettingsSchema

interface ModelRouteWebContext extends Context {
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  webRuntime: { trustedHosts: readonly string[] }
  llm: ModelRouteResolver
}

export function apply(ctx: Context, config: Config): void {
  const entry: SidechatSettings = {
    defaultModelRoute: config.defaultModelRoute ?? null,
  }
  const hub = new ModelRouteHub(entry.defaultModelRoute)
  installSidechatModelSettings(ctx, entry, hub)
  ctx.effect(() => () => { hub.dispose() }, 'dsh-sidechat: model route source')

  ctx.inject(['webServer', 'webRuntime', 'llm'], (injectedCtx) => {
    const webCtx = injectedCtx as ModelRouteWebContext
    const surface = createModelRouteHttpSurface(hub, () => webCtx.webRuntime.trustedHosts)
    const bindings = new SidechatModelBindings(hub, webCtx.llm)
    const bindingSurface = createModelBindingsHttpSurface(bindings, () => webCtx.webRuntime.trustedHosts)
    webCtx.effect(() => {
      const disposeOverride = installSidechatModelRequestOverride(
        webCtx as unknown as ModelRequestEventContext,
        bindings,
      )
      const disposeSnapshot = webCtx.webServer.register({
        kind: 'exact',
        path: MODEL_ROUTE_SNAPSHOT_PATH,
        handler: surface.snapshot,
      })
      const disposeEvents = webCtx.webServer.register({
        kind: 'exact',
        path: MODEL_ROUTE_EVENTS_PATH,
        handler: surface.events,
      })
      const disposeBindings = webCtx.webServer.register({
        kind: 'exact',
        path: MODEL_BINDINGS_PATH,
        handler: bindingSurface.handle,
      })
      return () => {
        disposeBindings()
        disposeOverride()
        bindingSurface.dispose()
        surface.dispose()
        disposeEvents()
        disposeSnapshot()
      }
    }, 'dsh-sidechat: model route HTTP surface')
  })
}

export type { ModelRoute, ModelRouteSnapshot } from './model-route.ts'
