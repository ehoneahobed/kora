import type { AccessDefinition, MembershipView, Operation } from '@korajs/core'
import { applyAtomicOp } from '@korajs/core'
import {
	type MembershipRecord,
	authorizeAccessWrite,
	canonicalize,
	compileAccessGrant,
	createMembershipView,
	evaluateAccessRule,
} from '@korajs/core/internal'
import { SyncEncryptor } from '@korajs/sync'
import type { UplinkAuthorizationResult } from '../scopes/server-scope-filter'
import type { ResultingRecord } from '../store/server-store'
import {
	type IndexedMembershipInterval,
	type MembershipInterval,
	isIndexedInterval,
} from './membership-index'

/**
 * Server-side enforcement of a schema's access rules: the write decision for an
 * uploaded operation, and the read grant a session's download stream uses.
 *
 * Every decision reads the writer's memberships as the store holds them at decision
 * time (inside the write's critical section for uploads), never a cached grant.
 */

/** The user an access decision is made for. */
export interface AccessPrincipal {
	/** Null for an anonymous session (only `anyone()` rules admit it). */
	readonly userId: string | null
}

/**
 * The holder of an anonymous session's capability grants in membership intervals (no
 * stored user id can equal it: identifiers never hold a NUL character).
 */
export const ANONYMOUS_GRANT_HOLDER = '\u0000anonymous'

/**
 * The live memberships among a user's intervals at `now`: open intervals whose expiry,
 * if any, is still ahead. Memberships the sweeper has not closed yet but whose expiry
 * passed grant nothing. Capability grants (`source: 'grant'`) are marked as such, so
 * rules declared `{ grants: false }` ignore them.
 */
export function membershipViewOf(
	intervals: readonly MembershipInterval[],
	userId: string | null,
	roles: readonly string[],
	now: number,
): MembershipView {
	// An anonymous principal holds only the capability grants of its session.
	const holder = userId ?? ANONYMOUS_GRANT_HOLDER
	const rows: MembershipRecord[] = intervals
		.filter((interval) => interval.leftSeq === null && interval.userId === holder)
		.map((interval) => ({
			userId: interval.userId,
			group: interval.group,
			role: interval.role,
			expiresAt: interval.expiresAt,
			// Owner and memberships-collection intervals are real memberships; anything else
			// (a capability grant) satisfies only rules that admit grants (fail closed).
			viaGrant: !isIndexedInterval(interval),
		}))
	return createMembershipView(rows, holder, roles, now)
}

/** A user's effective role in one group (see {@link effectiveGroupRole}). */
export interface GroupRole {
	/** The highest role the user holds in the group. */
	readonly role: string
	/** Whether it comes from a memberships-collection row or the group record's owner field. */
	readonly source: 'membership' | 'owner'
	/**
	 * Delivery sequence of the last change to that role (granted, changed, or the
	 * membership ended and was granted again). Equal values at two points in time mean
	 * the role held throughout within one membership index generation; record `proof`,
	 * not `since`, to check it later (a replace-mode restore or a newly indexed collection
	 * opens intervals at sequence 0 again).
	 */
	readonly since: number
	/**
	 * Proof that the role held: equal values at two points in time mean the role held
	 * throughout. `since` and source, bound to the index generation once one exists, so a
	 * proof recorded before an index rebuild (a replace-mode restore, a newly indexed
	 * collection) never matches after it.
	 */
	readonly proof: string
}

/**
 * The highest live role `userId` holds in `group` at `now`: open intervals whose
 * expiry, if any, is still ahead, ranked by `roles` (lowest first). Null when none.
 *
 * @param intervals - The user's membership intervals (the store's index)
 * @param userId - The user
 * @param group - The group key (`forms:<id>`)
 * @param roles - The schema's ordered roles
 * @param now - Server time
 * @param generation - The membership index generation (null before any restore)
 */
