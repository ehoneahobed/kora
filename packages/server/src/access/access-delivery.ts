import type { AccessDefinition, Operation } from '@korajs/core'
import { evaluateAccessRule, parseGroupKey } from '@korajs/core/internal'
import type { OperationScopeSnapshot } from '../store/server-store'
import { type AccessPrincipal, accessReadGrant, membershipViewOf } from './access-authorizer'
import type { MembershipInterval } from './membership-index'

/**
 * How access rules shape a session's download stream (beta.15 access step 5).
 *
 * Two clocks: authorization reads the memberships at decision time, while the download
 * stream changes what it sends at the delivery sequence of the membership change.
 *
 * - History is gated by the open membership interval: an operation of a group is sent
 *   only when the user's currently open interval for that group began at or before the
 *   operation (any operation for a group collection declared `history: 'full'`). A late joiner receives the group's current state (scope entries), never
 *   its earlier history; a group the user left contributes nothing.
 * - What the client holds is rebuilt from the intervals at the stream position (the
 *   groups open at that sequence), never trusted from the client, and compared with the
 *   grant in force: the difference is sent as one re-scope unit (a narrowing the client
 *   applies to its own records, then entries for records gained) that starts a batch.
 */

/** The intervals as they stood at delivery sequence `seq` (open at it). */
export function intervalsAsOf(
	intervals: readonly MembershipInterval[],
	seq: number,
): MembershipInterval[] {
	return intervals
		.filter((i) => i.joinedSeq <= seq && (i.leftSeq === null || i.leftSeq > seq))
		.map((i) => ({ ...i, leftSeq: null }))
}

/** The open intervals live at `now` (an expired, not yet swept membership is not). */
export function liveIntervals(
	intervals: readonly MembershipInterval[],
	now: number,
): MembershipInterval[] {
	return intervals.filter((i) => i.leftSeq === null && (i.expiresAt === null || i.expiresAt > now))
}

/** What a re-scope unit is built from (see {@link rescopeBasis}). */
export interface RescopeBasis {
	/** The grant the client certainly holds the full history of (entries skip it). */
	held: Record<string, Record<string, unknown>>
	/** The grant in force now. Entries carry the records in it and not in `held`. */
	current: Record<string, Record<string, unknown>>
	/**
	 * Per access collection, the grant the client must narrow its local records to
	 * before the entries (null: drop the collection), judged by the client on its own
	 * values. Null when the client cannot hold anything outside the current grant.
	 */
	narrowing: Record<string, Record<string, unknown> | null> | null
}

/**
 * The basis of a re-scope unit, which moves a client from what it holds to what the
 * rules grant now.
 *
 * - What the client holds comes from the intervals it holds, WITHOUT judging expiry: a
 *   client keeps what it was sent until it is removed, so an expired membership is still
 *   held until the current grant includes it again.
 * - `current` comes from the live intervals (expiry judged at `now`).
 * - A group held under an interval that is no longer the current one (revoked and
 *   granted again, so its `joinedSeq` changed) is "rejoined": the client missed what
 *   happened between (edits, deletes, records moved away), which the history gate will
 *   never send. The narrowing drops the group's records and the entries send them again.
 * - When `held` was rebuilt for an earlier sequence (`asOfSeq`), a membership whose role
 *   or expiry changed in place after it carries a role the client may not have had then:
 *   the narrowing always runs, and the group's records are sent again as entries.
 *
 * Retractions are not computed on the server: records that left the grant while the
 * client was away may have moved or been deleted since, so only the client's own values
 * tell what it holds. The narrowing removes them.
 *
 * @param asOfSeq - The delivery sequence `held` was rebuilt for, or null when it is
 *   exactly what the stream last sent (the intervals after a previous unit)
 * @param rulesChanged - The read rules changed since `asOfSeq` (a deploy): narrow every
 *   access collection and re-send everything the current grant admits
 */
