import type { ChildModelPhase } from './model-coordinator.ts'

export interface ComposerKeyFacts {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}

export function canSubmitWithModel(composerCanSubmit: boolean, phase: ChildModelPhase): boolean {
  return composerCanSubmit && phase === 'ready'
}

export function isComposerSubmitKey(event: ComposerKeyFacts): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229
}
