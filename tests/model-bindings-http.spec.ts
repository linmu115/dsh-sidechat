import { once } from 'node:events'
import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { SidechatModelBindings } from '../src/host/model-bindings.ts'
import {
  MODEL_BINDINGS_PATH,
  createModelBindingsHttpSurface,
} from '../src/host/model-bindings-http.ts'
import { ModelRouteHub } from '../src/host/model-settings.ts'

const servers: Server[] = []

async function listen(surface: ReturnType<typeof createModelBindingsHttpSurface>): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://local').pathname === MODEL_BINDINGS_PATH) {
      void surface.handle(req, res)
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  return { server, port: address.port }
}

async function call(port: number, method: string, value?: unknown): Promise<{ status: number; body: string; cache?: string }> {
  return await new Promise((resolve, reject) => {
    const body = value === undefined ? '' : JSON.stringify(value)
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: MODEL_BINDINGS_PATH,
      method,
      headers: body === '' ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.setEncoding('utf8')
      let responseBody = ''
      res.on('data', chunk => { responseBody += chunk })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: responseBody,
        cache: typeof res.headers['cache-control'] === 'string' ? res.headers['cache-control'] : undefined,
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  }
})

describe('model binding HTTP surface', () => {
  it('binds and releases one trusted mounted child', async () => {
    const bindings = new SidechatModelBindings(
      new ModelRouteHub({ provider: 'p', model: 'pro' }),
      { resolveCallConfig: async route => ({ ...route }) },
    )
    const surface = createModelBindingsHttpSurface(bindings, () => [], { pruneIntervalMs: 100_000 })
    const running = await listen(surface)
    const binding = {
      clientId: 'page',
      childId: 'child',
      parentSessionId: 'parent',
      parentRoute: { provider: 'p', model: 'flash' },
    }

    const put = await call(running.port, 'PUT', binding)
    expect(put.status).toBe(200)
    expect(put.cache).toBe('no-store')
    expect(JSON.parse(put.body)).toEqual({
      revision: 0,
      route: { provider: 'p', model: 'pro' },
    })
    expect(bindings.has('child')).toBe(true)

    expect((await call(running.port, 'DELETE', { clientId: 'page', childId: 'child' })).status).toBe(204)
    expect(bindings.has('child')).toBe(false)
    surface.dispose()
  })

  it('rejects invalid methods and bodies', async () => {
    const bindings = new SidechatModelBindings(
      new ModelRouteHub(null),
      { resolveCallConfig: async route => ({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }) },
    )
    const surface = createModelBindingsHttpSurface(bindings, () => [])
    const running = await listen(surface)
    expect((await call(running.port, 'GET')).status).toBe(405)
    expect((await call(running.port, 'PUT', { clientId: '', childId: 'c' })).status).toBe(400)
    expect((await call(running.port, 'DELETE', { clientId: '' })).status).toBe(400)
    surface.dispose()
  })
})
