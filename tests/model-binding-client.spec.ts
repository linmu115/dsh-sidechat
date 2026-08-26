import { describe, expect, it, vi } from 'vitest'

import {
  createModelBindingClient,
  type ModelBindingClientDependencies,
} from '../src/client/sidechat/model-binding-client.ts'

describe('model binding client', () => {
  it('binds, renews, releases, and disposes one page lease', async () => {
    let renewal: (() => void) | undefined
    const fetch = vi.fn(async (
      _path: string,
      init: Parameters<ModelBindingClientDependencies['fetch']>[1],
    ) => ({
      ok: true,
      status: init.method === 'PUT' ? 200 : 204,
      json: async () => ({ revision: 4, route: { provider: 'p', model: 'pro' } }),
    }))
    const clearInterval = vi.fn()
    const dependencies: ModelBindingClientDependencies = {
      fetch,
      setInterval: vi.fn((callback) => {
        renewal = callback
        return 7 as unknown as ReturnType<typeof setInterval>
      }),
      clearInterval,
      createClientId: () => 'page-a',
      warn: vi.fn(),
    }
    const client = createModelBindingClient(dependencies)
    const input = {
      childId: 'child-a',
      parentSessionId: 'parent-a',
      parentRoute: { provider: 'p', model: 'flash' },
    }

    await expect(client.bind(input)).resolves.toEqual({
      revision: 4,
      route: { provider: 'p', model: 'pro' },
    })
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ clientId: 'page-a', ...input })
    renewal?.()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })

    client.unbind('child-a')
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(3) })
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ clientId: 'page-a', childId: 'child-a' })
    expect(clearInterval).toHaveBeenCalledTimes(1)

    client.dispose()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(4) })
    expect(JSON.parse(fetch.mock.calls[3]![1].body)).toEqual({ clientId: 'page-a' })
  })
})
