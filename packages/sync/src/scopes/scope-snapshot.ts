import type { Operation } from '@korajs/core'

/** Options for {@link buildScopeSnapshot}. */
export interface ScopeSnapshotOptions {
	/**
	 * Layer the writer's `previousData` between the stored record and `op.data`.
	 * Off by default: `previousData` is supplied by the writer and is never checked
	 * against the stored row, so a server visibility decision built on it lets one
	 * tenant steer its operations into another tenant's log (RT-3). Opt in only
	 * where the writer is trusted for the decision, such as a client filtering its
	 * own local view.
	 * @default false
	 */
	includePreviousData?: boolean
}

/**
 * Build the record snapshot a scope or query-subset predicate is evaluated against
 * for an operation.
 *
 * Layering is `fullRecord < data` (or `fullRecord < previousData < data` with
 * `includePreviousData`), so the snapshot approximates the record after the
 * operation. The record identity is NOT taken from any of those
 * layers: `id` is always `op.recordId`, assigned last. An operation (or a stale
 * stored row) can therefore never claim to be a different record than the one it
 * actually targets, which is what made `previousData: { id: '<allowed>' }` a write
 * bypass under id-scoped predicates.
 *
 * This is the single snapshot builder shared by the client scope filter, the client
 * query-subset filter and the server scope filter. It is used for visibility
 * decisions only; upload authorization never reads `previousData` (see the server's
 * `authorizeUplinkWrite`).
 *
 * @param op - The operation being judged
 * @param fullRecord - Optional stored record state used to fill fields the op omits
 * @param options - Whether to trust the writer's `previousData` (default: no)
 * @returns The snapshot, always carrying `id === op.recordId`
 */
export function buildScopeSnapshot(
	op: Operation,
	fullRecord?: Record<string, unknown> | null,
	options: ScopeSnapshotOptions = {},
): Record<string, unknown> {
	return {
		...(fullRecord ?? {}),
		...(options.includePreviousData ? (asPlainRecord(op.previousData) ?? {}) : {}),
		...(asPlainRecord(op.data) ?? {}),
		id: op.recordId,
	}
}

/**
 * True when `actual` satisfies a scope predicate value: either an exact value
 * (compared with `Object.is`) or a bounded `{ $in: [...] }` set. An `undefined` or
 * `null` predicate value (or `$in` member) never matches.
 *
 * @param actual - The record's field value
 * @param expected - The scope predicate for that field
 * @returns Whether the value is inside the predicate
 */
export function matchesScopePredicate(actual: unknown, expected: unknown): boolean {
	// Fail closed (RT-8): an undefined/null predicate value would otherwise match
	// every record that lacks the field. The server refuses such grants outright;
	// this keeps any other caller from widening by accident.
	if (expected === undefined || expected === null) return false
	if (typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
		const values = (expected as { $in?: unknown }).$in
		return (
			Array.isArray(values) &&
			values.some((value) => value !== undefined && value !== null && Object.is(actual, value))
		)
	}
	return Object.is(actual, expected)
}

/**
 * True when every field predicate in a collection scope matches the record.
 *
 * @param record - The record (or snapshot) to test
 * @param collectionScope - Field predicates for the record's collection
 * @returns Whether the record is inside the scope
 */
export function recordMatchesScopePredicates(
	record: Record<string, unknown>,
	collectionScope: Record<string, unknown>,
): boolean {
	for (const [field, expected] of Object.entries(collectionScope)) {
		if (!matchesScopePredicate(record[field], expected)) {
			return false
		}
	}
	return true
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null
	}
	return value as Record<string, unknown>
}
