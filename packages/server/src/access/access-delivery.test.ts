import { defineSchema, member, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { intervalsAsOf, rescopeBasis } from './access-delivery'
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
