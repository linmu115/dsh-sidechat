/**
 * Native composer-reference integration.
 *
 * DSH rc.7 exposes two public halves that are useful together:
 *
 * - `inputTriggers.registerSource()` owns reference serialization;
 * - `SessionInput.insertReference()` puts an object-replacement chip in the
 *   draft without exposing the model-facing quote text in the textarea.
 *
 * The plugin keeps exactly one native reference per session. Its codec reads
 * the current active annotation set at send time, so removing a floating card
 * immediately removes it from the eventual model context as well.
 */
import type {
  Context,
  InputStateSnapshot,
  InputTriggerService,
  ReferenceOccurrence,
  SessionId,
  SessionInput,
} from '../../context-types.ts'
import { buildQuoteBlock } from './format.ts'
import type { AnnotationStore } from './model.ts'

export const ANNOTATION_REFERENCE_SOURCE = 'dsh-sidechat-annotations'
export const HIDDEN_REFERENCE_APPEARANCE = 'dsh-sidechat-hidden'
const PRIVATE_TRIGGER = '\u0000'
const REF_SEPARATOR = '|'

interface EncodedReference {
  readonly sessionId: string
  readonly ownsGap: boolean
}

function encodeReference(sessionId: string, ownsGap: boolean): string {
  return `${encodeURIComponent(sessionId)}${REF_SEPARATOR}${ownsGap ? '1' : '0'}`
}

function decodeReference(ref: string): EncodedReference | undefined {
  const separator = ref.lastIndexOf(REF_SEPARATOR)
  if (separator < 0) return undefined
  try {
    return {
      sessionId: decodeURIComponent(ref.slice(0, separator)),
      ownsGap: ref.slice(separator + 1) === '1',
    }
  } catch {
    return undefined
  }
}

function ownsSession(occurrence: ReferenceOccurrence, sessionId: string): boolean {
  return occurrence.source === ANNOTATION_REFERENCE_SOURCE
    && decodeReference(occurrence.ref)?.sessionId === sessionId
}

function modelContext(store: AnnotationStore, ref: string): string {
  const decoded = decodeReference(ref)
  if (decoded === undefined) return ''
  return buildQuoteBlock(store.listActive(decoded.sessionId))
}

/** Public input-trigger source used only as the codec owner for our chips. */
export function createAnnotationReferenceSource(store: AnnotationStore) {
  return {
    // A private, untypable trigger keeps this codec-only source out of / and @
    // candidate menus while still making it visible to reference serialization.
    trigger: PRIVATE_TRIGGER,
    name: ANNOTATION_REFERENCE_SOURCE,
    candidates: async (): Promise<readonly never[]> => [],
    onPick: (): { text: string } => ({ text: '' }),
    codec: {
      clipboardText(ref: string): string {
        return modelContext(store, ref)
      },
      serialize(ref: string): Promise<string> {
        const context = modelContext(store, ref)
        return context === ''
          ? Promise.reject(new Error('dsh-sidechat: annotation reference has no active context'))
          : Promise.resolve(context)
      },
    },
  }
}

/** Register the reference codec and return its disposer. */
export function registerAnnotationReferenceSource(ctx: Context, store: AnnotationStore): () => void {
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerService | undefined
  if (inputTriggers === undefined) {
    console.warn('[dsh-sidechat] inputTriggers unavailable; annotation references are disabled')
    return () => {}
  }
  return inputTriggers.registerSource(createAnnotationReferenceSource(store))
}

/** Resolve the per-session input facade, degrading to undefined (never throws). */
export function resolveInput(ctx: Context, sessionId: SessionId): SessionInput | undefined {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return undefined
    const conversation = ctx.get('conversation') as { input?: { for(ctx: Context): SessionInput | undefined } } | undefined
    return conversation?.input?.for(actx)
  } catch {
    return undefined
  }
}

/**
 * Remove every native reference owned by this plugin for one session. The
 * separator inserted by DSH is removed only when the encoded reference says
 * this plugin created it.
 */
export function withoutAnnotationReferences(
  snapshot: InputStateSnapshot,
  sessionId: string,
): string {
  const owned = snapshot.occurrences
    .filter(occurrence => ownsSession(occurrence, sessionId))
    .sort((a, b) => b.offset - a.offset)
  let draft = snapshot.draft
  for (const occurrence of owned) {
    const decoded = decodeReference(occurrence.ref)
    let end = occurrence.offset + (occurrence.length ?? 1)
    if (decoded?.ownsGap === true && draft[end] === ' ') end += 1
    draft = draft.slice(0, occurrence.offset) + draft.slice(end)
  }
  return draft
}

/** Keep one native reference iff the session currently has active annotations. */
export function syncSessionReference(
  ctx: Context,
  store: AnnotationStore,
  sessionId: SessionId,
): 'inserted' | 'removed' | 'unchanged' | 'unavailable' | 'failed' {
  try {
    const input = resolveInput(ctx, sessionId)
    if (input === undefined) return 'unavailable'
    const snapshot = input.state.getSnapshot()
    const owned = snapshot.occurrences.filter(occurrence => ownsSession(occurrence, sessionId))
    const hasActive = store.countActive(sessionId) > 0

    if (hasActive && owned.length === 0) {
      const ownsGap = snapshot.draft === '' || snapshot.draft[0] !== ' '
      const inserted = input.insertReference({
        source: ANNOTATION_REFERENCE_SOURCE,
        ref: encodeReference(sessionId, ownsGap),
        // rc.2 always renders native references as `@${label}`. The custom
        // appearance is hidden by our narrowly scoped composer style, while
        // the occurrence remains available to the native submit serializer.
        label: '',
        appearance: HIDDEN_REFERENCE_APPEARANCE,
        clipboardText: buildQuoteBlock(store.listActive(sessionId)),
      }, {
        start: 0,
        end: 0,
        draftRev: snapshot.draftRev,
      })
      return inserted ? 'inserted' : 'failed'
    }

    if (!hasActive && owned.length > 0) {
      const nextDraft = withoutAnnotationReferences(snapshot, sessionId)
      if (nextDraft !== snapshot.draft) input.setDraft(nextDraft)
      return 'removed'
    }

    return 'unchanged'
  } catch (error) {
    console.warn('[dsh-sidechat] reference sync failed:', error)
    return 'failed'
  }
}

/** Re-sync every session that has ever held an annotation in this activation. */
export function syncAllReferences(ctx: Context, store: AnnotationStore): void {
  for (const sessionId of store.sessions()) syncSessionReference(ctx, store, sessionId)
}

/** Remove stale chips before HMR/plugin teardown unregisters the codec owner. */
export function clearAllReferences(ctx: Context, store: AnnotationStore): void {
  for (const sessionId of store.sessions()) {
    try {
      const input = resolveInput(ctx, sessionId)
      if (input === undefined) continue
      const snapshot = input.state.getSnapshot()
      const nextDraft = withoutAnnotationReferences(snapshot, sessionId)
      if (nextDraft !== snapshot.draft) input.setDraft(nextDraft)
    } catch (error) {
      console.warn('[dsh-sidechat] reference cleanup failed:', error)
    }
  }
}
