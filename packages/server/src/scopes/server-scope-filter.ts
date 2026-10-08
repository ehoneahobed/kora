import type { Operation } from '@korajs/core'
import { KoraError } from '@korajs/core'
import {
	MAX_SCOPE_BRANCHES,
	isScopeDisjunction,
	isUnrestrictedScope,
	scopeBranches,
	scopeFieldNames,
} from '@korajs/core/internal'
import {
	buildScopeSnapshot,
	matchesScopePredicate,
	recordMatchesScopePredicates,
} from '@korajs/sync/internal'
import { ScopePredicateLimitError, assertScopeValuesDefined } from './scope-predicate-errors'

/**
 * Per-collection scope map from auth context.
 */
export type ScopeMap = Record<string, Record<string, unknown>>

export const DEFAULT_MAX_SCOPE_PREDICATE_VALUES = 100

/**
 * Canonicalize bounded `$in` predicates so equivalent authorization has one signature.
 *
 * Fails closed: an `undefined`/`null` predicate value (also inside `$in`) would match
 * every record lacking the field, so it is refused (RT-8).
 *
 * @throws {InvalidScopePredicateError} On an undefined/null predicate value
 * @throws {ScopePredicateLimitError} On a malformed or oversized `$in`
 */
export function normalizeScopeMap(
	scopes: ScopeMap,
	maxValues = DEFAULT_MAX_SCOPE_PREDICATE_VALUES,
): ScopeMap {
	assertScopeValuesDefined(scopes)
	const normalized: ScopeMap = {}
	for (const collection of Object.keys(scopes).sort()) {
		const scope = scopes[collection] ?? {}
		if (!isScopeDisjunction(scope)) {
			normalized[collection] = normalizeConjunction(collection, scope, maxValues)
			continue
		}
		const branches = scopeBranches(scope)
		if (branches.length === 0) {
			throw new ScopePredicateLimitError(
				`Invalid $or scope for ${collection}: it needs 1 to ${MAX_SCOPE_BRANCHES} conjunctions and no other keys`,
				{ collection, maxBranches: MAX_SCOPE_BRANCHES },
			)
		}
		// Canonical: each branch normalized, duplicates removed, sorted by content, so an
		// equivalent grant has one signature. A branch with no predicate admits every
		// record, so the whole scope collapses to {}; one branch collapses to itself.
		const unique = new Map<string, Record<string, unknown>>()
		for (const branch of branches) {
			const canonical = normalizeConjunction(collection, branch, maxValues)
			unique.set(stableValueKey(canonical), canonical)
		}
		const sorted = [...unique.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, b]) => b)
		if (sorted.some((branch) => Object.keys(branch).length === 0)) normalized[collection] = {}
		else if (sorted.length === 1) normalized[collection] = sorted[0] ?? {}
		else normalized[collection] = { $or: Object.freeze(sorted) }
	}
	return normalized
}

function normalizeConjunction(
	collection: string,
	conjunction: Readonly<Record<string, unknown>>,
	maxValues: number,
): Record<string, unknown> {
	const predicate: Record<string, unknown> = {}
	for (const field of Object.keys(conjunction).sort()) {
		const expected = conjunction[field]
		if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
			const values = (expected as { $in?: unknown }).$in
			if (!Array.isArray(values))
				throw new ScopePredicateLimitError(`Invalid $in predicate for ${collection}.${field}`, {
					collection,
					field,
				})
			// Keys are computed once per value and sorted by code unit: a deterministic
			// canonical order (locale-aware comparison is not needed, and is far slower
			// for the thousands of values a large grant holds).
			const unique = [...new Map(values.map((value) => [stableValueKey(value), value])).entries()]
			if (unique.length > maxValues)
				throw new ScopePredicateLimitError(
					`Scope predicate for ${collection}.${field} exceeds the ${maxValues}-value limit`,
					{ collection, field, maxValues },
				)
			predicate[field] = {
				// Frozen: matchers may cache a set of a large list (F17), which is only
				// sound for a list that cannot change.
				$in: Object.freeze(
					unique.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value),
				),
			}
		} else predicate[field] = expected
	}
	return predicate
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
 * - The operation snapshot must match the collection scope (every field predicate of
 *   a conjunction, or of at least one `$or` branch)
 */
