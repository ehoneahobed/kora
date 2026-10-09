import type { AccessDefinition } from '@korajs/core'
import { groupKey } from '@korajs/core/internal'

/**
 * The membership index: who belongs to which group, and from which delivery sequence
 * to which. Every server store keeps it in the same transaction as the operation
 * that changes it, so authorization and delivery read a membership state that is
 * exactly as current as the log.
 *
 * A row is one membership interval. An interval opens at the delivery sequence of the
 * operation that made the membership live (`joinedSeq`) and closes at the one that
 * ended it (`leftSeq`); re-joining appends a new interval. The download stream uses
 * the intervals to gate history (a member receives a group's operations from the
 * open interval's `joinedSeq` on, never earlier history).
 *
 * Two sources feed it:
 * - `membership`: live records of the schema's memberships collection
 *   (`{ userId, group, role, expiresAt? }`), written by the server only.
 * - `owner`: the owner of a record in a group collection (`access.groups`) is a member
 *   of that record's group with the configured role, for as long as they own it.
 *   Deleting a group record keeps its memberships, so a restore brings the group back.
 */

/** Where an interval comes from. */
export type MembershipSource = 'membership' | 'owner'

/** One membership interval as a store keeps it. */
export interface MembershipInterval {
	readonly userId: string
	/** The group key (`documents:<id>`). */
	readonly group: string
	readonly source: MembershipSource
	/** The membership record's id (`membership`) or the group record's id (`owner`). */
	readonly recordId: string
	readonly role: string
	/** Milliseconds since the epoch, or null when it does not expire. */
	readonly expiresAt: number | null
	/** Delivery sequence of the operation that opened the interval (0: held from the start). */
	readonly joinedSeq: number
	/** Delivery sequence of the operation that closed it, or null while open. */
	readonly leftSeq: number | null
}

/** Identifies an interval's subject: one user in one group from one source and record. */
export interface MembershipKey {
	readonly userId: string
	readonly group: string
	readonly source: MembershipSource
	readonly recordId: string
}

/** Open (or keep open with these values) an interval for `key`. */
export interface EnsureOpenMembership extends MembershipKey {
	readonly role: string
	readonly expiresAt: number | null
}

/** What one applied operation does to the index. */
export interface MembershipIndexEffects {
	/** Intervals to close at the operation's delivery sequence (when open). */
	readonly close: readonly MembershipKey[]
	/**
	 * Intervals to have open: an open interval for the key is updated in place (role,
	 * expiry); otherwise a new one opens at the operation's delivery sequence.
	 */
	readonly ensureOpen: readonly EnsureOpenMembership[]
}

const NO_EFFECTS: MembershipIndexEffects = Object.freeze({
	close: Object.freeze([]),
	ensureOpen: Object.freeze([]),
})

/**
 * The index effects of an operation on `collection`, from the record's live values
 * before and after it (null when it did not exist or is deleted). Pure: each store
 * applies the result inside its write transaction.
 *
 * @param access - The schema's access definition (undefined: no index)
 * @param collection - The operation's collection
 * @param recordId - The operation's record id
 * @param pre - The record's live values before the operation, or null
 * @param post - The record's live values after it, or null
 */
export function membershipIndexEffects(
	access: AccessDefinition | undefined,
	collection: string,
	recordId: string,
	pre: Readonly<Record<string, unknown>> | null,
	post: Readonly<Record<string, unknown>> | null,
): MembershipIndexEffects {
	if (!access) return NO_EFFECTS
	if (collection === access.memberships) {
		return membershipRecordEffects(recordId, pre, post)
	}
	const group = Object.prototype.hasOwnProperty.call(access.groups, collection)
		? access.groups[collection]
		: undefined
	if (group) return ownerEffects(collection, recordId, group, pre, post)
	return NO_EFFECTS
}

function membershipRecordEffects(
	recordId: string,
	pre: Readonly<Record<string, unknown>> | null,
	post: Readonly<Record<string, unknown>> | null,
): MembershipIndexEffects {
	const before = readMembership(recordId, pre)
	const after = readMembership(recordId, post)
	const close: MembershipKey[] = []
	if (before && (!after || !sameSubject(before, after))) close.push(keyOf(before))
	return { close, ensureOpen: after ? [after] : [] }
}

