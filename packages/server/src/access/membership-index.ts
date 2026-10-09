import type { AccessDefinition } from '@korajs/core'
import { groupKey } from '@korajs/core/internal'

/**
 * The membership index: who belongs to which group, and from which delivery sequence
 * to which. Every server store keeps it in the same transaction as the operation that
 * changes it, so authorization and delivery read a membership state exactly as current
 * as the log.
 *
 * A row is one membership interval. An interval opens at the delivery sequence of the
 * operation that made the membership hold (`joinedSeq`) and closes at the one that
 * ended it (`leftSeq`); re-joining appends a new interval. The download stream uses the
 * intervals to gate history (a member receives a group's operations from the open
 * interval's `joinedSeq` on, never earlier history).
 *
 * Two sources feed it:
 * - `membership`: live records of the schema's memberships collection
 *   (`{ userId, group, role, expiresAt? }`), written by the server only.
 * - `owner`: the owner of a record in a group collection (`access.groups`) is a member
 *   of that record's group with the configured role for as long as they own it. A
 *   deleted group record keeps its owner's membership, so a restore brings it back.
 *
 * The index is reconciled from state, never from deltas: after each write the store
 * computes which intervals the record should hold now ({@link desiredMemberships}) and
 * closes, updates or opens rows to match ({@link reconcileRecord}). A late or restoring
 * write can therefore never leave a stale interval open.
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

/** A membership a record should hold now. */
export interface DesiredMembership extends MembershipKey {
	readonly role: string
	readonly expiresAt: number | null
}

/** A record of an indexed collection as the store holds it now. */
export interface IndexedRecord {
	readonly collection: string
	readonly recordId: string
	/** Its scalar values (the scope snapshot form), or null when the row does not exist. */
	readonly values: Readonly<Record<string, unknown>> | null
	readonly deleted: boolean
}

/** What to change in the index. */
export interface MembershipIndexChanges {
	/** Open intervals to close. */
	readonly close: readonly MembershipKey[]
	/** Open intervals whose role or expiry changes in place. */
	readonly update: readonly DesiredMembership[]
	/**
	 * Intervals to open. `fromStart` opens at sequence 0 (a membership that predates the
	 * index); otherwise at the sequence the caller applies the changes at.
	 */
	readonly open: readonly (DesiredMembership & { readonly fromStart: boolean })[]
}

/** Server meta key holding the {@link membershipIndexConfig} the index was built for. */
export const MEMBERSHIP_INDEX_FINGERPRINT_KEY = 'access_membership_index'

/** True when the collection feeds the membership index. */
export function feedsMembershipIndex(
	access: AccessDefinition | undefined,
	collection: string,
): boolean {
	if (!access) return false
	return collection === access.memberships || ownGroup(access, collection) !== undefined
}

/**
 * The memberships a record should hold now. A membership record holds one while it is
 * live and complete; a group record holds its owner's while it exists, deleted or not.
 */
export function desiredMemberships(
	access: AccessDefinition | undefined,
	record: IndexedRecord,
): DesiredMembership[] {
	if (!access || record.values === null) return []
	if (record.collection === access.memberships) {
		if (record.deleted) return []
		const membership = readMembership(record.recordId, record.values)
		return membership ? [membership] : []
	}
	const group = ownGroup(access, record.collection)
	if (!group) return []
	const owner = nonEmptyString(record.values[group.owner])
	if (owner === null) return []
	return [
		{
			userId: owner,
			group: groupKey(record.collection, record.recordId),
			source: 'owner',
			recordId: record.recordId,
			role: group.role,
			expiresAt: null,
		},
	]
}

/**
 * The open intervals that belong to a record: its membership row (`membership`
 * source, by record id) or its group's owner (`owner` source, by group key).
 */
export function intervalBelongsTo(
	access: AccessDefinition | undefined,
	interval: MembershipKey,
	collection: string,
	recordId: string,
): boolean {
	if (!access) return false
	if (collection === access.memberships) {
		return interval.source === 'membership' && interval.recordId === recordId
	}
	return interval.source === 'owner' && interval.group === groupKey(collection, recordId)
}

/**
 * Changes that make a record's open intervals match what it should hold now.
 * New intervals open at the caller's sequence (never from the start).
 *
 * @param open - The record's currently open intervals ({@link intervalBelongsTo})
 * @param desired - What it should hold ({@link desiredMemberships})
 */
export function reconcileRecord(
	open: readonly MembershipInterval[],
	desired: readonly DesiredMembership[],
): MembershipIndexChanges {
	const close: MembershipKey[] = []
	const update: DesiredMembership[] = []
	const toOpen: (DesiredMembership & { fromStart: boolean })[] = []
	for (const interval of open) {
		if (!desired.some((want) => sameMembershipKey(want, interval))) close.push(keyOf(interval))
	}
	for (const want of desired) {
		const held = open.find((interval) => sameMembershipKey(interval, want))
		if (!held) toOpen.push({ ...want, fromStart: false })
		else if (held.role !== want.role || held.expiresAt !== want.expiresAt) update.push(want)
	}
	return { close, update, open: toOpen }
}

/** The configuration the index derives from, as stored next to it. */
export interface MembershipIndexConfig {
	readonly memberships: string | null
	readonly groups: Readonly<Record<string, { readonly owner: string; readonly role: string }>>
}

