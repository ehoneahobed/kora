import { base64ToBytes, bytesToBase64 } from '../operations/op-data-binary'
import { blindSalt, blindedKey, isBlindedKey } from './blind'
import { isElementPresent, isKeyVisible, ownValue } from './field-states'
import { compareStamps, isAfter } from './stamp'
import type {
	ElementSetFieldState,
	ElementState,
	FieldState,
	FoldState,
	KeyMapFieldState,
	KeyState,
	RichtextSubsumes,
	Stamp,
} from './types'

/** The Yjs operations {@link redactFoldState} needs for richtext (core has no Yjs dependency). */
export interface RichtextRedaction {
	/** Whether update `a` adds nothing to update `b`. */
	subsumes: RichtextSubsumes
	/** The update re-encoded on its own: what its own delete set removed is no longer in it. */
	normalize: (update: Uint8Array) => Uint8Array
}

/**
 * The live updates a replica needs. An update another one contains is dropped when that one
 * is not older (the rule the device's fold applies to its own updates), so a reset that
 * arrives late hides or shows the same content. The rest are re-encoded alone, because an
 * editor's undo history keeps deleted text in the snapshots it saves.
 */
function redactRichtextUpdates(
	live: ReadonlyArray<readonly [string, Stamp]>,
	richtext: RichtextRedaction,
): Record<string, Stamp> {
	const newestFirst = [...live].sort(
		([a, s], [b, t]) => compareStamps(t, s) || (a < b ? -1 : a > b ? 1 : 0),
	)
	const kept: Array<{ bytes: Uint8Array; stamp: Stamp }> = []
	for (const [update, stamp] of newestFirst) {
		const bytes = base64ToBytes(update)
		// Newest first: everything already kept is at least as new as this update.
		if (!kept.some((other) => richtext.subsumes(bytes, other.bytes))) kept.push({ bytes, stamp })
	}
	const out: Record<string, Stamp> = {}
	for (const { bytes, stamp } of kept) {
		const key = bytesToBase64(richtext.normalize(bytes))
		const existing = out[key]
		out[key] = existing === undefined || compareStamps(stamp, existing) > 0 ? stamp : existing
	}
	return out
}

function redactElementSet(state: ElementSetFieldState, salt: string): ElementSetFieldState {
	// Append-only: nothing is ever removed, and elements hidden by a non-array value come
	// back when the field is an array again, so they are part of its value.
	if (state.ao) return state
	const el: Record<string, ElementState> = {}
	for (const [key, element] of Object.entries(state.el)) {
		if (isBlindedKey(key) || isElementPresent(element, state)) el[key] = element
		else el[blindedKey(salt, key)] = { ...element, v: null }
	}
	return { ...state, el }
}

function redactKeyMap(state: KeyMapFieldState, salt: string): KeyMapFieldState {
	const keys: Record<string, KeyState> = {}
	for (const key of Object.keys(state.keys)) {
		const entry = ownValue(state.keys, key) as KeyState
		const shown = isBlindedKey(key) || isKeyVisible(state, entry)
		// A hidden key's value is never shown again: only a newer write replaces the entry.
		Object.defineProperty(keys, shown ? key : blindedKey(salt, key), {
			value: shown ? entry : { s: entry.s, del: true },
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return { ...state, keys }
}

function redactField(
	state: FieldState,
	salt: string,
	richtext: RichtextRedaction | undefined,
): FieldState {
	switch (state.k) {
		case 'set':
			return redactElementSet(state, salt)
		case 'map':
			return redactKeyMap(state, salt)
		case 'max':
		case 'min':
			// The register only counts while no numeric write exists, and one never goes away.
			return state.best !== null && state.reg !== null ? { ...state, reg: null } : state
		case 'rt': {
			const live = Object.entries(state.u).filter(([, stamp]) =>
				isAfter(stamp, state.reset?.s ?? null),
			)
			return {
				k: 'rt',
				// A reset only moves forward and live updates stay live, so with any live
				// update this reset's value can never be shown.
				reset:
					state.reset !== null && live.length > 0 ? { s: state.reset.s, v: null } : state.reset,
				u: richtext ? redactRichtextUpdates(live, richtext) : Object.fromEntries(live),
			}
		}
		// These fold over their history: a late write lands between earlier ones and the result
		// depends on the values around it, and a replica may join this state with part of the
		// same history. Rewriting the entries would change merged values.
		case 'reg':
		case 'ctr':
		case 'res':
			return state
	}
}

/**
 * A copy of a record's fold state that does not show what its current value does not, for a
 * replica that may not read the record's earlier values (a scope entry, issue #80).
 *
 * Removed or cleared array elements and deleted or cleared object keys keep their stamps
 * under a salted digest of their value. Merging still needs them: a late add of a removed
 * element must stay removed, and a device that holds the element from before must see it
 * go. A replica that meets the same value in a write matches the digest and folds exactly as
 * if it had held the entry all along. A max/min field's shadowed non-numeric value and
 * richtext updates hidden by a reset are dropped, since nothing can bring them back. With
 * `richtext`, updates a newer one contains are dropped too and text an update deleted is
 * removed from it.
 *
 * The result materializes to the same record, and folds and joins to the same record as the
 * full state. Three limits remain, all documented in `docs/guide/access-rules.md`:
 * - A reader who guesses a removed value exactly can confirm the guess against its digest.
 * - Counters, atomic chains and custom-resolver logs are unchanged: their merged value
 *   depends on the earlier writes, in order, so they cannot be hidden without changing it.
 * - Richtext deleted by one device stays in a newer update from a device that had not seen
 *   the deletion: a reset arriving late could still make that update the record's value.
 *
 * @param state - The record's full fold state
 * @param richtext - Yjs operations; without them richtext updates that are live stay whole
 * @returns The redacted copy
 */
export function redactFoldState(state: FoldState, richtext?: RichtextRedaction): FoldState {
	const fields: Record<string, FieldState> = {}
	for (const [field, fieldState] of Object.entries(state.f)) {
		fields[field] = redactField(fieldState, blindSalt(state.c, state.r, field), richtext)
	}
	return { ...state, f: fields }
}
