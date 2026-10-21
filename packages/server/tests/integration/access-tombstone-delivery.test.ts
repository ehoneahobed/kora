/**
 * Access rules and deletions decided by the record's folded state: a member who joined
 * a group after a record's last write holds the record from the state sent at joining,
 * so its deletion must reach them.
 */
import { defineSchema, member, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, deliveredOpIds, makeOp, tick } from '../repro/rt-fixture'

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
			access: { read: member('id'), create: owner('ownerId'), delete: member('id', 'manage') },
		},
		comments: {
			fields: { documentId: t.string(), body: t.string() },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
				delete: member('documentId', 'view', { group: 'documents' }),
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob', 'cat'].includes(token) ? { userId: token } : null),
})

const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

describe('deletion delivery under access rules', () => {
	test('a member who joined after the last write receives the deletion', async () => {
		const harness = await createHarness(schema, auth)
		const ann = await harness.login('ann', 'ann-node', FRESH)
		const doc = makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'doc', ownerId: 'ann' },
		})
		const comment = makeOp('ann-node', 2, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'first' },
		})
		ann.send(batch([doc, comment]))
		await tick(150)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await vi.waitFor(() =>
			expect(
				bob.messages.some(
					(m) =>
						m.type === 'operation-batch' &&
						(m.operations as Array<{ recordId: string }>).some((o) => o.recordId === 'c1'),
				),
			).toBe(true),
		)
		const remove = makeOp('ann-node', 3, {
			type: 'delete',
			collection: 'comments',
			recordId: 'c1',
			data: null,
		})
		ann.send(batch([remove]))
		await vi.waitFor(() => expect(deliveredOpIds(bob.messages)).toContain(remove.id), {
			timeout: 3000,
		})
		// A user who never was a member receives nothing of it.
		const cat = await harness.login('cat', 'cat-node', FRESH)
		await tick(150)
		expect(deliveredOpIds(cat.messages)).not.toContain(remove.id)
	})
})
