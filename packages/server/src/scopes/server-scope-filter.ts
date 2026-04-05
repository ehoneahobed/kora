import type { Operation } from '@kora/core'

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
export function operationMatchesScopes(op: Operation, scopes: ScopeMap | undefined): boolean {
	if (!scopes) return true

	const collectionScope = scopes[op.collection]
	if (!collectionScope) return false

	const snapshot = buildSnapshot(op)
	if (!snapshot) return false

	for (const [field, expected] of Object.entries(collectionScope)) {
		if (snapshot[field] !== expected) {
			return false
		}
	}

	return true
}

function buildSnapshot(op: Operation): Record<string, unknown> | null {
	const previous = asRecord(op.previousData)
	const next = asRecord(op.data)

	if (!previous && !next) return null

	return {
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
