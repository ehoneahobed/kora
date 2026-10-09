import { defineSchema, memberOfKey, owner, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	type IndexedRecord,
	type MembershipInterval,
	applyMembershipChanges,
	desiredMemberships,
	feedsMembershipIndex,
	intervalBelongsTo,
	membershipIndexConfig,
	membershipIndexFingerprint,
	parseMembershipIndexFingerprint,
	reconcileIndex,
	reconcileRecord,
} from './membership-index'

const access = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'manage'],
		groups: { docs: { owner: 'by', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		docs: { fields: { by: t.string().stamp('userId') }, access: { read: owner('by') } },
		other: { fields: { x: t.string() } },
	},
}).access

/** Apply one write's reconciliation to `intervals` at `seq`. */
function write(
	intervals: MembershipInterval[],
	record: IndexedRecord,
	seq: number,
): MembershipInterval[] {
	const open = intervals.filter(
		(i) => i.leftSeq === null && intervalBelongsTo(access, i, record.collection, record.recordId),
	)
	return applyMembershipChanges(
		intervals,
		reconcileRecord(open, desiredMemberships(access, record)),
		seq,
	)
}

const doc = (by: string | null, deleted = false): IndexedRecord => ({
	collection: 'docs',
	recordId: '1',
	values: by === null ? {} : { by },
	deleted,
})

describe('per-write reconciliation', () => {
	test('moving a membership to another user closes the old interval and opens a new one', () => {
		let intervals = write(
			[],
			{
				collection: 'members',
				recordId: 'm1',
				values: { userId: 'a', group: 'docs:1', role: 'view' },
				deleted: false,
			},
			3,
		)
		intervals = write(
			intervals,
			{
				collection: 'members',
				recordId: 'm1',
				values: { userId: 'b', group: 'docs:1', role: 'view' },
				deleted: false,
			},
			4,
		)
		expect(intervals.map((i) => [i.userId, i.joinedSeq, i.leftSeq])).toEqual([
			['a', 3, 4],
			['b', 4, null],
		])
	})

	test('an incomplete or deleted membership row holds nothing', () => {
		expect(
			desiredMemberships(access, {
				collection: 'members',
				recordId: 'm',
				values: { userId: 'a', group: '', role: 'view' },
				deleted: false,
			}),
		).toEqual([])
		expect(
			desiredMemberships(access, {
				collection: 'members',
				recordId: 'm',
				values: { userId: 'a', group: 'docs:1', role: 'view' },
				deleted: true,
			}),
		).toEqual([])
	})

	test('a present but malformed expiry holds nothing (fail closed)', () => {
		for (const expiresAt of ['99999', Number.NaN, {}]) {
			expect(
				desiredMemberships(access, {
					collection: 'members',
					recordId: 'm',
					values: { userId: 'a', group: 'docs:1', role: 'view', expiresAt },
					deleted: false,
				}),
			).toEqual([])
		}
	})

	test('collections outside the index hold nothing', () => {
		expect(feedsMembershipIndex(access, 'other')).toBe(false)
		expect(
			desiredMemberships(access, {
				collection: 'other',
				recordId: 'x',
				values: {},
				deleted: false,
			}),
		).toEqual([])
	})

	test('a deleted group keeps its owner; restoring it under a new owner moves the membership', () => {
		let intervals = write([], doc('ann'), 5)
		intervals = write(intervals, doc('ann', true), 6)
		expect(intervals.map((i) => [i.userId, i.leftSeq])).toEqual([['ann', null]])
		// Restored by a write that also changes the owner: ann leaves, bob joins.
		intervals = write(intervals, doc('bob'), 7)
		expect(intervals.map((i) => [i.userId, i.joinedSeq, i.leftSeq])).toEqual([
			['ann', 5, 7],
			['bob', 7, null],
		])
	})

	test('an owner change while the group is deleted moves the membership at once', () => {
		let intervals = write([], doc('ann'), 5)
		intervals = write(intervals, doc('ann', true), 6)
		intervals = write(intervals, doc('bob', true), 7)
		intervals = write(intervals, doc('bob'), 8)
		expect(intervals.map((i) => [i.userId, i.joinedSeq, i.leftSeq])).toEqual([
			['ann', 5, 7],
			['bob', 7, null],
		])
	})
})

describe('whole-index reconciliation', () => {
	const records: IndexedRecord[] = [
		{
			collection: 'members',
			recordId: 'm1',
			values: { userId: 'a', group: 'docs:9', role: 'view' },
			deleted: false,
		},
		{ collection: 'docs', recordId: '2', values: { by: 'b' }, deleted: true },
	]

	test('a first build holds every membership from the start, deleted groups included', () => {
		const intervals = applyMembershipChanges([], reconcileIndex(access, records, [], null), 50)
		expect(intervals.map((i) => [i.userId, i.group, i.joinedSeq])).toEqual([
			['a', 'docs:9', 0],
			['b', 'docs:2', 0],
		])
	})

	test('a later reconcile keeps joinedSeq; new rows of indexed collections start now', () => {
		const held: MembershipInterval[] = [
			{
				userId: 'a',
				group: 'docs:9',
				source: 'membership',
				recordId: 'm1',
				role: 'view',
				expiresAt: null,
				joinedSeq: 12,
				leftSeq: null,
			},
		]
		const changes = reconcileIndex(access, records, held, membershipIndexConfig(access))
		const intervals = applyMembershipChanges(held, changes, 50)
		expect(intervals.map((i) => [i.userId, i.joinedSeq, i.leftSeq])).toEqual([
			['a', 12, null],
			['b', 50, null],
		])
	})

	test('a group collection the index did not cover opens from the start', () => {
		const previous = { memberships: 'members', groups: {} }
		const intervals = applyMembershipChanges([], reconcileIndex(access, records, [], previous), 50)
		expect(intervals.find((i) => i.userId === 'b')?.joinedSeq).toBe(0)
		expect(intervals.find((i) => i.userId === 'a')?.joinedSeq).toBe(50)
	})

	test('an interval held under another configuration is reopened from the start', () => {
		const held: MembershipInterval[] = [
			{
				userId: 'b',
				group: 'docs:2',
				source: 'owner',
				recordId: '2',
				role: 'manage',
				expiresAt: null,
				joinedSeq: 30,
				leftSeq: null,
			},
		]
		// The owner field changed (a new configuration), and it still resolves to 'b'.
		const previous = {
			memberships: 'members',
			groups: { docs: { owner: 'creator', role: 'manage' } },
		}
		const intervals = applyMembershipChanges(
			held,
			reconcileIndex(access, records, held, previous),
			50,
		)
		expect(intervals.filter((i) => i.userId === 'b').map((i) => [i.joinedSeq, i.leftSeq])).toEqual([
			[30, 50],
			[0, null],
		])
	})

	test('access removed: every open interval closes', () => {
		const held = applyMembershipChanges([], reconcileIndex(access, records, [], null), 1)
		const closed = applyMembershipChanges(held, reconcileIndex(undefined, [], held, null), 60)
		expect(closed.every((i) => i.leftSeq === 60)).toBe(true)
	})

	test('the fingerprint round-trips; old or unreadable ones read as nothing indexed', () => {
		expect(parseMembershipIndexFingerprint(membershipIndexFingerprint(access))).toEqual(
			membershipIndexConfig(access),
		)
		expect(parseMembershipIndexFingerprint('not json')).toBeNull()
		expect(parseMembershipIndexFingerprint('{"v":1}')).toBeNull()
		expect(parseMembershipIndexFingerprint(undefined)).toBeNull()
	})
})
