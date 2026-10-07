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
		if (!Array.isArray(values)) return false
		const set = membershipSet(values)
		if (set !== null && !needsObjectIsScan(actual)) {
			return actual !== undefined && actual !== null && set.has(actual)
		}
		return values.some((value) => value !== undefined && value !== null && Object.is(actual, value))
	}
	return Object.is(actual, expected)
}

/** `$in` lists at least this long are looked up through a cached set (F17). */
const MEMBERSHIP_SET_MIN_VALUES = 32
const membershipSets = new WeakMap<readonly unknown[], Set<unknown>>()

/**
 * A set of a large `$in` list, so a membership test costs O(1) instead of a scan of
 * every value (a grant can hold thousands, and every delivered operation is tested).
 * Only for frozen lists, which the server's scope normalization produces: a list that
 * can still change would make a cached set stale.
 */
function membershipSet(values: readonly unknown[]): Set<unknown> | null {
	if (values.length < MEMBERSHIP_SET_MIN_VALUES || !Object.isFrozen(values)) return null
	let set = membershipSets.get(values)
	if (!set) {
		set = new Set(values)
		membershipSets.set(values, set)
	}
	return set
}

/**
 * A set compares with SameValueZero, `Object.is` does not: `0` and `-0` differ under
 * `Object.is`. Such a value is checked by the exact scan instead.
 */
function needsObjectIsScan(actual: unknown): boolean {
	return typeof actual === 'number' && actual === 0
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
