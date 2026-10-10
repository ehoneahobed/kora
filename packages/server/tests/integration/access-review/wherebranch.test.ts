import { and, defineSchema, member, owner, t, where } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items } from './shared'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
		posts: {
			fields: { docId: t.string(), published: t.boolean(), authorId: t.string().stamp('userId') },
			access: {
				read: and(member('docId', 'view', { group: 'documents' }), where({ published: true })),
				create: member('docId', 'view', { group: 'documents' }),
			},
		},
	},
})

describe('re-scope unit over a where branch', () => {
	test('a grant delivers the published post of the group', async () => {
		const harness = await createHarness(schema, auth, { experimentalAccessRules: true })
		const ann = await harness.login('ann', 'ann-node', FRESH)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'one', ownerId: 'ann' },
				}),
				makeOp('ann-node', 2, {
					collection: 'posts',
					recordId: 'p1',
					data: { docId: 'd1', published: true, authorId: 'ann' },
				}),
			]),
		)
		await tick(200)
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await tick(400)
		const keys = items(bob.messages).map((i) => `${i.kind}:${i.key}:${i.nodeId}`)
		ann.send(
			batch([
				makeOp('ann-node', 3, {
					collection: 'posts',
					recordId: 'p2',
					data: { docId: 'd1', published: true, authorId: 'ann' },
				}),
			]),
		)
		await tick(300)
		expect(keys.some((k) => k.includes('posts/p1'))).toBe(true)
	})
})
