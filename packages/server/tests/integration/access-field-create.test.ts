/**
 * Field rules on insert, end to end through the sync server: a field rule that declares
 * only `update` lets a device create records that leave the field at its schema default
 * (which every device fills in on insert), and still refuses any other value.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createHarness, makeOp, sendAndAwaitAck } from '../repro/rt-fixture'

const DOC = { group: 'documents' }

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'comment', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
		comments: {
			fields: {
				documentId: t.string(),
				body: t.string(),
				authorId: t.string().stamp('userId'),
				resolved: t.boolean().default(false),
			},
			access: {
				read: member('documentId', 'view', DOC),
				create: member('documentId', 'comment', DOC),
				update: owner('authorId'),
				fields: { resolved: { update: member('documentId', 'comment', DOC) } },
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})

const LOGIN = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

function rejectionFor(messages: SyncMessage[], operationId: string): string | null {
	for (const m of messages) {
		if (m.type === 'operation-rejected' && m.operationId === operationId) return m.code
	}
	return null
}

describe('field rules on insert (sync server)', () => {
	test('the schema default passes an update-only field rule; another value does not', async () => {
		const harness = await createHarness(schema, auth)
		const ann = await harness.login('ann', 'ann-node', LOGIN)
		const doc = makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Plan', ownerId: 'ann' },
		})
		await sendAndAwaitAck(ann, [doc])
		expect(rejectionFor(ann.messages, doc.id)).toBeNull()
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'comment',
		})

		const bob = await harness.login('bob', 'bob-node', LOGIN)
		// What a device sends for `insert({ documentId, body })`: the default filled in.
		const withDefault = makeOp('bob-node', 1, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'Hi', authorId: 'bob', resolved: false },
		})
		const presetResolved = makeOp('bob-node', 2, {
			collection: 'comments',
			recordId: 'c2',
			data: { documentId: 'd1', body: 'Hi', authorId: 'bob', resolved: true },
		})
		await sendAndAwaitAck(bob, [withDefault, presetResolved])
		expect(rejectionFor(bob.messages, withDefault.id)).toBeNull()
		expect(rejectionFor(bob.messages, presetResolved.id)).toBe('ACCESS_DENIED')
		expect(await harness.store.findRecord('comments', 'c1')).toMatchObject({ resolved: false })
		expect(await harness.store.findRecord('comments', 'c2')).toBeNull()

		// The default does not let a non-member create one: the collection rule still holds.
		const outsider = makeOp('ann-node', 2, {
			collection: 'comments',
			recordId: 'c3',
			data: { documentId: 'd-other', body: 'Hi', authorId: 'ann', resolved: false },
		})
		await sendAndAwaitAck(ann, [outsider])
		expect(rejectionFor(ann.messages, outsider.id)).toBe('ACCESS_DENIED')

		// And the field's update rule still governs changing it afterwards.
		const resolve = makeOp('bob-node', 3, {
			type: 'update',
			collection: 'comments',
			recordId: 'c1',
			data: { resolved: true },
			previousData: { resolved: false },
		})
		await sendAndAwaitAck(bob, [resolve])
		expect(rejectionFor(bob.messages, resolve.id)).toBeNull()
		expect(await harness.store.findRecord('comments', 'c1')).toMatchObject({ resolved: true })
		await harness.server.stop()
	})
})
