/**
 * The one scope-predicate matcher shared by the server, the sync engine and the
 * local store.
 *
 * A collection scope is either a conjunction of field predicates
 * (`{ ownerId: 'u1', status: { $in: ['a', 'b'] } }`, every field must match) or a
 * disjunction of such conjunctions (`{ $or: [conjunction, ...] }`, at least one branch
 * must match). A field predicate is an exact value (compared with `Object.is`) or a
 * bounded `{ $in: [...] }` list.
 *
 * Every consumer goes through the helpers below and never iterates a collection scope
 * as a field map, so `$or` can never be mistaken for a field name. Everything fails
 * closed: a malformed `$or` (not an array, empty, nested, or next to field keys), an
 * `undefined`/`null` predicate value or a non-array `$in` matches nothing. A deny is
 * represented by leaving the collection out of the scope map; `{}` means "every
 * record" and is never produced by simplifying a disjunction with no branches.
 */

/** Field predicates that must all match (an empty conjunction admits every record). */
export type ScopeConjunction = Readonly<Record<string, unknown>>

/** At least one branch must match. */
export interface ScopeDisjunction {
	readonly $or: readonly ScopeConjunction[]
}

/** A collection scope: a conjunction, or a disjunction of conjunctions. */
export type CollectionScope = ScopeConjunction | ScopeDisjunction

/** Largest number of branches in one `$or`. */
export const MAX_SCOPE_BRANCHES = 8

/** The key of a disjunction. Field names may not start with `$`, so it cannot collide. */
export const SCOPE_OR_KEY = '$or'

/** True when `scope` is written as a disjunction (well-formed or not). */
export function isScopeDisjunction(scope: unknown): scope is ScopeDisjunction {
	return (
		scope !== null && typeof scope === 'object' && !Array.isArray(scope) && SCOPE_OR_KEY in scope
	)
}

/**
 * The branches of a collection scope: one for a conjunction, the `$or` list for a
 * disjunction. A malformed scope yields no branches, so it matches nothing.
 *
 * @param scope - A collection scope
 * @returns Its conjunctions; empty when the scope is malformed
 */
export function scopeBranches(
	scope: CollectionScope | null | undefined,
): readonly ScopeConjunction[] {
	if (scope === null || scope === undefined || typeof scope !== 'object' || Array.isArray(scope))
		return []
	if (!isScopeDisjunction(scope)) return [scope as ScopeConjunction]
	if (Object.keys(scope).length !== 1) return []
	const branches = (scope as { $or: unknown }).$or
	if (!Array.isArray(branches) || branches.length === 0 || branches.length > MAX_SCOPE_BRANCHES)
		return []
	for (const branch of branches) {
		if (
			branch === null ||
			typeof branch !== 'object' ||
			Array.isArray(branch) ||
			isScopeDisjunction(branch)
		) {
			return []
		}
	}
	return branches as readonly ScopeConjunction[]
}

/**
 * True when the scope admits every record of its collection (some branch has no field
 * predicate). A malformed scope is never unrestricted.
 */
export function isUnrestrictedScope(scope: CollectionScope | null | undefined): boolean {
	return scopeBranches(scope).some((branch) => Object.keys(branch).length === 0)
}

/**
 * Every field any branch of the scope reads, sorted. Used to know which fields a
 * record or snapshot must carry before it can be judged.
 */
export function scopeFieldNames(scope: CollectionScope | null | undefined): string[] {
	const fields = new Set<string>()
	for (const branch of scopeBranches(scope)) {
		for (const field of Object.keys(branch)) fields.add(field)
	}
	return [...fields].sort()
}

/**
 * True when a record is inside a collection scope: some branch has every one of its
 * field predicates matched.
 *
 * @param record - The record (or snapshot) to test
 * @param scope - The collection's scope
 * @returns Whether the record is inside the scope
 */
