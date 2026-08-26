import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ModelRouteHub } from './model-settings.ts'
import { isTrustedApiRequest } from './trust-fence.ts'

export const MODEL_ROUTE_SNAPSHOT_PATH = '/plugins/dsh-sidechat/model-route'
export const MODEL_ROUTE_EVENTS_PATH = '/plugins/dsh-sidechat/model-route/events'

interface ModelRouteHttpOptions {
  keepAliveMs?: number
}

export interface ModelRouteHttpSurface {
  snapshot(req: IncomingMessage, res: ServerResponse): void
  events(req: IncomingMessage, res: ServerResponse): void
  dispose(): void
}

function writeEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end()
}

function permitsGet(
  req: IncomingMessage,
  res: ServerResponse,
  trustedHosts: () => readonly string[],
): boolean {
  if (req.method !== 'GET') {
    writeEmpty(res, 405, { allow: 'GET' })
    return false
  }
  if (!isTrustedApiRequest(req, trustedHosts())) {
    writeEmpty(res, 403)
    return false
  }
  return true
}

/** Create the two read-only routes and own every open SSE response. */
export function createModelRouteHttpSurface(
  hub: ModelRouteHub,
  trustedHosts: () => readonly string[],
  options: ModelRouteHttpOptions = {},
): ModelRouteHttpSurface {
  const keepAliveMs = options.keepAliveMs ?? 15_000
  const closeConnections = new Set<() => void>()
  let disposed = false

  return {
    snapshot(req, res) {
      if (!permitsGet(req, res, trustedHosts)) return
      const body = JSON.stringify(hub.getSnapshot())
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body).toString(),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
    },

    events(req, res) {
      if (!permitsGet(req, res, trustedHosts)) return
      if (disposed) {
        writeEmpty(res, 503, { 'retry-after': '1' })
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      })
      res.flushHeaders?.()

      let closed = false
      const send = (): void => {
        if (closed || res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(hub.getSnapshot())}\n\n`)
      }
      const unsubscribe = hub.subscribe(send)
      const keepalive = setInterval(() => {
        if (!closed && !res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
      }, keepAliveMs)
      keepalive.unref?.()

      const close = (): void => {
        if (closed) return
        closed = true
        unsubscribe()
        clearInterval(keepalive)
        closeConnections.delete(close)
        req.off('close', close)
        res.off('close', close)
        if (!res.writableEnded && !res.destroyed) res.end()
      }
      closeConnections.add(close)
      req.once('close', close)
      res.once('close', close)
      send()
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const close of [...closeConnections]) close()
      closeConnections.clear()
    },
  }
}
