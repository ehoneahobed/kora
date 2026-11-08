import { defineSchema, member, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { intervalsAsOf, operationTouchesMemberships, rescopeBasis } from './access-delivery'
import type { MembershipInterval } from './membership-index'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'manage'],
		groups: { boards: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		boards: { fields: { ownerId: t.string().stamp('userId') }, access: { read: member('id') } },
		tasks: {
			fields: { board: t.string() },
			access: { read: member('board', 'view', { group: 'boards' }) },
		},
		secrets: {
			fields: { board: t.string() },
			access: { read: member('board', 'manage', { group: 'boards' }) },
		},
	},
})
const access = schema.access
if (!access) throw new Error('the schema declares access rules')

function interval(overrides: Partial<MembershipInterval>): MembershipInterval {
	return {
		userId: 'ann',
		group: 'boards:b1',
		source: 'membership',
		recordId: 'm1',
		role: 'view',
		expiresAt: null,
		joinedSeq: 1,
		roleSeq: 1,
		leftSeq: null,
		...overrides,
	}
}

describe('rescopeBasis', () => {
	test('nothing changed since the base: no narrowing, nothing to send', () => {
		const all = [interval({ role: 'manage' })]
		const basis = rescopeBasis(access, { userId: 'ann' }, intervalsAsOf(all, 10), all, 0, 10)
		expect(basis.narrowing).toBeNull()
		expect(basis.held).toEqual(basis.current)
	})

	test('a role downgraded in place after the base narrows every access collection', () => {
		const all = [interval({ role: 'view', roleSeq: 12 })]
		const basis = rescopeBasis(access, { userId: 'ann' }, intervalsAsOf(all, 10), all, 0, 10)
		expect(Object.keys(basis.narrowing ?? {})).toEqual(
			expect.arrayContaining(['boards', 'tasks', 'secrets']),
		)
		expect(basis.narrowing?.secrets ?? null).toBeNull()
	})

	test('downgraded and then removed after the base: the narrowing still covers what the old role read', () => {
		const all = [interval({ role: 'view', roleSeq: 12, leftSeq: 14 })]
		const basis = rescopeBasis(access, { userId: 'ann' }, intervalsAsOf(all, 10), all, 0, 10)
		expect(basis.narrowing).not.toBeNull()
		expect(Object.keys(basis.narrowing ?? {})).toContain('secrets')
		expect(basis.narrowing?.secrets ?? null).toBeNull()
	})

	test('a role changed before the base is known: no re-send', () => {
		const all = [interval({ role: 'manage', roleSeq: 8 })]
		const basis = rescopeBasis(access, { userId: 'ann' }, intervalsAsOf(all, 10), all, 0, 10)
		expect(basis.narrowing).toBeNull()
	})

	test('a group left and joined again is dropped by the narrowing and re-sent in full', () => {
		const all = [interval({ leftSeq: 12 }), interval({ joinedSeq: 14, roleSeq: 14 })]
		const basis = rescopeBasis(access, { userId: 'ann' }, intervalsAsOf(all, 10), all, 0, 10)
		expect(basis.narrowing?.tasks ?? null).toBeNull()
		expect(basis.held.tasks).toBeUndefined()
		expect(basis.current.tasks).toBeDefined()
	})

	test('after a unit (exact held set), an in-place change is compared directly', () => {
		const held = [interval({ role: 'manage' })]
		const now = [interval({ role: 'view', roleSeq: 20 })]
		const basis = rescopeBasis(access, { userId: 'ann' }, held, now, 0, null)
		expect(Object.keys(basis.narrowing ?? {})).toContain('secrets')
		expect(Object.keys(basis.narrowing ?? {})).not.toContain('tasks')
	})
})

describe('operationTouchesMemberships', () => {
	function boardOp(type: Operation['type']): Operation {
		return {
			id: 'op1',
			nodeId: 'node',
			type,
			collection: 'boards',
			recordId: 'b1',
			data: null,
			previousData: null,
			timestamp: { wallTime: 1, logical: 0, nodeId: 'node' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}
	}
	const mine = { ownerId: 'ann' }

	test('an edit of a board the user already owns changes no membership', () => {
		expect(
			operationTouchesMemberships(access, boardOp('update'), { pre: mine, post: mine }, 'ann'),
		).toBe(false)
	})

	test('creating, deleting or restoring an owned board changes them', () => {
		expect(
			operationTouchesMemberships(access, boardOp('insert'), { pre: null, post: mine }, 'ann'),
		).toBe(true)
		expect(
			operationTouchesMemberships(
				access,
				boardOp('delete'),
				{ pre: mine, post: mine, deleted: true },
				'ann',
			),
		).toBe(true)
		expect(
			operationTouchesMemberships(access, boardOp('update'), { pre: null, post: mine }, 'ann'),
		).toBe(true)
		expect(
			operationTouchesMemberships(
				access,
				boardOp('update'),
				{ pre: mine, post: mine, deleted: true },
				'ann',
			),
		).toBe(true)
	})

	test('moving a board to or from the user changes them', () => {
		expect(
			operationTouchesMemberships(
				access,
				boardOp('update'),
				{ pre: { ownerId: 'bob' }, post: mine },
				'ann',
			),
		).toBe(true)
		expect(
			operationTouchesMemberships(
				access,
				boardOp('update'),
				{ pre: mine, post: { ownerId: 'bob' } },
				'ann',
			),
		).toBe(true)
	})

	test('a missing snapshot names no owner, and a one-sided snapshot still re-scopes', () => {
		expect(operationTouchesMemberships(access, boardOp('update'), null, 'ann')).toBe(false)
		expect(
			operationTouchesMemberships(access, boardOp('update'), { pre: mine, post: null }, 'ann'),
		).toBe(true)
	})
})