export function operationMatchesScopes(
	op: Operation,
	scopes: ScopeMap | undefined,
	fullRecord?: Record<string, unknown> | null,
): boolean {
	if (!scopes) return true

	const collectionScope = scopes[op.collection]
	if (!collectionScope) return false
	if (isUnrestrictedScope(collectionScope)) return true

	return recordMatchesScopePredicates(buildScopeSnapshot(op, fullRecord), collectionScope)
}

/**
 * True when an update moved a previously visible record outside the scope, judged
 * on the scope values the store captured from its own rows before and after the
 * write (RT-15). The writer's `previousData` is never consulted: it is unverified,
 * so it could inject retractions for its own records into another tenant's stream.
 *
 * @param op - The operation (only updates can exit a scope)
 * @param snapshot - The scope values captured when the operation was applied
 * @param scopes - The session's download scope
 */
export function snapshotExitsScopes(
	op: Operation,
	snapshot: { pre: Record<string, unknown> | null; post: Record<string, unknown> | null },
	scopes: ScopeMap | undefined,
	current?: Record<string, unknown> | null,
): boolean {
	if (!scopes || op.type !== 'update' || !snapshot.pre || !snapshot.post) return false
	const pre = snapshotValuesWithFallback(op.collection, snapshot.pre, scopes, current)
	const post = snapshotValuesWithFallback(op.collection, snapshot.post, scopes, current)
	if (!pre || !post) return false
	return (
		recordMatchesScopes(op.collection, { ...pre, id: op.recordId }, scopes) &&
		!recordMatchesScopes(op.collection, { ...post, id: op.recordId }, scopes)
	)
}

/**
 * True when a field value satisfies one scope predicate (exact value or `$in`).
 * Shared by the sync path and the route context so both honour the same operators.
 *
 * @param actual - The record's field value
 * @param expected - The scope predicate for that field
 * @returns Whether the value is inside the predicate
 */
export function matchesPredicate(actual: unknown, expected: unknown): boolean {
	return matchesScopePredicate(actual, expected)
}

/**
 * True when a stored record is inside the scope declared for its collection. A
 * collection absent from the scope map is out of scope; an empty predicate admits
 * every record. The record's `id` is used as stored, so callers must pass a row
 * read by id (never one assembled from client-supplied fields).
 *
 * @param collection - The record's collection
 * @param record - The stored record
 * @param scopes - Scope map, or undefined for no restriction
 * @returns Whether the record is visible under the scope
 */
export function recordMatchesScopes(
	collection: string,
	record: Record<string, unknown>,
	scopes: ScopeMap | undefined,
): boolean {
	if (!scopes) return true
	const collectionScope = scopes[collection]
	if (!collectionScope) return false
	return recordMatchesScopePredicates(record, collectionScope)
}

/**
 * One side of a scope snapshot, with every scope field the snapshot does not hold
 * taken from the record's current row (RT-20). A snapshot captured before a schema
 * change that added (or renamed) a scope field lacks that field entirely; judging it
 * as "no value" would hide the record's whole history from every session. A field
 * that IS present (including null, which an over-long string is recorded as) is
 * kept, so a present-and-mismatched value still fails closed.
 *
 * @param collection - The record's collection
 * @param values - The snapshot side (`pre` or `post`), or null
 * @param scopes - The session's download scope
 * @param current - The record's current stored row, when known
 * @returns The values to judge, or null when `values` is null
 */
export function snapshotValuesWithFallback(
	collection: string,
	values: Record<string, unknown> | null,
	scopes: ScopeMap | undefined,
	current: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
	if (!values) return null
	const predicate = scopes?.[collection]
	if (!predicate) return values
	let filled: Record<string, unknown> | null = null
	for (const field of scopeFieldNames(predicate)) {
		if (field in values) continue
		if (!current || !(field in current)) continue
		filled ??= { ...values }
		filled[field] = current[field]
	}
	return filled ?? values
}

/**
 * True when one of the snapshot's scope fields is absent, so a caller must read the
 * current row before judging it (see {@link snapshotValuesWithFallback}).
 */
