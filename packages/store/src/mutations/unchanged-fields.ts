import type { CollectionDefinition } from '@korajs/core'
import { isAtomicOp } from '@korajs/core'
import type { CollectionRecord } from '../types'
import { sameValue } from './same-value'

/**
 * The fields of an update that would change the record.
 *
 * A field whose new value equals the record's current value writes nothing: for
 * last-write-wins an update equal to its own `previousData` is not a write, so the
 * operation would only add log, upload and download work (an autosave that re-saves the
 * same form hundreds of times left a log where 975 of 983 updates changed nothing, and a
 * new device paid for every one of them). Atomic ops (they resolve against the record),
 * richtext (a CRDT, compared by state, not value) and secret fields (stored hashed or
 * encrypted, so the stored value is not comparable to the input) are always kept.
 *
 * @param definition - The collection's definition
 * @param current - The record as it stands now
 * @param allowed - The validated update, state machine applied
 * @returns The update without its unchanged fields (the same object when nothing was dropped)
 */
export function withoutUnchangedFields(
	definition: CollectionDefinition,
	current: CollectionRecord,
	allowed: Record<string, unknown>,
): Record<string, unknown> {
	let changed: Record<string, unknown> | null = null
	for (const [field, value] of Object.entries(allowed)) {
		const kind = definition.fields[field]?.kind
		const unchanged =
			kind !== undefined &&
			kind !== 'richtext' &&
			kind !== 'secret' &&
			!isAtomicOp(value) &&
			sameValue(current[field], value)
		if (!unchanged) continue
		changed ??= { ...allowed }
		delete changed[field]
	}
	return changed ?? allowed
}