function ownerEffects(
	collection: string,
	recordId: string,
	group: { readonly owner: string; readonly role: string },
	pre: Readonly<Record<string, unknown>> | null,
	post: Readonly<Record<string, unknown>> | null,
): MembershipIndexEffects {
	// A deleted group record keeps its memberships: only a live record changes them.
	if (post === null) return NO_EFFECTS
	const key = groupKey(collection, recordId)
	const owner = nonEmptyString(post[group.owner])
	const previous = pre ? nonEmptyString(pre[group.owner]) : null
	const close: MembershipKey[] =
		previous !== null && previous !== owner
			? [{ userId: previous, group: key, source: 'owner', recordId }]
			: []
	const ensureOpen: EnsureOpenMembership[] =
		owner === null
			? []
			: [
					{
						userId: owner,
						group: key,
						source: 'owner',
						recordId,
						role: group.role,
						expiresAt: null,
					},
				]
	return { close, ensureOpen }
}

/** A membership record's subject and values, or null when it holds no valid membership. */
function readMembership(
	recordId: string,
	row: Readonly<Record<string, unknown>> | null,
): EnsureOpenMembership | null {
	if (row === null) return null
	const userId = nonEmptyString(row.userId)
	const group = nonEmptyString(row.group)
	const role = nonEmptyString(row.role)
	if (userId === null || group === null || role === null) return null
	const expiresAt =
		typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) ? row.expiresAt : null
	return { userId, group, source: 'membership', recordId, role, expiresAt }
}

function sameSubject(a: MembershipKey, b: MembershipKey): boolean {
	return a.userId === b.userId && a.group === b.group
}

function keyOf(m: MembershipKey): MembershipKey {
	return { userId: m.userId, group: m.group, source: m.source, recordId: m.recordId }
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/** True when two keys name the same interval subject. */
export function sameMembershipKey(a: MembershipKey, b: MembershipKey): boolean {
	return (
		a.userId === b.userId &&
		a.group === b.group &&
		a.source === b.source &&
		a.recordId === b.recordId
	)
}

/**
 * Apply effects to an in-memory interval list (the memory store, and the reference
 * the SQL stores are tested against). Returns the new list; the input is not changed.
 *
 * @param intervals - Current intervals
 * @param effects - The operation's effects
 * @param deliverySeq - The operation's delivery sequence
 */
export function applyMembershipEffects(
	intervals: readonly MembershipInterval[],
	effects: MembershipIndexEffects,
	deliverySeq: number,
): MembershipInterval[] {
	let out = [...intervals]
	for (const key of effects.close) {
		out = out.map((interval) =>
			interval.leftSeq === null && sameMembershipKey(interval, key)
				? { ...interval, leftSeq: deliverySeq }
				: interval,
		)
	}
	for (const open of effects.ensureOpen) {
		const at = out.findIndex(
			(interval) => interval.leftSeq === null && sameMembershipKey(interval, open),
		)
		const existing = at >= 0 ? out[at] : undefined
		if (existing) {
			out[at] = { ...existing, role: open.role, expiresAt: open.expiresAt }
		} else {
			out.push({ ...open, joinedSeq: deliverySeq, leftSeq: null })
		}
	}
	return out
}

/**
 * A stable fingerprint of what the index is derived from (memberships collection and
 * group collections). When it changes, a store rebuilds its index from its records.
 */
export function membershipIndexFingerprint(access: AccessDefinition | undefined): string {
	if (!access) return ''
	const groups = Object.keys(access.groups)
		.sort()
		.map((name) => {
			const group = access.groups[name]
			return [name, group?.owner ?? '', group?.role ?? '']
		})
	return JSON.stringify({ v: 1, memberships: access.memberships, groups })
}

/**
 * Intervals for every membership held by the given live records, all open and held
 * from the start (`joinedSeq` 0). Used when a store builds its index from records it
 * already has: memberships that predate the index count as held from the beginning,
 * so existing members keep their full history (the access-rules backfill semantics).
 *
 * @param access - The schema's access definition
 * @param records - Live records (not deleted) with their values
 */
export function membershipIntervalsFromRecords(
	access: AccessDefinition | undefined,
	records: Iterable<{
		readonly collection: string
		readonly recordId: string
		readonly values: Readonly<Record<string, unknown>>
	}>,
): MembershipInterval[] {
	let intervals: MembershipInterval[] = []
	for (const record of records) {
		const effects = membershipIndexEffects(
			access,
			record.collection,
			record.recordId,
			null,
			record.values,
		)
		intervals = applyMembershipEffects(intervals, effects, 0)
	}
	return intervals
}

/** True when the collection feeds the membership index. */
export function feedsMembershipIndex(
	access: AccessDefinition | undefined,
	collection: string,
): boolean {
	if (!access) return false
	return (
		collection === access.memberships ||
		Object.prototype.hasOwnProperty.call(access.groups, collection)
	)
}

/** Server meta key holding {@link membershipIndexFingerprint} of the built index. */
export const MEMBERSHIP_INDEX_FINGERPRINT_KEY = 'access_membership_index'
