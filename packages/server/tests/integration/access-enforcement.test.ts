/**
 * Access rules enforced by the sync server (beta.15 access step 4, experimental):
 * uploads are decided against the writer's memberships at decision time, group ids
 * cannot be taken over, stamps are checked, memberships are server-written, and a
 * session's read grant is compiled from its memberships at handshake.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import {
	and,
	anyone,
	defineSchema,
	member,
	memberOfKey,
	or,
	owner,
	serverOnly,
	t,
} from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'comment', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: {
				userId: t.string(),
				group: t.string(),
				role: t.string(),
				expiresAt: t.timestamp().optional(),
			},
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: {
				title: t.string(),
				ownerId: t.string().stamp('userId'),
				views: t.number().optional(),
				tags: t.array(t.string()).default([]),
			},
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
		comments: {
			fields: { documentId: t.string(), body: t.string(), authorId: t.string().stamp('userId') },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'comment', { group: 'documents' }),
				update: and(member('documentId', 'comment', { group: 'documents' }), owner('authorId')),
				delete: or(owner('authorId'), member('documentId', 'manage', { group: 'documents' })),
			},
		},
		templates: { fields: { name: t.string() }, access: { read: anyone(), write: serverOnly() } },
		notes: { fields: { body: t.string(), documentId: t.string().optional() } },
	},
	relations: {
		noteDocument: {
			from: 'notes',
			to: 'documents',
			type: 'many-to-one',
			field: 'documentId',
			onDelete: 'set-null',
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})

const CAPABLE = {
	supportsScopeDisjunction: true,
	lastDeliverySequence: 0,
} as Partial<SyncMessage>
const FROM_START = {
	supportsScopeDisjunction: true,
	lastDeliverySequence: 0,
} as Partial<SyncMessage>

function rejectionFor(messages: SyncMessage[], operationId: string): string | null {
	for (const m of messages) {
		if (m.type === 'operation-rejected' && m.operationId === operationId) return m.code
	}
	return null
}

function delivered(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch'
			? (m.operations as Array<{ collection: string; recordId: string }>).map(
					(op) => `${op.collection}/${op.recordId}`,
				)
			: [],
	)
}

async function setup() {
	const harness = await createHarness(schema, auth, { experimentalAccessRules: true })
	const ann = await harness.login('ann', 'ann-node', CAPABLE)
	const create = makeOp('ann-node', 1, {
		collection: 'documents',
		recordId: 'd1',
		data: { title: 'Plan', ownerId: 'ann' },
	})
	ann.send(batch([create]))
	await tick(120)
	expect(rejectionFor(ann.messages, create.id)).toBeNull()
	return { harness, ann }
}

describe('access rules enforcement', () => {
	test('the creator of a group record manages it; others cannot touch it', async () => {
		const { harness } = await setup()
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const edit = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Mine now' },
		})
		bob.send(batch([edit]))
		await tick(120)
		expect(rejectionFor(bob.messages, edit.id)).toBe('ACCESS_DENIED')
		expect((await harness.store.findRecord('documents', 'd1'))?.title).toBe('Plan')
	})

	test('a group id cannot be taken over (GROUP_EXISTS), live or deleted', async () => {
		const { harness } = await setup()
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const takeover = makeOp('bob-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Hijack', ownerId: 'bob' },
		})
		bob.send(batch([takeover]))
		await tick(120)
		expect(rejectionFor(bob.messages, takeover.id)).toBe('GROUP_EXISTS')
		expect((await harness.store.getMembershipIntervals?.('bob')) ?? []).toEqual([])
	})

	test('stamps: required on insert and equal to the writer', async () => {
		const { harness, ann } = await setup()
		const missing = makeOp('ann-node', 2, {
			collection: 'documents',
			recordId: 'd2',
			data: { title: 'No owner' },
		})
		const spoofed = makeOp('ann-node', 3, {
			collection: 'documents',
			recordId: 'd3',
			data: { title: 'For bob', ownerId: 'bob' },
		})
		ann.send(batch([missing, spoofed]))
		await tick(120)
		expect(rejectionFor(ann.messages, missing.id)).toBe('STAMP_REQUIRED')
		expect(rejectionFor(ann.messages, spoofed.id)).toBe('STAMP_MISMATCH')
		expect(await harness.store.findRecord('documents', 'd3')).toBeNull()
	})

	test('a grant takes effect at once; a revoke refuses the very next write', async () => {
		const { harness } = await setup()
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' })
		const allowed = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Edited by bob' },
		})
		bob.send(batch([allowed]))
		await tick(120)
		expect(rejectionFor(bob.messages, allowed.id)).toBeNull()
		expect((await harness.store.findRecord('documents', 'd1'))?.title).toBe('Edited by bob')

		await harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] })
		const refused = makeOp('bob-node', 2, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'After revoke' },
		})
		bob.send(batch([refused]))
		await tick(120)
		expect(rejectionFor(bob.messages, refused.id)).toBe('ACCESS_DENIED')
		expect((await harness.store.findRecord('documents', 'd1'))?.title).toBe('Edited by bob')
	})

	test('roles are ordered: comment admits commenting, not editing', async () => {
		const { harness } = await setup()
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'comment',
		})
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const comment = makeOp('bob-node', 1, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'Nice', authorId: 'bob' },
		})
		const edit = makeOp('bob-node', 2, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'x' },
		})
		bob.send(batch([comment, edit]))
		await tick(120)
		expect(rejectionFor(bob.messages, comment.id)).toBeNull()
		expect(rejectionFor(bob.messages, edit.id)).toBe('ACCESS_DENIED')
	})

	test('memberships are server-written only', async () => {
		const { ann } = await setup()
		const selfGrant = makeOp('ann-node', 2, {
			collection: 'members',
			recordId: 'm-forged',
			data: { userId: 'ann', group: 'documents:other', role: 'manage' },
		})
		ann.send(batch([selfGrant]))
		await tick(120)
		expect(rejectionFor(ann.messages, selfGrant.id)).toBe('SERVER_OWNED')
	})

	test('the read grant follows memberships at handshake; own membership rows are delivered', async () => {
		const { harness } = await setup()
		await harness.server.getKoraContext().apply({
			collection: 'templates',
			type: 'insert',
			recordId: 't1',
			data: { name: 'Blank' },
		})
		const before = await harness.login('bob', 'bob-node', FROM_START)
		expect(delivered(before.messages)).not.toContain('documents/d1')
		expect(delivered(before.messages)).toContain('templates/t1')

		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const after = await harness.login('bob', 'bob-node-2', FROM_START)
		const seen = delivered(after.messages)
		expect(seen).toContain('documents/d1')
		expect(seen.some((key) => key.startsWith('members/'))).toBe(true)
	})

	test('an expired membership grants nothing; the sweep ends it in the log', async () => {
		const { harness } = await setup()
		await harness.server.access.grant({
			userId: 'bob',
			group: ['documents', 'd1'],
			role: 'edit',
			expiresAt: Date.now() - 1_000,
		})
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const edit = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'late' },
		})
		bob.send(batch([edit]))
		await tick(120)
		expect(rejectionFor(bob.messages, edit.id)).toBe('ACCESS_DENIED')
		expect(await harness.server.access.sweepExpired()).toBe(1)
		const intervals = (await harness.store.getMembershipIntervals?.('bob')) ?? []
		expect(intervals[0]?.leftSeq).not.toBeNull()
	})

	test('a transfer moves management to the new owner', async () => {
		const { harness } = await setup()
		await harness.server.access.transfer({ group: ['documents', 'd1'], toUserId: 'bob' })
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const edit = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Bob owns it' },
		})
		bob.send(batch([edit]))
		await tick(120)
		expect(rejectionFor(bob.messages, edit.id)).toBeNull()
	})

	test('a client that cannot follow access rules is refused', async () => {
		const harness = await createHarness(schema, auth, { experimentalAccessRules: true })
		const old = await harness.login('ann', 'old-node')
		const error = old.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('CLIENT_TOO_OLD')
	})

	test('writes that look empty still need a rule (restore, atomic intents, no-op updates)', async () => {
		const { harness, ann } = await setup()
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const atomic = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { views: 0 },
			previousData: { views: 0 },
			atomicOps: { views: { type: 'increment', value: 1000 } },
		})
		const noop = makeOp('bob-node', 2, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: {},
		})
		bob.send(batch([atomic, noop]))
		await tick(120)
		expect(rejectionFor(bob.messages, atomic.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(bob.messages, noop.id)).toBe('ACCESS_DENIED')

		const remove = makeOp('ann-node', 2, {
			type: 'delete',
			collection: 'documents',
			recordId: 'd1',
			data: null,
		})
		ann.send(batch([remove]))
		await tick(120)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' })
		const restore = makeOp('bob-node', 3, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Back' },
			timestamp: { wallTime: Date.now() + 5_000, logical: 0, nodeId: 'bob-node' },
		})
		bob.send(batch([restore]))
		await tick(120)
		// An editor may edit, not undelete: restoring takes the delete rule (manage).
		expect(rejectionFor(bob.messages, restore.id)).toBe('ACCESS_DENIED')
		expect(await harness.store.findRecord('documents', 'd1')).toBeNull()
	})

	test('encrypted operations and changes to records the server does not hold are refused', async () => {
		const { harness } = await setup()
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const preplant = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'future',
			data: { ownerId: 'bob' },
		})
		const sealed = makeOp('bob-node', 2, {
			id: 'sealed-op',
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: null,
			encrypted: { v: 2, keyId: 'k', iv: 'aa', ciphertext: 'bb' } as never,
		})
		bob.send(batch([preplant, sealed]))
		await tick(120)
		expect(rejectionFor(bob.messages, preplant.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(bob.messages, sealed.id)).not.toBeNull()
		expect(await harness.store.findRecord('documents', 'future')).toBeNull()
	})

	test('a reference to a document the writer cannot read is refused', async () => {
		const { harness } = await setup()
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const note = makeOp('bob-node', 1, {
			collection: 'notes',
			recordId: 'n-ref',
			data: { body: 'x', documentId: 'd1' },
		})
		bob.send(batch([note]))
		await tick(120)
		expect(rejectionFor(bob.messages, note.id)).toBe('SCOPE_VIOLATION')
	})

	test('server.access refuses a transfer of a missing record and a grant before the group exists', async () => {
		const { harness } = await setup()
		const transfer = await harness.server.access.transfer({
			group: ['documents', 'missing'],
			toUserId: 'bob',
		})
		expect(transfer.ok).toBe(false)
		await expect(
			harness.server.access.grant({ userId: 'bob', group: ['documents', 'missing'], role: 'view' }),
		).rejects.toThrow(/does not exist yet/)
	})

	test("unscopedSharing: 'refuse' does not count rule-governed collections as shared", async () => {
		const harness = await createHarness(schema, auth, {
			experimentalAccessRules: true,
			unscopedSharing: 'refuse',
		})
		const ann = await harness.login('ann', 'ann-node', CAPABLE)
		const error = ann.messages.find((m) => m.type === 'error')
		// `notes` has no rules and the provider grants everything: that one is shared.
		expect(error && 'code' in error ? error.code : null).toBe('UNSCOPED_SHARING_REFUSED')
	})

	test('collections without rules keep the provider grant', async () => {
		const { ann } = await setup()
		const note = makeOp('ann-node', 2, { collection: 'notes', recordId: 'n1', data: { body: 'x' } })
		ann.send(batch([note]))
		await tick(120)
		expect(rejectionFor(ann.messages, note.id)).toBeNull()
	})
})
