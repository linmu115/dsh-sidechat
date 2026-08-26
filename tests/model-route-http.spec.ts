import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelRouteHub } from '../src/host/model-settings.ts'
import {
  MODEL_ROUTE_EVENTS_PATH,
  MODEL_ROUTE_SNAPSHOT_PATH,
  createModelRouteHttpSurface,
} from '../src/host/model-route-http.ts'

interface RunningServer {
  server: Server
  port: number
}

const running: RunningServer[] = []

async function listen(surface: ReturnType<typeof createModelRouteHttpSurface>): Promise<RunningServer> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname
    if (path === MODEL_ROUTE_SNAPSHOT_PATH) return surface.snapshot(req, res)
    if (path === MODEL_ROUTE_EVENTS_PATH) return surface.events(req, res)
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing listen address')
  const value = { server, port: address.port }
  running.push(value)
  return value
}

async function closeServer(value: RunningServer): Promise<void> {
  running.splice(running.indexOf(value), 1)
  value.server.close()
  await once(value.server, 'close')
}

async function call(
  port: number,
  path = MODEL_ROUTE_SNAPSHOT_PATH,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

afterEach(async () => {
  for (const value of [...running]) {
    value.server.closeAllConnections()
    await closeServer(value)
  }
})

describe('model route HTTP surface', () => {
  it('serves a no-store snapshot to loopback GET requests', async () => {
    const hub = new ModelRouteHub({ provider: 'p', model: 'm' })
    const surface = createModelRouteHttpSurface(hub, () => [])
    const server = await listen(surface)

    const response = await call(server.port)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(JSON.parse(response.body)).toEqual({
      revision: 0,
      route: { provider: 'p', model: 'm' },
    })

    surface.dispose()
    await closeServer(server)
  })

  it('enforces method, Host, Origin, and Sec-Fetch-Site trust', async () => {
    let trustedHosts: readonly string[] = []
    const surface = createModelRouteHttpSurface(new ModelRouteHub(null), () => trustedHosts)
    const server = await listen(surface)

    expect((await call(server.port, MODEL_ROUTE_SNAPSHOT_PATH, { method: 'POST' })).status).toBe(405)
    expect((await call(server.port, MODEL_ROUTE_SNAPSHOT_PATH, {
      headers: { host: 'attacker.test', origin: 'http://attacker.test' },
    })).status).toBe(403)

    trustedHosts = ['dsh.example.test']
    expect((await call(server.port, MODEL_ROUTE_SNAPSHOT_PATH, {
      headers: { host: 'dsh.example.test:3000', origin: 'http://dsh.example.test' },
    })).status).toBe(200)
    expect((await call(server.port, MODEL_ROUTE_SNAPSHOT_PATH, {
      headers: { host: 'dsh.example.test:3000', origin: 'http://other.test' },
    })).status).toBe(403)
    expect((await call(server.port, MODEL_ROUTE_SNAPSHOT_PATH, {
      headers: {
        host: 'dsh.example.test:3000',
        origin: 'http://dsh.example.test',
        'sec-fetch-site': 'cross-site',
      },
    })).status).toBe(403)

    surface.dispose()
    await closeServer(server)
  })

  it('sends a full first SSE frame, broadcasts changes, keeps alive, and closes on dispose', async () => {
    const hub = new ModelRouteHub(null)
    const surface = createModelRouteHttpSurface(hub, () => [], { keepAliveMs: 10 })
    const server = await listen(surface)

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port: server.port,
        path: MODEL_ROUTE_EVENTS_PATH,
      }, resolve)
      req.on('error', reject)
      req.end()
    })
    response.setEncoding('utf8')
    let body = ''
    response.on('data', chunk => { body += chunk })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    await vi.waitFor(() => {
      expect(body).toContain('data: {"revision":0,"route":null}\n\n')
    })

    hub.setRoute({ provider: 'p', model: 'next', reasoningEffort: 'high' })
    await vi.waitFor(() => {
      expect(body).toContain('data: {"revision":1,"route":{"provider":"p","model":"next","reasoningEffort":"high"}}\n\n')
      expect(body).toContain(': keepalive\n\n')
    })

    const ended = once(response, 'end')
    surface.dispose()
    await ended
    await closeServer(server)
  })
})