export function recordMatchesCollectionScope(
	record: Readonly<Record<string, unknown>>,
	scope: CollectionScope | null | undefined,
): boolean {
	for (const branch of scopeBranches(scope)) {
		if (conjunctionMatches(record, branch)) return true
	}
	return false
}

/**
 * True when `actual` satisfies a field predicate: an exact value (compared with
 * `Object.is`) or a bounded `{ $in: [...] }` set. An `undefined` or `null` predicate
 * value (or `$in` member) never matches, and neither does any other operator object.
 *
 * @param actual - The record's field value
 * @param expected - The field predicate
 */
export function matchesFieldPredicate(actual: unknown, expected: unknown): boolean {
	// Fail closed (RT-8): an undefined/null predicate value would otherwise match every
	// record that lacks the field.
	if (expected === undefined || expected === null) return false
	if (typeof expected === 'object') {
		if (Array.isArray(expected)) return false
		if (!('$in' in expected) || Object.keys(expected).length !== 1) return false
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

function conjunctionMatches(
	record: Readonly<Record<string, unknown>>,
	branch: ScopeConjunction,
): boolean {
	for (const field of Object.keys(branch)) {
		if (!matchesFieldPredicate(record[field], branch[field])) return false
	}
	return true
}

/** `$in` lists at least this long are looked up through a cached set (F17). */
const MEMBERSHIP_SET_MIN_VALUES = 32
const membershipSets = new WeakMap<readonly unknown[], Set<unknown>>()

/**
 * A set of a large `$in` list, so a membership test is O(1) instead of a scan (a grant
 * can hold thousands of values and every delivered operation is tested). Only for
 * frozen lists, which scope normalization produces: a set of a list that can still
 * change would go stale.
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
 * A set compares with SameValueZero and `Object.is` does not: `0` and `-0` differ under
 * `Object.is`. Such a value is checked by the exact scan instead.
 */
function needsObjectIsScan(actual: unknown): boolean {
	return typeof actual === 'number' && actual === 0
}

/**
 * Narrow a collection scope by a conjunction of extra predicates (a client's own
 * narrowing of its grant). The result never admits a record the grant does not:
 * each branch gains the requested predicates on fields it leaves open, and on a field
 * it constrains only a requested `$in` subset (or a value inside its `$in`) replaces
 * the grant's predicate; anything else keeps the grant's predicate. A requested
 * disjunction is ignored (the grant applies unchanged).
 *
 * @param grant - The granted collection scope
 * @param requested - The requested narrowing, a conjunction
 * @returns The narrowed scope, in the grant's shape
 */
export function narrowCollectionScope(
	grant: CollectionScope,
	requested: ScopeConjunction | undefined,
): CollectionScope {
	if (!requested || isScopeDisjunction(requested)) return grant
	const narrow = (branch: ScopeConjunction): ScopeConjunction => {
		const out: Record<string, unknown> = { ...branch }
		for (const field of Object.keys(requested)) {
			const wanted = requested[field]
			if (!(field in branch)) {
				out[field] = wanted
				continue
			}
			const allowed = branch[field]
			if (isInPredicate(allowed) && isSubsetOf(wanted, allowed.$in)) out[field] = wanted
		}
		return out
	}
	if (!isScopeDisjunction(grant)) return narrow(grant)
	const branches = scopeBranches(grant)
	return branches.length === 0 ? grant : { $or: branches.map(narrow) }
}

function isInPredicate(value: unknown): value is { $in: readonly unknown[] } {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Array.isArray((value as { $in?: unknown }).$in)
	)
}

function isSubsetOf(wanted: unknown, allowed: readonly unknown[]): boolean {
	const contains = (value: unknown): boolean =>
		allowed.some((candidate) => Object.is(candidate, value))
	// An empty `$in` matches nothing: a legitimate (if useless) narrowing.
	if (isInPredicate(wanted)) return wanted.$in.every(contains)
	if (wanted === undefined || wanted === null || typeof wanted === 'object') return false
	return contains(wanted)
}
