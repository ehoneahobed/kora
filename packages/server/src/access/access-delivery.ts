import type { AccessDefinition, Operation } from '@korajs/core'
import { evaluateAccessRule } from '@korajs/core/internal'
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
 *   operation. A late joiner receives the group's current state (scope entries), never
 *   its earlier history; a group the user left contributes nothing.
 * - What the client holds is rebuilt from the intervals at the stream position (the
 *   groups open at that sequence), never trusted from the client, and compared with the
 *   grant in force: the difference is sent as one re-scope unit (entries for records
 *   gained, retractions for records lost) before the stream continues.
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

/**
 * The two grants a re-scope unit moves between: what the client holds and what the
 * rules grant now.
 *
 * - `held` comes from the intervals the client holds, WITHOUT judging expiry: a client
 *   keeps what it was sent until a retraction removes it, so an expired membership is
 *   still held (and gets retracted) until the current grant includes it again.
 * - `current` comes from the live intervals (expiry judged at `now`).
 * - A group held under an interval that is no longer the current one (revoked and
 *   granted again, so its `joinedSeq` changed) counts as not held: the client missed
 *   the edits made between, which the history gate will never send, so it receives the
 *   group's records again as scope entries.
 */
export function rescopeBasis(
	access: AccessDefinition,
	principal: AccessPrincipal,
	held: readonly MembershipInterval[],
	current: readonly MembershipInterval[],
	now: number,
): {
	held: Record<string, Record<string, unknown>>
	current: Record<string, Record<string, unknown>>
} {
	const live = liveIntervals(current, now)
	const identity = (i: MembershipInterval): string =>
		`${i.group}\u0000${i.source}\u0000${i.recordId}\u0000${i.joinedSeq}`
	const liveIds = new Set(live.map(identity))
	const liveGroups = new Set(live.map((i) => i.group))
	const rejoined = new Set(
		held.filter((i) => liveGroups.has(i.group) && !liveIds.has(identity(i))).map((i) => i.group),
	)
	const keptHeld = held.filter((i) => !rejoined.has(i.group))
	return {
		held: accessReadGrant(
			access,
			principal,
			keptHeld.map((i) => ({ ...i, leftSeq: null })),
			Number.NEGATIVE_INFINITY,
		),
		current: accessReadGrant(access, principal, live, now),
	}
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
	const openBySeq = liveIntervals(intervals, now).filter((i) => i.joinedSeq <= seq)
	return evaluateAccessRule(rules.read, values, {
		user: { userId: principal.userId },
		memberships: membershipViewOf(openBySeq, principal.userId, access.roles, now),
		roles: access.roles,
	})
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