/** The index configuration of an access definition (empty without access). */
export function membershipIndexConfig(access: AccessDefinition | undefined): MembershipIndexConfig {
	if (!access) return { memberships: null, groups: {} }
	const groups: Record<string, { owner: string; role: string }> = {}
	for (const name of Object.keys(access.groups).sort()) {
		const group = ownGroup(access, name)
		if (group) groups[name] = { owner: group.owner, role: group.role }
	}
	return { memberships: access.memberships, groups }
}

/** The stored form of a configuration. */
export function membershipIndexFingerprint(access: AccessDefinition | undefined): string {
	return JSON.stringify({ v: 2, ...membershipIndexConfig(access) })
}

/** Parse a stored fingerprint; null when absent or unreadable (nothing indexed yet). */
export function parseMembershipIndexFingerprint(
	stored: string | null | undefined,
): MembershipIndexConfig | null {
	if (!stored) return null
	try {
		const parsed = JSON.parse(stored) as { v?: unknown } & Partial<MembershipIndexConfig>
		if (parsed.v !== 2) return null
		return { memberships: parsed.memberships ?? null, groups: parsed.groups ?? {} }
	} catch {
		return null
	}
}

/**
 * Changes that make the whole index match the records (startup, a rules deploy, a
 * re-fold, a backup restore). Intervals of records that still hold the same membership
 * keep their `joinedSeq`, so history from joining survives a deploy. A membership of a
 * collection the index did not cover before (`previous`) opens from the start, the
 * backfill semantics; any other missing one opens at the caller's sequence (from now).
 * Open intervals nothing holds any more are closed.
 *
 * @param access - The access definition now in force
 * @param records - Every record of the indexed collections, deleted ones included
 * @param open - Every open interval
 * @param previous - The configuration the index was last built for (null: none)
 */
export function reconcileIndex(
	access: AccessDefinition | undefined,
	records: Iterable<IndexedRecord>,
	open: readonly MembershipInterval[],
	previous: MembershipIndexConfig | null,
): MembershipIndexChanges {
	const current = membershipIndexConfig(access)
	const newlyIndexed = (collection: string): boolean => {
		if (previous === null) return true
		if (collection === current.memberships) return previous.memberships !== collection
		const before = Object.prototype.hasOwnProperty.call(previous.groups, collection)
			? previous.groups[collection]
			: undefined
		const now = current.groups[collection]
		return before === undefined || before.owner !== now?.owner
	}
	const desired: (DesiredMembership & { collection: string })[] = []
	for (const record of records) {
		for (const want of desiredMemberships(access, record)) {
			desired.push({ ...want, collection: record.collection })
		}
	}
	const close: MembershipKey[] = []
	const update: DesiredMembership[] = []
	const toOpen: (DesiredMembership & { fromStart: boolean })[] = []
	for (const interval of open) {
		if (!desired.some((want) => sameMembershipKey(want, interval))) close.push(keyOf(interval))
	}
	for (const { collection, ...want } of desired) {
		const held = open.find((interval) => sameMembershipKey(interval, want))
		if (!held) toOpen.push({ ...want, fromStart: newlyIndexed(collection) })
		else if (held.role !== want.role || held.expiresAt !== want.expiresAt) update.push(want)
	}
	return { close, update, open: toOpen }
}

/**
 * Apply changes to an in-memory interval list (the memory store, and the reference the
 * SQL stores are tested against). Returns a new list.
 *
 * @param intervals - Current intervals
 * @param changes - The changes
 * @param atSeq - The delivery sequence they happen at
 */
export function applyMembershipChanges(
	intervals: readonly MembershipInterval[],
	changes: MembershipIndexChanges,
	atSeq: number,
): MembershipInterval[] {
	const out = intervals.map((interval) => {
		if (interval.leftSeq !== null) return interval
		if (changes.close.some((key) => sameMembershipKey(key, interval))) {
			return { ...interval, leftSeq: atSeq }
		}
		const change = changes.update.find((want) => sameMembershipKey(want, interval))
		return change ? { ...interval, role: change.role, expiresAt: change.expiresAt } : interval
	})
	for (const { fromStart, ...want } of changes.open) {
		out.push({ ...want, joinedSeq: fromStart ? 0 : atSeq, leftSeq: null })
	}
	return out
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

function ownGroup(
	access: AccessDefinition,
	collection: string,
): { readonly owner: string; readonly role: string } | undefined {
	return Object.prototype.hasOwnProperty.call(access.groups, collection)
		? access.groups[collection]
		: undefined
}

/** A membership record's subject and values, or null when it holds no valid membership. */
function readMembership(
	recordId: string,
	row: Readonly<Record<string, unknown>>,
): DesiredMembership | null {
	const userId = nonEmptyString(row.userId)
	const group = nonEmptyString(row.group)
	const role = nonEmptyString(row.role)
	if (userId === null || group === null || role === null) return null
	const expiresAt =
		typeof row.expiresAt === 'number' && Number.isFinite(row.expiresAt) ? row.expiresAt : null
	return { userId, group, source: 'membership', recordId, role, expiresAt }
}

function keyOf(m: MembershipKey): MembershipKey {
	return { userId: m.userId, group: m.group, source: m.source, recordId: m.recordId }
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}