export function rescopeBasis(
	access: AccessDefinition,
	principal: AccessPrincipal,
	held: readonly MembershipInterval[],
	current: readonly MembershipInterval[],
	now: number,
	asOfSeq: number | null,
	rulesChanged = false,
): RescopeBasis {
	const live = liveIntervals(current, now)
	const identity = (i: MembershipInterval): string =>
		`${i.group}\u0000${i.source}\u0000${i.recordId}\u0000${i.joinedSeq}`
	const liveIds = new Set(live.map(identity))
	const liveGroups = new Set(live.map((i) => i.group))
	const rejoined = new Set(
		held.filter((i) => liveGroups.has(i.group) && !liveIds.has(identity(i))).map((i) => i.group),
	)
	// Live or not: a membership downgraded and then removed (or expired) since `asOfSeq`
	// is rebuilt with its last role, which may read less than the client was sent.
	const uncertain = new Set(
		asOfSeq === null ? [] : held.filter((i) => i.roleSeq > asOfSeq).map((i) => i.group),
	)
	const asHeld = (intervals: readonly MembershipInterval[]) =>
		accessReadGrant(
			access,
			principal,
			intervals.map((i) => ({ ...i, leftSeq: null })),
			Number.NEGATIVE_INFINITY,
		)
	const rawHeld = asHeld(held)
	const currentGrant = accessReadGrant(access, principal, live, now)
	const narrowTo = accessReadGrant(
		access,
		principal,
		live.filter((i) => !rejoined.has(i.group)),
		now,
	)
	const narrowing: Record<string, Record<string, unknown> | null> = {}
	let narrows = false
	for (const collection of Object.keys(access.collections)) {
		const before = own(rawHeld, collection)
		const after = own(narrowTo, collection)
		if (
			rulesChanged ||
			uncertain.size > 0 ||
			!sameGrant({ g: before ?? null }, { g: after ?? null })
		) {
			narrowing[collection] = after ?? null
			narrows = true
		}
	}
	return {
		// Read rules deployed since the base: nothing held is known to be complete under
		// them (a loosened rule admits records the client never received).
		held: rulesChanged
			? {}
			: asHeld(held.filter((i) => !rejoined.has(i.group) && !uncertain.has(i.group))),
		current: currentGrant,
		narrowing: narrows ? narrowing : null,
	}
}

function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * True when an operation of an access collection, at delivery sequence `seq`, may be
 * sent: its record (as of the operation) is readable through memberships whose
 * currently open interval began at or before `seq`. Rules that do not involve
 * memberships (owner, where, anyone) are unaffected. A user's own membership rows are
 * always sent.
 *
 * @param values - The record's values as of the operation (scope snapshot, with the
 *   current row filling fields the snapshot lacks)
 */
export function historyAllows(
	access: AccessDefinition,
	collection: string,
	values: Readonly<Record<string, unknown>>,
	principal: AccessPrincipal,
	intervals: readonly MembershipInterval[],
	seq: number,
	now: number,
): boolean {
	const rules = Object.prototype.hasOwnProperty.call(access.collections, collection)
		? access.collections[collection]
		: undefined
	if (!rules) return true
	if (
		collection === access.memberships &&
		principal.userId !== null &&
		values.userId === principal.userId
	) {
		return true
	}
	const openBySeq = liveIntervals(intervals, now).filter(
		(i) => i.joinedSeq <= seq || groupHasFullHistory(access, i.group),
	)
	return evaluateAccessRule(rules.read, values, {
		user: { userId: principal.userId },
		memberships: membershipViewOf(openBySeq, principal.userId, access.roles, now),
		roles: access.roles,
	})
}

/**
 * True when the group belongs to a group collection declared `history: 'full'`: its
 * members receive operations written before they joined.
 */
export function groupHasFullHistory(access: AccessDefinition, group: string): boolean {
	const parsed = parseGroupKey(group)
	if (!parsed) return false
	const config = Object.prototype.hasOwnProperty.call(access.groups, parsed.collection)
		? access.groups[parsed.collection]
		: undefined
	return config?.history === 'full'
}

/**
 * True when an operation changes the user's memberships: a row of the memberships
 * collection naming them, or a group record whose owner was or becomes them. Judged on
 * the store's scope snapshot (never the writer's claims).
 */
export function operationTouchesMemberships(
	access: AccessDefinition,
	op: Operation,
	snapshot: OperationScopeSnapshot | null,
	userId: string | null,
): boolean {
	if (userId === null) return false
	const sides = [snapshot?.pre ?? null, snapshot?.post ?? null]
	if (op.collection === access.memberships) {
		return sides.some((side) => side?.userId === userId)
	}
	const group = Object.prototype.hasOwnProperty.call(access.groups, op.collection)
		? access.groups[op.collection]
		: undefined
	if (!group) return false
	return sides.some((side) => side?.[group.owner] === userId)
}

/** True when two compiled grants admit the same records (canonical comparison). */
export function sameGrant(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): boolean {
	return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}
