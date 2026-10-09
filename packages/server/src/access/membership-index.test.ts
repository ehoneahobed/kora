import { defineSchema, memberOfKey, owner, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	applyMembershipEffects,
	feedsMembershipIndex,
	membershipIndexEffects,
	membershipIndexFingerprint,
	membershipIntervalsFromRecords,
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

describe('membershipIndexEffects', () => {
	test('moving a membership to another user closes the old interval and opens a new one', () => {
		const effects = membershipIndexEffects(
			access,
			'members',
			'm1',
			{ userId: 'a', group: 'docs:1', role: 'view' },
			{ userId: 'b', group: 'docs:1', role: 'view' },
		)
		expect(effects.close).toEqual([
			{ userId: 'a', group: 'docs:1', source: 'membership', recordId: 'm1' },
		])
		expect(effects.ensureOpen.map((e) => e.userId)).toEqual(['b'])
	})

	test('an incomplete membership row holds nothing', () => {
		const effects = membershipIndexEffects(access, 'members', 'm1', null, {
			userId: 'a',
			group: '',
			role: 'view',
		})
		expect(effects).toEqual({ close: [], ensureOpen: [] })
	})

	test('collections outside the index have no effects', () => {
		expect(feedsMembershipIndex(access, 'other')).toBe(false)
		expect(membershipIndexEffects(access, 'other', 'x', null, { x: 'y' })).toEqual({
			close: [],
			ensureOpen: [],
		})
		expect(membershipIndexEffects(undefined, 'members', 'm', null, { userId: 'a' })).toEqual({
			close: [],
			ensureOpen: [],
		})
	})

	test('restoring a deleted group record keeps one open owner interval', () => {
		let intervals = applyMembershipEffects(
			[],
			membershipIndexEffects(access, 'docs', '1', null, { by: 'a' }),
			5,
		)
		// Deleted (post null): nothing changes.
		intervals = applyMembershipEffects(
			intervals,
			membershipIndexEffects(access, 'docs', '1', { by: 'a' }, null),
			6,
		)
		// Restored (pre null because it was deleted): still one interval from 5.
		intervals = applyMembershipEffects(
			intervals,
			membershipIndexEffects(access, 'docs', '1', null, { by: 'a' }),
			7,
		)
		expect(intervals).toEqual([
			{
				userId: 'a',
				group: 'docs:1',
				source: 'owner',
				recordId: '1',
				role: 'manage',
				expiresAt: null,
				joinedSeq: 5,
				leftSeq: null,
			},
		])
	})
})

describe('rebuild and fingerprint', () => {
	test('records become intervals held from the start', () => {
		const intervals = membershipIntervalsFromRecords(access, [
			{
				collection: 'members',
				recordId: 'm1',
				values: { userId: 'a', group: 'docs:9', role: 'view' },
			},
			{ collection: 'docs', recordId: '2', values: { by: 'b' } },
		])
		expect(intervals.map((i) => [i.userId, i.group, i.joinedSeq])).toEqual([
			['a', 'docs:9', 0],
			['b', 'docs:2', 0],
		])
	})

	test('the fingerprint follows the memberships collection and the groups only', () => {
		expect(membershipIndexFingerprint(undefined)).toBe('')
		expect(membershipIndexFingerprint(access)).toContain('members')
		expect(membershipIndexFingerprint(access)).toContain('docs')
	})
})
