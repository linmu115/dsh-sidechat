import { describe, expect, it } from 'vitest'

import {
  canSubmitWithModel,
  isComposerSubmitKey,
} from '../src/client/sidechat/model-submit-gate.ts'

describe('Sidechat model submit gate', () => {
  it('blocks new prompts until the child model is ready', () => {
    expect(canSubmitWithModel(true, 'pending')).toBe(false)
    expect(canSubmitWithModel(true, 'switching')).toBe(false)
    expect(canSubmitWithModel(true, 'ready')).toBe(true)
    expect(canSubmitWithModel(false, 'ready')).toBe(false)
  })

  it('recognizes only an unmodified, non-composing Enter shortcut', () => {
    expect(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true)
    expect(isComposerSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 })).toBe(false)
    expect(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 })).toBe(false)
    expect(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false)
    expect(isComposerSubmitKey({ key: 'a', shiftKey: false, isComposing: false, keyCode: 65 })).toBe(false)
  })
})
