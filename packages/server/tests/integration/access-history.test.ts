/**
 * `access.groups.<collection>.history`: by default a member receives a group's state
 * when they join and its operations from then on; `history: 'full'` gives new members
 * the operations written before they joined too.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'

function makeSchema(history: 'joined' | 'full') {
	return defineSchema({
		version: 1,
		access: {
			memberships: 'members',
			roles: ['view', 'manage'],
			groups: { wikis: { owner: 'ownerId', role: 'manage', history } },
		},
		collections: {
			members: {
				fields: { userId: t.string(), group: t.string(), role: t.string() },
				access: { read: memberOfKey('group', 'manage') },
			},
			wikis: {
				fields: { title: t.string(), ownerId: t.string().stamp('userId') },
				access: { read: member('id'), create: owner('ownerId'), update: member('id', 'manage') },
			},
		},
	})
}

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})
const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

function deliveredIds(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch' ? (m.operations as Array<{ id: string }>).map((o) => o.id) : [],
	)
}

async function lateJoiner(history: 'joined' | 'full') {
	const harness = await createHarness(makeSchema(history), auth, { experimentalAccessRules: true })
	const ann = await harness.login('ann', 'ann-node', FRESH)
	const create = makeOp('ann-node', 1, {
		collection: 'wikis',
		recordId: 'w1',
		data: { title: 'v1', ownerId: 'ann' },
	})
	const edit = makeOp('ann-node', 2, {
		type: 'update',
		collection: 'wikis',
		recordId: 'w1',
		data: { title: 'v2' },
	})
	ann.send(batch([create, edit]))
	await tick(150)
	await harness.server.access.grant({ userId: 'bob', group: ['wikis', 'w1'], role: 'view' })
	const bob = await harness.login('bob', 'bob-node', FRESH)
	await tick(200)
	return { ids: deliveredIds(bob.messages), create, edit }
}

describe('group history', () => {
	test("by default a late joiner's device receives the state, not the history", async () => {
		const { ids, create, edit } = await lateJoiner('joined')
		expect(ids).not.toContain(create.id)
		expect(ids).not.toContain(edit.id)
	})

	test("history: 'full' sends a late joiner the operations written before they joined", async () => {
		const { ids, create, edit } = await lateJoiner('full')
		expect(ids).toEqual(expect.arrayContaining([create.id, edit.id]))
	})

	test('an unknown history value is refused when the schema is defined', () => {
		expect(() =>
			defineSchema({
				version: 1,
				access: {
					memberships: 'members',
					roles: ['view'],
					groups: { wikis: { owner: 'ownerId', role: 'view', history: 'all' as never } },
				},
				collections: {
					members: {
						fields: { userId: t.string(), group: t.string(), role: t.string() },
						access: { read: memberOfKey('group') },
					},
					wikis: {
						fields: { ownerId: t.string().stamp('userId') },
						access: { read: member('id'), create: owner('ownerId') },
					},
				},
			}),
		).toThrow("history must be 'joined' or 'full'")
	})
})