export function effectiveGroupRole(
	intervals: readonly MembershipInterval[],
	userId: string,
	group: string,
	roles: readonly string[],
	now: number,
	generation: string | null = null,
): GroupRole | null {
	let best: IndexedMembershipInterval | null = null
	for (const interval of intervals) {
		// A role is a membership of the store: a session's capability grant is none.
		if (!isIndexedInterval(interval)) continue
		if (interval.userId !== userId || interval.group !== group || interval.leftSeq !== null)
			continue
		if (interval.expiresAt !== null && interval.expiresAt <= now) continue
		const rank = roles.indexOf(interval.role)
		if (rank < 0) continue
		const bestRank = best === null ? -1 : roles.indexOf(best.role)
		// Among equal roles the owner field first (it is what makes someone the owner; a
		// membership row of the same role must not hide it), then the oldest grant, so
		// `since` does not depend on row order and stays put when a later duplicate closes.
		const ownerFirst =
			best !== null && interval.source !== best.source ? (interval.source === 'owner' ? -1 : 1) : 0
		if (
			best === null ||
			rank > bestRank ||
			(rank === bestRank &&
				(ownerFirst < 0 || (ownerFirst === 0 && interval.roleSeq < best.roleSeq)))
		) {
			best = interval
		}
	}
	if (!best) return null
	const proof = `${best.source}:${best.roleSeq}`
	return {
		role: best.role,
		source: best.source,
		since: best.roleSeq,
		proof: generation ? `${proof}@${generation}` : proof,
	}
}

/** Fields of a stored or uploaded row without Kora's internal columns. */
function recordFields(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(row)) {
		if (!key.startsWith('_')) out[key] = value
	}
	return out
}

/**
 * Most atomic intents one operation may carry in an access-ruled collection when the
 * store cannot hand the authorizer the record the write leaves (a custom store without
 * `previewResult`, and the session's early pre-check): every combination of their
 * outcomes is judged, 2^n rows. The built-in stores judge the exact resulting record
 * and have no such limit.
 */
export const MAX_JUDGED_ATOMIC_FIELDS = 4

/**
 * Every row a write may leave when the resulting record is not known. Per field, the
 * fold stores the written value (`data[field]`) unless that field's chain composes
 * (its previous write is an atomic op of the same type), when it stores the intent
 * applied to the running value. Which one is decided per field, from that field's
 * history, so every combination is judged: the rules must hold whichever the fold
 * picks for each field.
 *
 * An insert of a new record has no history: the fold stores `data`, the only row.
 * Returns a refusal when an intent has no result (an unknown type, or one that throws:
 * never judged as if the field were unset) or when there are more intents than
 * {@link MAX_JUDGED_ATOMIC_FIELDS}.
 */
function candidateRows(
	next: Record<string, unknown>,
	stored: Readonly<Record<string, unknown>> | null,
	op: Operation,
): Record<string, unknown>[] | { refused: string } {
	const intents = Object.entries(op.atomicOps ?? {})
	if (intents.length === 0 || stored === null) return [next]
	if (intents.length > MAX_JUDGED_ATOMIC_FIELDS) {
		return {
			refused: `Operation "${op.id}" carries ${String(intents.length)} atomic intents; at most ${String(MAX_JUDGED_ATOMIC_FIELDS)} can be judged against the access rules of "${op.collection}" by this store. Split the update.`,
		}
	}
	const composed: Array<[string, unknown]> = []
	for (const [field, intent] of intents) {
		let value: unknown
		try {
			value = applyAtomicOp(stored[field], intent)
		} catch {
			value = undefined
		}
		if (value === undefined) {
			return {
				refused: `Operation "${op.id}" carries an atomic intent with no result for "${field}" (unknown type or invalid operand).`,
			}
		}
		composed.push([field, value])
	}
	const rows: Record<string, unknown>[] = []
	for (let mask = 0; mask < 1 << composed.length; mask++) {
		const row = { ...next }
		composed.forEach(([field, value], index) => {
			if (mask & (1 << index)) row[field] = value
		})
		rows.push(row)
	}
	return rows
}

/**
 * Fields the fold writes for an update (or an insert onto a stored record), as the
 * fold's own rule decides: set in `data`, and, without an atomic intent, different
 * from the operation's own `previousData` (an unchanged restatement writes nothing).
 * Judged as changed whatever the resulting record shows, so a write that loses to a
 * newer one now still needs the rule for the fields it writes.
 */
function writtenFields(op: Operation): string[] {
	const data = asRecord(op.data)
	if (data === null) return []
	const previous = asRecord(op.previousData)
	const out: string[] = []
	for (const [field, value] of Object.entries(data)) {
		if (value === undefined) continue
		if (op.atomicOps?.[field] !== undefined) {
			out.push(field)
			continue
		}
		if (
			op.type !== 'insert' &&
			previous !== null &&
			field in previous &&
			previous[field] !== undefined &&
			sameCanonical(previous[field], value)
		) {
			continue
		}
		out.push(field)
	}
	return out
}

