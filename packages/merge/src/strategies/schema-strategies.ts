import { HybridLogicalClock } from '@korajs/core'
import type { FieldMergeStrategy, HLCTimestamp, Operation } from '@korajs/core'

/**
 * Schema-declared merge strategies.
 *
 * These are invoked when a field has an explicit `mergeStrategy` declared in the schema
 * via `t.number().merge('counter')` etc. They override the default kind-based auto-merge.
 */

/**
 * Counter merge: sum of deltas from base.
 * Both sides' changes are additive relative to the base value.
 *
 * Example: base=10, local=15, remote=12 → result = 10 + 5 + 2 = 17
 */
export function counterMerge(
	localValue: unknown,
	remoteValue: unknown,
	baseValue: unknown,
): unknown {
	const base = typeof baseValue === 'number' ? baseValue : 0
	const local = typeof localValue === 'number' ? localValue : base
	const remote = typeof remoteValue === 'number' ? remoteValue : base

	const localDelta = local - base
	const remoteDelta = remote - base
	return base + localDelta + remoteDelta
}

/**
 * Max merge: keep the maximum of all concurrent values.
 * Works for numbers and timestamps.
 */
export function maxMerge(localValue: unknown, remoteValue: unknown, baseValue: unknown): unknown {
	const vals: number[] = []
	if (typeof baseValue === 'number') vals.push(baseValue)
	if (typeof localValue === 'number') vals.push(localValue)
	if (typeof remoteValue === 'number') vals.push(remoteValue)

	if (vals.length === 0) return baseValue
	return Math.max(...vals)
}

/**
 * Min merge: keep the minimum of all concurrent values.
 * Works for numbers and timestamps.
 */
export function minMerge(localValue: unknown, remoteValue: unknown, baseValue: unknown): unknown {
	const vals: number[] = []
	if (typeof baseValue === 'number') vals.push(baseValue)
	if (typeof localValue === 'number') vals.push(localValue)
	if (typeof remoteValue === 'number') vals.push(remoteValue)

	if (vals.length === 0) return baseValue
	return Math.min(...vals)
}

/**
 * Append-only merge for arrays: concatenate additions from both sides.
 * Unlike add-wins-set, removals are ignored — items can only be added, never removed.
 *
 * Result = base + local additions + remote additions (preserving order)
 */
export function appendOnlyMerge(
	localValue: unknown,
	remoteValue: unknown,
	baseValue: unknown,
): unknown[] {
	const base = Array.isArray(baseValue) ? baseValue : []
	const local = Array.isArray(localValue) ? localValue : []
	const remote = Array.isArray(remoteValue) ? remoteValue : []

	const serialize = (v: unknown): string => JSON.stringify(v)
	const baseSet = new Set(base.map(serialize))

	// Additions from each side (present in their array but not in base)
	const result = [...base]
	const resultSet = new Set(base.map(serialize))

	for (const item of local) {
		const s = serialize(item)
		if (!baseSet.has(s) && !resultSet.has(s)) {
			result.push(item)
			resultSet.add(s)
		}
	}

	for (const item of remote) {
		const s = serialize(item)
		if (!baseSet.has(s) && !resultSet.has(s)) {
			result.push(item)
			resultSet.add(s)
		}
	}

	return result
}

/**
 * Server-authoritative merge: always prefer the remote (server) value.
 */
export function serverAuthoritativeMerge(
	_localValue: unknown,
	remoteValue: unknown,
	_baseValue: unknown,
): unknown {
	return remoteValue
}

/**
 * Dispatch to the appropriate schema-declared strategy.
 *
 * @returns The merged value, or null if the strategy is not handled here
 *          (e.g., 'lww' and 'union' which are handled by the default autoMerge).
 */
export function applySchemaStrategy(
	strategy: FieldMergeStrategy,
	localValue: unknown,
	remoteValue: unknown,
	baseValue: unknown,
	localTimestamp: HLCTimestamp,
	remoteTimestamp: HLCTimestamp,
): { value: unknown; strategyName: string } | null {
	switch (strategy) {
		case 'counter':
			return {
				value: counterMerge(localValue, remoteValue, baseValue),
				strategyName: 'schema-counter',
			}
		case 'max':
			return { value: maxMerge(localValue, remoteValue, baseValue), strategyName: 'schema-max' }
		case 'min':
			return { value: minMerge(localValue, remoteValue, baseValue), strategyName: 'schema-min' }
		case 'append-only':
			return {
				value: appendOnlyMerge(localValue, remoteValue, baseValue),
				strategyName: 'schema-append-only',
			}
		case 'server-authoritative':
			return {
				value: serverAuthoritativeMerge(localValue, remoteValue, baseValue),
				strategyName: 'schema-server-authoritative',
			}
		case 'lww':
		case 'union':
			// These are handled by the default autoMerge (same behavior)
			return null
		default:
			return null
	}
}
