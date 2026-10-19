import { and, custom, defineSchema, member, owner, t, where } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	MAX_JUDGED_ATOMIC_FIELDS,
	accessReadGrant,
	authorizeAccessOperation,
	effectiveGroupRole,
	membershipViewOf,
} from './access-authorizer'
import type { MembershipInterval } from './membership-index'

const access = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'manage'],
		groups: { boards: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		boards: {
			fields: { ownerId: t.string().stamp('userId'), count: t.number() },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				// Updates allowed only while the count is (and stays) 5: a contrived bound.
				update: where({ count: 5 }),
			},
		},
	},
}).access

if (!access) throw new Error('no access')

function op(overrides: Partial<Operation>): Operation {
	return {
		id: 'x',
		nodeId: 'n',
		type: 'update',
		collection: 'boards',
		recordId: 'b1',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const stored = { id: 'b1', ownerId: 'ann', count: 5 }

describe('authorizeAccessOperation', () => {
	test('an atomic intent is judged by its result, not by what data claims', () => {
		const sneaky = op({
			data: { count: 5 },
			atomicOps: { count: { type: 'increment', value: 100 } },
		})
		expect(
			authorizeAccessOperation(access, sneaky, stored, { userId: 'ann' }, [], 0),
		).toMatchObject({
			allowed: false,
			code: 'ACCESS_DENIED',
		})
		const harmless = op({ data: { count: 5 }, atomicOps: { count: { type: 'max', value: 3 } } })
		expect(authorizeAccessOperation(access, harmless, stored, { userId: 'ann' }, [], 0)).toEqual({
			allowed: true,
		})
	})

	test('the read grant always includes the user own membership rows', () => {
		const intervals: MembershipInterval[] = [
			{
				userId: 'ann',
				group: 'boards:b1',
				source: 'membership',
				recordId: 'm1',
				role: 'view',
				expiresAt: null,
				joinedSeq: 1,
				roleSeq: 1,
				leftSeq: null,
			},
		]
		const grant = accessReadGrant(access, { userId: 'ann' }, intervals, 0)
		expect(grant.boards).toEqual({ id: { $in: ['b1'] } })
		expect(grant.members).toEqual({ userId: 'ann' })
		expect(accessReadGrant(access, { userId: null }, [], 0)).toEqual({})
	})
})

describe('effectiveGroupRole', () => {
	const interval = (
		source: 'membership' | 'owner' | 'grant',
		role: string,
		roleSeq: number,
		recordId: string,
	): MembershipInterval => ({
		userId: 'bob',
		group: 'forms:f1',
		source,
		recordId,
		role,
		expiresAt: null,
		joinedSeq: roleSeq,
		roleSeq,
		leftSeq: null,
	})
	const roles = ['view', 'edit', 'owner']

	test('a capability grant is no role of the store', () => {
		expect(
			effectiveGroupRole([interval('grant', 'owner', 0, '')], 'bob', 'forms:f1', roles, 0),
		).toBeNull()
		expect(
			effectiveGroupRole(
				[interval('grant', 'owner', 0, ''), interval('membership', 'view', 2, 'm1')],
				'bob',
				'forms:f1',
				roles,
				0,
			),
		).toMatchObject({ role: 'view', source: 'membership' })
	})

	test('the owner field wins over an older membership row of the same role', () => {
		const held = effectiveGroupRole(
			[interval('membership', 'owner', 3, 'm1'), interval('owner', 'owner', 9, 'f1')],
			'bob',
			'forms:f1',
			roles,
			0,
		)
		expect(held).toEqual({ role: 'owner', source: 'owner', since: 9, proof: 'owner:9' })
	})

	test('the proof is bound to the index generation once a restore set one', () => {
		const rows = [interval('membership', 'edit', 0, 'm1')]
		const before = effectiveGroupRole(rows, 'bob', 'forms:f1', roles, 0)
		const first = effectiveGroupRole(rows, 'bob', 'forms:f1', roles, 0, 'g1')
		const second = effectiveGroupRole(rows, 'bob', 'forms:f1', roles, 0, 'g2')
		// Same sequence after each rebuild, yet no proof matches another generation's.
		expect(before?.proof).toBe('membership:0')
		expect(first?.proof).toBe('membership:0@g1')
		expect(second?.proof).not.toBe(first?.proof)
		expect(first?.since).toBe(second?.since)
	})

	test('a higher role still wins, and equal membership rows take the oldest', () => {
		expect(
			effectiveGroupRole(
				[interval('owner', 'edit', 1, 'f1'), interval('membership', 'owner', 5, 'm1')],
				'bob',
				'forms:f1',
				roles,
				0,
			),
		).toMatchObject({ source: 'membership', since: 5 })
		expect(
			effectiveGroupRole(
				[interval('membership', 'edit', 7, 'm2'), interval('membership', 'edit', 4, 'm1')],
				'bob',
				'forms:f1',
				roles,
				0,
			),
		).toMatchObject({ since: 4 })
	})
})

describe('membershipViewOf', () => {
	const base = { group: 'boards:b1', expiresAt: null, joinedSeq: 0, roleSeq: 0, leftSeq: null }
	test('grant intervals count only for questions that admit grants', () => {
		const view = membershipViewOf(
			[
				{ ...base, userId: 'ann', source: 'grant', recordId: '', role: 'manage' },
				{
					...base,
					userId: 'ann',
					source: 'owner',
					recordId: 'b2',
					group: 'boards:b2',
					role: 'view',
				},
			],
			'ann',
			['view', 'manage'],
			0,
		)
		expect(view.roleOf('boards:b1')).toBe('manage')
		expect(view.roleOf('boards:b1', { grants: false })).toBeNull()
		expect(view.groupKeys({ grants: false })).toEqual(['boards:b2'])
		// An anonymous principal holds only grants.
		const anonymous = membershipViewOf(
			[{ ...base, userId: '\u0000anonymous', source: 'grant', recordId: '', role: 'view' }],
			null,
			['view', 'manage'],
			0,
		)
		expect(anonymous.groupKeys()).toEqual(['boards:b1'])
		expect(anonymous.groupKeys({ grants: false })).toEqual([])
	})
})

describe('atomic intents without the resulting record', () => {
	const fields = {
		ownerId: t.string().stamp('userId'),
		a: t.number().default(0),
		b: t.number().default(0),
		c: t.number().default(0),
		d: t.number().default(0),
		e: t.number().default(0),
	}
	const pairAccess = defineSchema({
		version: 1,
		collections: {
			pairs: {
				fields,
				access: {
					read: owner('ownerId'),
					create: owner('ownerId'),
					update: and(
						owner('ownerId'),
						custom(({ record }) => record.a === record.b),
					),
				},
			},
		},
	}).access
	if (!pairAccess) throw new Error('schema has no access')
	const stored = { id: 'r1', ownerId: 'ann', a: 5, b: 5, c: 0, d: 0, e: 0 }
	const update = (data: Record<string, number>, atomic: string[]): Operation => ({
		id: 'op',
		nodeId: 'n',
		type: 'update',
		collection: 'pairs',
		recordId: 'r1',
		data,
		previousData: Object.fromEntries(Object.keys(data).map((k) => [k, (data[k] ?? 0) - 1])),
		atomicOps: Object.fromEntries(atomic.map((k) => [k, { type: 'increment' as const, value: 1 }])),
		timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	})
	const judge = (
		op: Operation,
		resulting?: { values: Record<string, unknown>; deleted: boolean },
	) => authorizeAccessOperation(pairAccess, op, stored, { userId: 'ann' }, [], 0, resulting)

	test('every per-field combination is judged: a mixed outcome refuses', () => {
		// {1, 1} and {6, 6} keep a === b, but {6, 1} and {1, 6} do not.
		expect(judge(update({ a: 1, b: 1 }, ['a', 'b']))).toMatchObject({
			allowed: false,
			code: 'ACCESS_DENIED',
		})
	})

	test('the resulting record, when the store gives it, is what is judged', () => {
		const op = update({ a: 1, b: 1 }, ['a', 'b'])
		expect(judge(op, { values: { ...stored, a: 6, b: 6 }, deleted: false })).toEqual({
			allowed: true,
		})
		expect(judge(op, { values: { ...stored, a: 6, b: 1 }, deleted: false })).toMatchObject({
			allowed: false,
		})
	})

	test(`more than ${String(MAX_JUDGED_ATOMIC_FIELDS)} intents without the record are refused`, () => {
		const five = update({ a: 6, b: 6, c: 1, d: 1, e: 1 }, ['a', 'b', 'c', 'd', 'e'])
		expect(judge(five)).toMatchObject({ allowed: false, code: 'INVALID_ATOMIC_OP' })
		expect(
			judge(five, { values: { ...stored, a: 6, b: 6, c: 1, d: 1, e: 1 }, deleted: false }),
		).toEqual({ allowed: true })
	})
})
