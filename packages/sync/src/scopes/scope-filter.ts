import type { Operation } from '@korajs/core'
import type { SyncScopeMap } from '../types'
import {
	type ScopeSnapshotOptions,
	buildScopeSnapshot,
	recordMatchesScopePredicates,
} from './scope-snapshot'

/**
 * Check whether an operation matches the given scope map.
 *
 * Rules:
 * - No scope map configured: operation is always in scope.
 * - Collection not present in scope map: operation is out of scope.
 * - Empty scope for a collection `{}`: no field restrictions, operation is in scope.
 * - Scope has field/value pairs: all must match in the operation's data snapshot.
 *
 * The snapshot is the operation's `data` (layered over `previousData` only with
 * `options.includePreviousData`), with `id` always taken from `op.recordId`,
 * which represents the record's state after the operation is applied. When an optional
 * `fullRecord` is provided (e.g., from the local store), its values fill in scope fields
 * that weren't included in the operation's data (critical for update operations where
 * `data` only contains changed fields).
 *
 * @param op - The operation to check
 * @param scopeMap - Per-collection scope filters, or undefined for no filtering
 * @param fullRecord - Optional full record state from the store, used to fill in scope
 *   fields not present in the operation's partial data
 * @param options - Snapshot options; `includePreviousData` trusts the writer's
 *   `previousData`, which is only safe for a client judging its own local view
 * @returns true if the operation is within scope
 */
export function operationMatchesScope(
	op: Operation,
	scopeMap: SyncScopeMap | undefined,
	fullRecord?: Record<string, unknown> | null,
	options: ScopeSnapshotOptions = {},
): boolean {
	if (!scopeMap) return true

	const collectionScope = scopeMap[op.collection]
	// Collection not present in scope map means it's out of scope
	if (!collectionScope) return false

	// Empty scope means no field restrictions
	if (Object.keys(collectionScope).length === 0) return true

	// The record identity is always op.recordId (assigned last by the shared
	// snapshot), so an op cannot claim an in-scope `id` through data/previousData.
	return recordMatchesScopePredicates(buildScopeSnapshot(op, fullRecord, options), collectionScope)
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