export function snapshotLacksScopeFields(
	collection: string,
	snapshot: { pre: Record<string, unknown> | null; post: Record<string, unknown> | null },
	scopes: ScopeMap | undefined,
): boolean {
	const predicate = scopes?.[collection]
	if (!predicate) return false
	const fields = scopeFieldNames(predicate)
	const lacks = (values: Record<string, unknown> | null): boolean =>
		values !== null && fields.some((field) => !(field in values))
	return lacks(snapshot.pre) || lacks(snapshot.post)
}

/**
 * True when an operation moved an existing record INTO the scope: the store's own
 * pre-image was out of scope and the post-image is in it (RT-19). Inserts (no
 * pre-image) are not entries; they carry the whole record themselves.
 *
 * @param op - The operation
 * @param snapshot - The scope values captured when it was applied
 * @param scopes - The session's download scope
 * @param current - The record's current row, for scope fields a legacy snapshot lacks
 */
export function snapshotEntersScopes(
	op: Operation,
	snapshot: { pre: Record<string, unknown> | null; post: Record<string, unknown> | null },
	scopes: ScopeMap | undefined,
	current?: Record<string, unknown> | null,
): boolean {
	if (!scopes || op.type !== 'update') return false
	const pre = snapshotValuesWithFallback(op.collection, snapshot.pre, scopes, current)
	const post = snapshotValuesWithFallback(op.collection, snapshot.post, scopes, current)
	if (!pre || !post) return false
	return (
		!recordMatchesScopes(op.collection, { ...pre, id: op.recordId }, scopes) &&
		recordMatchesScopes(op.collection, { ...post, id: op.recordId }, scopes)
	)
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
	if (isUnrestrictedScope(collectionScope)) return []
	const snapshot = buildScopeSnapshot(op)
	return scopeFieldNames(collectionScope).filter((field) => !(field in snapshot))
}

/** Why {@link authorizeUplinkWrite} refused a write. */
export type UplinkAuthorizationCode = 'SCOPE_VIOLATION' | 'INVALID_OPERATION'

/** Result of {@link authorizeUplinkWrite}. */
export type UplinkAuthorizationResult =
	| { allowed: true }
	| { allowed: false; code: UplinkAuthorizationCode; message: string }

/**
 * Thrown by a server store when the uplink authorization re-check, evaluated inside
 * the store's apply critical section against the row as it is at commit time,
 * refuses an operation. Nothing was written.
 */
export class UplinkAuthorizationError extends KoraError {
	constructor(
		readonly rejectionCode: UplinkAuthorizationCode,
		message: string,
		context?: Record<string, unknown>,
	) {
		super(message, rejectionCode, context)
		this.name = 'UplinkAuthorizationError'
	}
}

/**
 * Decides whether an untrusted writer (a sync session or a scoped route) may apply
 * `op`, given the record as it is currently stored and the writer's scope.
 *
 * This is the single authorization rule for every untrusted write path (sync
 * uploads, `request.kora` routes, the conditional store path and the Yjs doc
 * channel). It never reads `op.previousData` for scope decisions, because it is
 * attacker-controlled, and it never lets op fields name a different record:
 *
 * 1. `op.data` / `op.previousData` must not carry an `id` other than `op.recordId`
 *    (`INVALID_OPERATION`), whether or not scopes are configured.
 * 2. Without scopes every (well-formed) write is allowed.
 * 3. If a stored row exists (including a soft-deleted one) it must be in scope,
 *    judged on the stored values only, for inserts, updates and deletes alike. This
 *    stops editing, deleting or overwriting (same-id insert) another tenant's record.
 * 4. The post-image must be in scope: `{...stored, ...op.data}` for updates,
 *    `op.data` for inserts and the stored row for deletes. This stops moving a
 *    record out of scope (ownership transfer is a trusted server-route operation).
 *
 * In both images `id` is `op.recordId`, assigned last.
 *
 * @param op - The operation the writer wants to apply
 * @param storedRow - The record as stored now (including soft-deleted), or null
 * @param scopes - The writer's uplink scope map, or undefined for no restriction
 * @returns Whether the write is allowed, and why not when it is refused
 */
