import type { Operation } from '@korajs/core'
import type { SyncScopeMap } from '../types'

/**
 * Check whether an operation matches the given scope map.
 *
 * Rules:
 * - No scope map configured: operation is always in scope.
 * - Collection not present in scope map: operation is out of scope.
 * - Empty scope for a collection `{}`: no field restrictions, operation is in scope.
 * - Scope has field/value pairs: all must match in the operation's data snapshot.
 *
 * For updates, the snapshot is built by merging `previousData` and `data` (data wins),
 * which represents the record's state after the operation is applied.
 *
 * @param op - The operation to check
 * @param scopeMap - Per-collection scope filters, or undefined for no filtering
 * @returns true if the operation is within scope
 */
export function operationMatchesScope(op: Operation, scopeMap: SyncScopeMap | undefined): boolean {
	if (!scopeMap) return true

	const collectionScope = scopeMap[op.collection]
	// Collection not present in scope map means it's out of scope
	if (!collectionScope) return false

	// Empty scope means no field restrictions
	if (Object.keys(collectionScope).length === 0) return true

	const snapshot = buildSnapshot(op)
	if (!snapshot) return false

	for (const [field, expected] of Object.entries(collectionScope)) {
		if (snapshot[field] !== expected) {
			return false
		}
	}

	return true
}

/**
 * Filter operations to only those matching the given scope map.
 *
 * @param operations - Array of operations to filter
 * @param scopeMap - Per-collection scope filters
 * @returns Operations that match the scope
 */
export function filterOperationsByScope(
	operations: Operation[],
	scopeMap: SyncScopeMap | undefined,
): Operation[] {
	if (!scopeMap) return operations
	return operations.filter((op) => operationMatchesScope(op, scopeMap))
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
