import type { HLCTimestamp } from '@korajs/core'
import { addWinsSet } from './add-wins-set'
import { lastWriteWins } from './lww'

/**
 * Convergent merge for `object` and `json` fields.
 *
 * Structured values are merged as a 3-way LWW map with add-wins key presence:
 * two devices that edit different keys of the same object offline both keep
 * their edits on reconnect, instead of one write clobbering the whole object.
 *
 * Per key, each side's action is classified against the base (the value before
 * either operation):
 * - wrote (added the key, or changed its value)
 * - removed (present in base, absent now)
 * - unchanged
 *
 * Resolution:
 * - unchanged + unchanged      → base value
 * - wrote + unchanged          → the written value
 * - removed + unchanged        → absent
 * - removed + removed          → absent
 * - wrote + removed            → the write wins (add-wins: never silently drop an edit)
 * - wrote + wrote              → recurse if both are plain objects; add-wins if both
 *                                arrays; otherwise last-write-wins by the operations'
 *                                HLC timestamps
 *
 * The result is commutative (swapping local/remote also swaps the HLCs, and HLC
 * compare is a symmetric total order), idempotent (merging a value with itself
 * returns it), and deterministic. Absent keys are omitted from the result.
 *
 * @param localValue - Local value after the local operation
 * @param remoteValue - Remote value after the remote operation
 * @param baseValue - Value before either operation (for 3-way diffing)
 * @param localTs - HLC timestamp of the local operation
 * @param remoteTs - HLC timestamp of the remote operation
 * @returns The merged object
 */
export function mergeObject(
	localValue: unknown,
	remoteValue: unknown,
	baseValue: unknown,
	localTs: HLCTimestamp,
	remoteTs: HLCTimestamp,
): Record<string, unknown> {
	const local = asPlainObject(localValue)
	const remote = asPlainObject(remoteValue)
	const base = asPlainObject(baseValue)

	// If either side isn't an object (a scalar replaced the whole value), there is
	// no map structure to reconcile: fall back to last-write-wins on the whole value.
	if (local === null || remote === null) {
		const winner = lastWriteWins(localValue, remoteValue, localTs, remoteTs).value
		return (asPlainObject(winner) ?? {}) as Record<string, unknown>
	}

	const baseObj = base ?? {}
	const result: Record<string, unknown> = {}

	const keys = new Set<string>([
		...Object.keys(local),
		...Object.keys(remote),
		...Object.keys(baseObj),
	])

	for (const key of keys) {
		const inLocal = key in local
		const inRemote = key in remote
		const inBase = key in baseObj
		const localVal = local[key]
		const remoteVal = remote[key]
		const baseVal = baseObj[key]

		const localWrote = inLocal && (!inBase || !valuesEqual(localVal, baseVal))
		const remoteWrote = inRemote && (!inBase || !valuesEqual(remoteVal, baseVal))
		const localRemoved = !inLocal && inBase
		const remoteRemoved = !inRemote && inBase

		// Both sides wrote this key: reconcile the two written values.
		if (localWrote && remoteWrote) {
			result[key] = mergeWrittenValues(localVal, remoteVal, baseVal, localTs, remoteTs)
			continue
		}

		// One side wrote, the other left it untouched (or it did not exist there).
		if (localWrote && !remoteRemoved) {
			result[key] = localVal
			continue
		}
		if (remoteWrote && !localRemoved) {
			result[key] = remoteVal
			continue
		}

		// One side wrote, the other removed it: add-wins, the write survives.
		if (localWrote && remoteRemoved) {
			result[key] = localVal
			continue
		}
		if (remoteWrote && localRemoved) {
			result[key] = remoteVal
			continue
		}

		// Neither side wrote. If either removed it, it stays gone; otherwise keep base.
		if (localRemoved || remoteRemoved) {
			continue
		}
		if (inBase) {
			result[key] = baseVal
		}
	}

	return result
}

/**
 * Reconcile two concurrently-written values for the same key: recurse for nested
 * objects, add-wins for nested arrays, last-write-wins otherwise.
 */
function mergeWrittenValues(
	localVal: unknown,
	remoteVal: unknown,
	baseVal: unknown,
	localTs: HLCTimestamp,
	remoteTs: HLCTimestamp,
): unknown {
	if (asPlainObject(localVal) !== null && asPlainObject(remoteVal) !== null) {
		return mergeObject(localVal, remoteVal, baseVal, localTs, remoteTs)
	}
	if (Array.isArray(localVal) && Array.isArray(remoteVal)) {
		const baseArr = Array.isArray(baseVal) ? baseVal : []
		return addWinsSet(localVal, remoteVal, baseArr)
	}
	return lastWriteWins(localVal, remoteVal, localTs, remoteTs).value
}

/**
 * Returns the value as a plain object record, or null if it is not a plain
 * object (arrays, null, and primitives are not treated as maps).
 */
function asPlainObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null
	}
	// Reject class instances / exotic objects (Date, Map, Uint8Array, ...): only
	// plain data objects participate in structural map merge.
	const proto = Object.getPrototypeOf(value)
	if (proto !== null && proto !== Object.prototype) {
		return null
	}
	return value as Record<string, unknown>
}

/** Structural equality for 3-way diffing (stable-key JSON comparison). */
function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true
	}
	return stableStringify(a) === stableStringify(b)
}

/** JSON stringify with sorted object keys so key order does not affect equality. */
function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep)
	}
	if (typeof value === 'object' && value !== null) {
		const proto = Object.getPrototypeOf(value)
		if (proto === null || proto === Object.prototype) {
			const record = value as Record<string, unknown>
			const sorted: Record<string, unknown> = {}
			for (const key of Object.keys(record).sort()) {
				sorted[key] = sortKeysDeep(record[key])
			}
			return sorted
		}
	}
	return value
}