function sameCanonical(a: unknown, b: unknown): boolean {
	try {
		return canonicalize(a) === canonicalize(b)
	} catch {
		return false
	}
}

/**
 * A protocol-1 encrypted payload (`data` sealed in place). Kept local: the server only
 * needs to recognize the marker, never to decrypt.
 */
function isEncryptedPayload(value: unknown): boolean {
	return SyncEncryptor.isEncryptedPayload(asRecord(value))
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/**
 * Decide an uploaded operation under the schema's access rules. Collections without
 * rules are not judged here (`allowed`; their provider grant applies as before).
 *
 * Beyond the rules themselves:
 * - `GROUP_EXISTS`: a client insert into a group collection onto a record id that
 *   exists, live or deleted, is refused (an insert with another group's id would make
 *   the writer its owner). The operation-id duplicate check runs before this, so an
 *   idempotent resend of the same insert is acknowledged, not refused.
 * - `STAMP_REQUIRED`: the server never rewrites an operation (operations are
 *   content-addressed), so an insert must carry its stamped fields, set to the writer.
 *
 * @param access - The schema's access definition
 * @param op - The operation as the server schema reads it
 * @param stored - The record as stored now (a deleted one included), or null
 * @param principal - The writer
 * @param intervals - The writer's membership intervals, read at decision time
 * @param now - Server time, for membership expiry
 * @param resulting - The record exactly as the fold stores it after this write, from the
 *   store's critical section (`previewResult`); without it every row the fold may leave
 *   is judged, for at most {@link MAX_JUDGED_ATOMIC_FIELDS} atomic intents
 */
export function authorizeAccessOperation(
	access: AccessDefinition,
	op: Operation,
	stored: Readonly<Record<string, unknown>> | null,
	principal: AccessPrincipal,
	intervals: readonly MembershipInterval[],
	now: number,
	resulting?: ResultingRecord | null,
): UplinkAuthorizationResult {
	const rules = Object.prototype.hasOwnProperty.call(access.collections, op.collection)
		? access.collections[op.collection]
		: undefined
	if (!rules) return { allowed: true }
	const storedFields = stored ? { ...recordFields(stored), id: op.recordId } : null
	const storedDeleted = stored !== null && Number(stored._deleted) === 1

	// The server cannot read an encrypted operation's fields, so it cannot judge it
	// against the rules: refused in access collections rather than accepted blind.
	if (
		op.encrypted !== undefined ||
		isEncryptedPayload(op.data) ||
		isEncryptedPayload(op.previousData)
	) {
		return {
			allowed: false,
			code: 'ACCESS_DENIED',
			message: `"${op.collection}" has access rules, which the server cannot apply to an end-to-end encrypted operation. Leave this collection out of end-to-end encryption.`,
		}
	}

	// An update or delete of a record the server does not hold would be judged against
	// nothing (and could pre-plant fields a later insert inherits): refused.
	if (op.type !== 'insert' && storedFields === null) {
		return {
			allowed: false,
			code: 'ACCESS_DENIED',
			message: `"${op.collection}" record "${op.recordId}" does not exist on the server; it cannot be changed before it is created.`,
		}
	}

	const isGroup = Object.prototype.hasOwnProperty.call(access.groups, op.collection)
	if (
		op.type === 'insert' &&
		isGroup &&
		storedFields !== null &&
		op.collection !== access.memberships
	) {
		return {
			allowed: false,
			code: 'GROUP_EXISTS',
			message: `"${op.collection}" record "${op.recordId}" already exists; a group cannot be created over an existing id.`,
		}
	}

	const data = asRecord(op.data) ?? {}
	if (op.type === 'insert' && storedFields === null) {
		for (const field of rules.stampedFields) {
			const value = data[field]
			if (value === undefined || value === null) {
				return {
					allowed: false,
					code: 'STAMP_REQUIRED',
					message: `"${op.collection}.${field}" is stamped with the writing user and must be set on insert.`,
				}
			}
		}
	}

	const base =
		op.type === 'delete'
			? null
			: op.type === 'insert' && storedFields === null
				? { ...data, id: op.recordId }
				: { ...(storedFields ?? {}), ...data, id: op.recordId }
	// Rules judge exactly what the fold stores: the store's resulting record when it
	// computed one (inside the write's critical section), else every row the fold may
	// leave (see candidateRows). Never a value derived some other way, which a write
	// could make differ from what it stores.
	let rows: Array<Record<string, unknown> | null>
	if (base === null) {
		rows = [null]
	} else if (resulting) {
		rows = [{ ...recordFields(resulting.values), id: op.recordId }]
	} else {
		const candidates = candidateRows(base, storedFields, op)
		if (!Array.isArray(candidates)) {
			return { allowed: false, code: 'INVALID_ATOMIC_OP', message: candidates.refused }
		}
		rows = candidates
	}
	// An insert of a new record keeps its default shortcut for fields without an intent;
	// any other write counts every field it writes as changed (see writtenFields).
	const touchedFields =
		op.type === 'insert' && storedFields === null
			? Object.keys(op.atomicOps ?? {})
			: writtenFields(op)
	const ctx = {
		user: { userId: principal.userId },
		memberships: membershipViewOf(intervals, principal.userId, access.roles, now),
	}
	for (const next of rows) {
		const decision = authorizeAccessWrite(
			access,
			{
				collection: op.collection,
				type: op.type,
				stored: storedFields,
				next,
				touchedFields,
				storedDeleted,
			},
			ctx,
		)
		if (!decision.allowed) {
			return { allowed: false, code: decision.code, message: decision.message }
		}
	}
	return { allowed: true }
}

/**
 * The read grant of a principal over the schema's access collections, as scope
 * predicates (collections it may not read are absent). A user's own rows of the
 * memberships collection are always readable, so a device learns it was removed.
 *
 * @param access - The schema's access definition
 * @param principal - The reader
 * @param intervals - The reader's membership intervals
 * @param now - Server time, for membership expiry
 */
export function accessReadGrant(
	access: AccessDefinition,
	principal: AccessPrincipal,
	intervals: readonly MembershipInterval[],
	now: number,
): Record<string, Record<string, unknown>> {
	const grant = compileAccessGrant(access, {
		user: { userId: principal.userId },
		memberships: membershipViewOf(intervals, principal.userId, access.roles, now),
	}) as Record<string, Record<string, unknown>>
	const memberships = access.memberships
	if (memberships !== null && principal.userId !== null) {
		const own = { userId: principal.userId }
		const existing = Object.prototype.hasOwnProperty.call(grant, memberships)
			? grant[memberships]
			: undefined
		if (existing === undefined) grant[memberships] = own
		else if (Object.keys(existing).length > 0) {
			const branches = Array.isArray((existing as { $or?: unknown }).$or)
				? (existing as { $or: Record<string, unknown>[] }).$or
				: [existing]
			grant[memberships] = { $or: [...branches, own] }
		}
	}
	return grant
}

/**
 * Decide a change to one field of a stored record that does not travel as an operation
 * (a collaborative rich-text update): the collection's `update` rule on the stored row,
 * and the field's own `update` rule when it has one. Collections without rules are not
 * judged here.
 */
export function authorizeAccessFieldUpdate(
	access: AccessDefinition,
	collection: string,
	recordId: string,
	field: string,
	stored: Readonly<Record<string, unknown>> | null,
	principal: AccessPrincipal,
	intervals: readonly MembershipInterval[],
	now: number,
): UplinkAuthorizationResult {
	const rules = Object.prototype.hasOwnProperty.call(access.collections, collection)
		? access.collections[collection]
		: undefined
	if (!rules) return { allowed: true }
	if (collection === access.memberships || stored === null || Number(stored._deleted) === 1) {
		return {
			allowed: false,
			code: 'ACCESS_DENIED',
			message: `Not allowed to change "${collection}.${field}".`,
		}
	}
	const row = { ...recordFields(stored), id: recordId }
	const ctx = {
		user: { userId: principal.userId },
		memberships: membershipViewOf(intervals, principal.userId, access.roles, now),
		roles: access.roles,
	}
	const fieldRule = Object.prototype.hasOwnProperty.call(rules.fields, field)
		? rules.fields[field]
		: undefined
	const allowed = fieldRule
		? evaluateAccessRule(fieldRule.update, row, ctx)
		: evaluateAccessRule(rules.update, row, ctx)
	return allowed
		? { allowed: true }
		: {
				allowed: false,
				code: 'ACCESS_DENIED',
				message: `Not allowed to change "${collection}.${field}".`,
			}
}
