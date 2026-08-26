import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  MODEL_BINDINGS_PATH,
  parseModelBindingRequest,
  type ModelBindingRequest,
} from '../model-route.ts'
import type { SidechatModelBindings } from './model-bindings.ts'
import { isTrustedApiRequest } from './trust-fence.ts'

export { MODEL_BINDINGS_PATH } from '../model-route.ts'

const MAX_BODY_BYTES = 8 * 1024

interface ModelBindingsHttpOptions {
  pruneIntervalMs?: number
}

export interface ModelBindingsHttpSurface {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  dispose(): void
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  }
}

function empty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, headers(extra))
  res.end()
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, headers({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
  }))
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new RangeError('request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SyntaxError('request body must be valid JSON')
  }
}

function parseRelease(value: unknown): { clientId: string; childId?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.clientId !== 'string' || record.clientId.trim() === '' || record.clientId.length > 256) return undefined
  if (record.childId !== undefined
    && (typeof record.childId !== 'string' || record.childId.trim() === '' || record.childId.length > 256)) return undefined
  return {
    clientId: record.clientId,
    ...(record.childId === undefined ? {} : { childId: record.childId as string }),
  }
}

/** Trusted ephemeral registration route for currently mounted Sidechat children. */
export function createModelBindingsHttpSurface(
  bindings: SidechatModelBindings,
  trustedHosts: () => readonly string[],
  options: ModelBindingsHttpOptions = {},
): ModelBindingsHttpSurface {
  const pruneInterval = setInterval(() => { bindings.expire() }, options.pruneIntervalMs ?? 15_000)
  pruneInterval.unref?.()
  let disposed = false

  return {
    async handle(req, res) {
      if (!isTrustedApiRequest(req, trustedHosts())) {
        empty(res, 403)
        return
      }
      if (disposed) {
        empty(res, 503, { 'retry-after': '1' })
        return
      }
      if (req.method !== 'PUT' && req.method !== 'DELETE') {
        empty(res, 405, { allow: 'PUT, DELETE' })
        return
      }

      let body: unknown
      try {
        body = await readBody(req)
      } catch (error) {
        empty(res, error instanceof RangeError ? 413 : 400)
        return
      }

      if (req.method === 'DELETE') {
        const release = parseRelease(body)
        if (release === undefined) {
          empty(res, 400)
          return
        }
        bindings.unbind(release.clientId, release.childId)
        empty(res, 204)
        return
      }

      const request = parseModelBindingRequest(body)
      if (request === undefined) {
        empty(res, 400)
        return
      }
      try {
        json(res, 200, await bindings.bind(request as ModelBindingRequest))
      } catch {
        empty(res, 503, { 'retry-after': '1' })
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(pruneInterval)
      bindings.dispose()
    },
  }
}
