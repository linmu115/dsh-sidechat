import { describe, expect, it } from 'vitest'

import { observeAnnotationCore, resolveAnnotationCore } from '../src/client/annotation-core-resolver.ts'

describe('resolveAnnotationCore', () => {
  const compatible = {
    version: '0.1.0',
    features: ['dsh-message-source-v1', 'embedded-composer-v1'],
  }

  it('resolves a compatible Cordis service for the requested capability', () => {
    const ctx = { get: (name: string) => name === 'annotationCore' ? compatible : undefined }
    expect(resolveAnnotationCore(ctx as never, ['dsh-message-source-v1'])).toBe(compatible)
  })

  it('returns undefined for a missing, incompatible, or feature-incomplete service', () => {
    expect(resolveAnnotationCore({ get: () => undefined } as never, ['dsh-message-source-v1'])).toBeUndefined()
    expect(resolveAnnotationCore({ get: () => ({ ...compatible, version: '0.2.0' }) } as never, ['dsh-message-source-v1'])).toBeUndefined()
    expect(resolveAnnotationCore({ get: () => compatible } as never, ['answer-link-v1'])).toBeUndefined()
  })

  it('keeps ordinary consumers alive and publishes an injected core dynamically', () => {
    let inject!: (ctx: unknown) => void
    let cleanup!: () => void
    const availability = observeAnnotationCore({
      inject: (_services: string[], callback: (ctx: unknown) => void) => { inject = callback },
    } as never, ['embedded-composer-v1'])
    expect(availability.getSnapshot()).toBeUndefined()

    inject({
      get: () => compatible,
      effect: (setup: () => (() => void)) => { cleanup = setup() },
    })
    expect(availability.getSnapshot()).toBe(compatible)
    cleanup()
    expect(availability.getSnapshot()).toBeUndefined()
  })
})
