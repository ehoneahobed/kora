import { defineSchema } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { batch, createHarness, makeOp, tick } from '../../repro/rt-fixture'
import { FRESH, auth, items, schema } from './shared'

describe('deletes in access collections', () => {
	test('a member receives the delete of a comment in their group', async () => {
		const s2 = schema
		const harness = await createHarness(s2, auth, { experimentalAccessRules: true })
		const ann = await harness.login('ann', 'ann-node', FRESH)
		ann.send(
			batch([
				makeOp('ann-node', 1, {
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'one', ownerId: 'ann' },
				}),
				makeOp('ann-node', 2, {
					collection: 'comments',
					recordId: 'c1',
					data: { documentId: 'd1', body: 'hi', authorId: 'ann' },
				}),
			]),
		)
		await tick(200)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(200)
		const del = makeOp('ann-node', 3, {
			type: 'delete',
			collection: 'comments',
			recordId: 'c1',
			data: null,
		})
		ann.send(batch([del]))
		await tick(300)
		const got = items(bob.messages)
		expect(
			got.some((i) => i.id === del.id || (i.kind === 'retract' && i.key === 'comments/c1')),
		).toBe(true)
	})
})
