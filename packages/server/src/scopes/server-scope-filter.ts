import type { Operation } from '@korajs/core'

/**
 * Per-collection scope map from auth context.
 */
export type ScopeMap = Record<string, Record<string, unknown>>

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

	const snapshot = buildSnapshot(op, fullRecord)
	if (!snapshot) return false

	for (const [field, expected] of Object.entries(collectionScope)) {
		if (snapshot[field] !== expected) {
			return false
		}
	}

	return true
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
