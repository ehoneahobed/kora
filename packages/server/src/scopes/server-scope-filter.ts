import type { Operation } from '@korajs/core'

/**
 * Per-collection scope map from auth context.
 */
export type ScopeMap = Record<string, Record<string, unknown>>

export const DEFAULT_MAX_SCOPE_PREDICATE_VALUES = 100

/** Canonicalize bounded `$in` predicates so equivalent authorization has one signature. */
export function normalizeScopeMap(
	scopes: ScopeMap,
	maxValues = DEFAULT_MAX_SCOPE_PREDICATE_VALUES,
): ScopeMap {
	const normalized: ScopeMap = {}
	for (const collection of Object.keys(scopes).sort()) {
		const predicate: Record<string, unknown> = {}
		for (const field of Object.keys(scopes[collection] ?? {}).sort()) {
			const expected = scopes[collection]?.[field]
			if (
				expected &&
				typeof expected === 'object' &&
				!Array.isArray(expected) &&
				'$in' in expected
			) {
				const values = (expected as { $in?: unknown }).$in
				if (!Array.isArray(values))
					throw new Error(`Invalid $in predicate for ${collection}.${field}`)
				const unique = [...new Map(values.map((value) => [stableValueKey(value), value])).values()]
				if (unique.length > maxValues)
					throw new Error(
						`Scope predicate for ${collection}.${field} exceeds the ${maxValues}-value limit`,
					)
				predicate[field] = {
					$in: unique.sort((a, b) => stableValueKey(a).localeCompare(stableValueKey(b))),
				}
			} else predicate[field] = expected
		}
		normalized[collection] = predicate
	}
	return normalized
}

function stableValueKey(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableValueKey).join(',')}]`
	if (value && typeof value === 'object')
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableValueKey((value as Record<string, unknown>)[key])}`,
			)
			.join(',')}}`
	return JSON.stringify(value)
}

/**
 * Returns true if an operation is visible to a session based on its scopes.
 *
 * Rules:
 * - No scopes configured => visible
 * - Collection missing from scope map => hidden
 * - All scoped field/value pairs must match the operation snapshot
 */
export function operationMatchesScopes(
	op: Operation,
	scopes: ScopeMap | undefined,
	fullRecord?: Record<string, unknown> | null,
): boolean {
	if (!scopes) return true

	const collectionScope = scopes[op.collection]
	if (!collectionScope) return false
	if (Object.keys(collectionScope).length === 0) return true

	const snapshot = buildSnapshot(op, fullRecord)
	if (!snapshot) return false

	for (const [field, expected] of Object.entries(collectionScope)) {
		if (!matchesPredicate(snapshot[field], expected)) {
			return false
		}
	}

	return true
}

/** True when an update moved a previously visible record outside the scope. */
export function operationExitsScopes(
	op: Operation,
	scopes: ScopeMap | undefined,
	resultingRecord?: Record<string, unknown> | null,
): boolean {
	if (!scopes || op.type !== 'update' || !op.previousData) return false
	if (operationMatchesScopes(op, scopes, resultingRecord)) return false
	const previousSnapshot = {
		...(resultingRecord ?? {}),
		...(op.data ?? {}),
		...op.previousData,
	}
	return operationMatchesScopes(
		{ ...op, type: 'insert', data: previousSnapshot, previousData: null },
		scopes,
		previousSnapshot,
	)
}

function matchesPredicate(actual: unknown, expected: unknown): boolean {
	if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
		const values = (expected as { $in?: unknown }).$in
		return Array.isArray(values) && values.some((value) => Object.is(actual, value))
	}
	return Object.is(actual, expected)
}

/**
 * Returns the scope fields (for `op.collection`) that a bare operation does NOT
 * carry in its own `data`/`previousData`. When any are missing, the caller must
 * backfill them from the materialized record before scope-checking, otherwise a
 * partial update (or a delete) that does not restate the scope field is wrongly
 * judged out of scope and dropped from relay/delta — silently diverging tenants.
 */
export function missingScopeFields(op: Operation, scopes: ScopeMap | undefined): string[] {
	if (!scopes) return []
	const collectionScope = scopes[op.collection]
	if (!collectionScope) return []
	if (Object.keys(collectionScope).length === 0) return []
	const snapshot = buildSnapshot(op)
	return Object.keys(collectionScope).filter((field) => !snapshot || !(field in snapshot))
}

function buildSnapshot(
	op: Operation,
	fullRecord?: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const previous = asRecord(op.previousData)
	const next = asRecord(op.data)

	if (!previous && !next && !fullRecord) return null

	return {
		...(fullRecord ?? {}),
		...(previous ?? {}),
		...(next ?? {}),
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null
	}

	return value as Record<string, unknown>
}