export function authorizeUplinkWrite(
	op: Operation,
	storedRow: Record<string, unknown> | null | undefined,
	scopes: ScopeMap | undefined,
): UplinkAuthorizationResult {
	const forgedIn = conflictingIdentity(op)
	if (forgedIn !== null) {
		return {
			allowed: false,
			code: 'INVALID_OPERATION',
			message: `Operation "${op.id}" on "${op.collection}" carries ${forgedIn}.id that differs from its recordId "${op.recordId}".`,
		}
	}
	if (!scopes) return { allowed: true }

	const collectionScope = scopes[op.collection]
	if (!collectionScope) {
		return scopeViolation(op, `collection "${op.collection}" is not in the writer's scope`)
	}
	if (isUnrestrictedScope(collectionScope)) return { allowed: true }

	const stored = storedRow ?? null
	if (stored !== null) {
		const preImage = { ...stored, id: op.recordId }
		if (!recordMatchesScopePredicates(preImage, collectionScope)) {
			return scopeViolation(op, "the stored record is outside the writer's scope")
		}
	}

	const data = asRecord(op.data) ?? {}
	const postImage =
		op.type === 'insert'
			? { ...data, id: op.recordId }
			: op.type === 'update'
				? { ...(stored ?? {}), ...data, id: op.recordId }
				: { ...(stored ?? {}), id: op.recordId }
	if (!recordMatchesScopePredicates(postImage, collectionScope)) {
		return scopeViolation(op, "the resulting record would be outside the writer's scope")
	}
	return { allowed: true }
}

function scopeViolation(op: Operation, reason: string): UplinkAuthorizationResult {
	return {
		allowed: false,
		code: 'SCOPE_VIOLATION',
		message: `Operation "${op.id}" on "${op.collection}" record "${op.recordId}" is outside the accepted uplink scope: ${reason}.`,
	}
}

/** Returns which op field carries a conflicting `id`, or null when none does. */
function conflictingIdentity(op: Operation): 'data' | 'previousData' | null {
	const data = asRecord(op.data)
	if (data && 'id' in data && data.id !== op.recordId) return 'data'
	const previous = asRecord(op.previousData)
	if (previous && 'id' in previous && previous.id !== op.recordId) return 'previousData'
	return null
}

/**
 * Split a collection scope into the equality predicates a store `where` clause can
 * evaluate, and report whether any non-equality predicate (`$in`) remains, which the
 * caller must filter in memory before applying limit/offset.
 *
 * @param collectionScope - The scope for one collection (a `$or` is never pushed down)
 * @returns The equality subset and whether other operators are present
 */
export function splitScopeForQuery(collectionScope: Record<string, unknown>): {
	equality: Record<string, unknown>
	hasNonEquality: boolean
} {
	// A disjunction cannot be pushed into an equality `where`: the caller filters in
	// memory with the full scope.
	if (isScopeDisjunction(collectionScope)) return { equality: {}, hasNonEquality: true }
	const equality: Record<string, unknown> = {}
	let hasNonEquality = false
	for (const [field, expected] of Object.entries(collectionScope)) {
		if (expected !== null && typeof expected === 'object') {
			hasNonEquality = true
		} else {
			equality[field] = expected
		}
	}
	return { equality, hasNonEquality }
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null
	}

	return value as Record<string, unknown>
}

/**
 * Authorization for a write that names a record but carries no field values, such
 * as a Yjs doc-channel update to a richtext field. The record must be inside the
 * writer's scope as stored (with `id` forced to `recordId`); a record that is not
 * stored yet is judged by its id alone, so it only passes id-based or empty scopes.
 *
 * @param collection - The record's collection
 * @param recordId - The record the write targets
 * @param storedRow - The record as stored now (including soft-deleted), or null
 * @param scopes - The writer's uplink scope map, or undefined for no restriction
 * @returns Whether the write is allowed, and why not when it is refused
 */
export function authorizeRecordWrite(
	collection: string,
	recordId: string,
	storedRow: Record<string, unknown> | null | undefined,
	scopes: ScopeMap | undefined,
): UplinkAuthorizationResult {
	if (!scopes) return { allowed: true }
	const image = { ...(storedRow ?? {}), id: recordId }
	if (recordMatchesScopes(collection, image, scopes)) return { allowed: true }
	return {
		allowed: false,
		code: 'SCOPE_VIOLATION',
		message: `Write to "${collection}" record "${recordId}" is outside the accepted uplink scope.`,
	}
}
