import {
  MODEL_BINDINGS_PATH,
  parseModelBindingSnapshot,
  type ModelBindingRequest,
  type ModelBindingSnapshot,
  type ModelRoute,
} from '../../model-route.ts'

type BindingInput = Omit<ModelBindingRequest, 'clientId'>

interface FetchResponseLike {
  ok: boolean
  status?: number
  json(): Promise<unknown>
}

export interface ModelBindingClientDependencies {
  fetch(input: string, init: {
    method: 'PUT' | 'DELETE'
    body: string
    headers: { 'content-type': 'application/json' }
    cache: 'no-store'
    credentials: 'same-origin'
    keepalive?: boolean
  }): Promise<FetchResponseLike>
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>
  clearInterval(handle: ReturnType<typeof setInterval>): void
  createClientId(): string
  warn(message: string, error?: unknown): void
}

export interface ModelBindingClient {
  bind(input: BindingInput): Promise<ModelBindingSnapshot>
  unbind(childId: string): void
  dispose(): void
}

function browserDependencies(): ModelBindingClientDependencies {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: handle => globalThis.clearInterval(handle),
    createClientId: () => globalThis.crypto?.randomUUID?.()
      ?? `sidechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    warn: (message, error) => { console.warn(`[dsh-sidechat] ${message}`, error) },
  }
}

function detached(input: BindingInput): BindingInput {
  const parentRoute: ModelRoute | null = input.parentRoute === null
    ? null
    : {
        provider: input.parentRoute.provider,
        model: input.parentRoute.model,
        ...(input.parentRoute.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: input.parentRoute.reasoningEffort }),
      }
  return {
    childId: input.childId,
    parentSessionId: input.parentSessionId,
    parentRoute,
  }
}

/** One page-wide binding transport with renewable leases and best-effort cleanup. */
export function createModelBindingClient(
  dependencies: ModelBindingClientDependencies = browserDependencies(),
  renewMs = 15_000,
): ModelBindingClient {
  const clientId = dependencies.createClientId()
  const active = new Map<string, BindingInput>()
  let renewal: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const sendBind = async (input: BindingInput): Promise<ModelBindingSnapshot> => {
    const response = await dependencies.fetch(MODEL_BINDINGS_PATH, {
      method: 'PUT',
      body: JSON.stringify({ clientId, ...input }),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error(`model binding request failed with status ${String(response.status ?? 'unknown')}`)
    const snapshot = parseModelBindingSnapshot(await response.json())
    if (snapshot === undefined) throw new Error('model binding response was invalid')
    return snapshot
  }

  const ensureRenewal = (): void => {
    if (renewal !== undefined || active.size === 0 || disposed) return
    renewal = dependencies.setInterval(() => {
      for (const input of active.values()) {
        void sendBind(input).catch((error: unknown) => {
          if (!disposed) dependencies.warn(`failed to renew model binding for ${input.childId}`, error)
        })
      }
    }, renewMs)
  }

  const stopRenewalIfIdle = (): void => {
    if (active.size !== 0 || renewal === undefined) return
    dependencies.clearInterval(renewal)
    renewal = undefined
  }

  const release = (body: { clientId: string; childId?: string }): void => {
    void dependencies.fetch(MODEL_BINDINGS_PATH, {
      method: 'DELETE',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      keepalive: true,
    }).catch((error: unknown) => {
      if (!disposed) dependencies.warn('failed to release a Sidechat model binding', error)
    })
  }

  return {
    async bind(input) {
      if (disposed) throw new Error('model binding client is disposed')
      const copy = detached(input)
      active.set(input.childId, copy)
      ensureRenewal()
      return await sendBind(copy)
    },

    unbind(childId) {
      if (disposed) return
      active.delete(childId)
      stopRenewalIfIdle()
      release({ clientId, childId })
    },

    dispose() {
      if (disposed) return
      if (renewal !== undefined) dependencies.clearInterval(renewal)
      renewal = undefined
      active.clear()
      release({ clientId })
      disposed = true
    },
  }
}
