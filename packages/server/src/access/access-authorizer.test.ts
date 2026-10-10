import { defineSchema, member, owner, t, where } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { accessReadGrant, authorizeAccessOperation } from './access-authorizer'
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
