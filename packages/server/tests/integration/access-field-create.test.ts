/**
 * Field rules on insert, end to end through the sync server: a field rule that declares
 * only `update` lets a device create records that leave the field at its schema default
 * (which every device fills in on insert), and still refuses any other value.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { and, custom, defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
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

const walletSchema = defineSchema({
	version: 1,
	access: { memberships: 'members', roles: ['view', 'manage'], groups: {} },
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		wallets: {
			fields: {
				ownerId: t.string().stamp('userId'),
				credits: t.number().default(0),
				level: t.number().default(0),
			},
			access: {
				read: owner('ownerId'),
				create: owner('ownerId'),
				update: owner('ownerId'),
				fields: {
					// Clients never choose credits on insert: only the default.
					credits: { update: owner('ownerId') },
					// A level never goes past 10, whatever the write claims.
					level: {
						create: owner('ownerId'),
						update: and(
							owner('ownerId'),
							custom(({ record }) => typeof record.level === 'number' && record.level <= 10),
						),
					},
				},
			},
		},
	},
})

describe('atomic intents are judged as the fold stores them (security)', () => {
	async function walletHarness() {
		const harness = await createHarness(walletSchema, auth)
		const ann = await harness.login('ann', 'ann-node', LOGIN)
		return { harness, ann }
	}

	test('an insert cannot smuggle a protected value behind an intent that yields the default', async () => {
		const { harness, ann } = await walletHarness()
		const plain = makeOp('ann-node', 1, {
			collection: 'wallets',
			recordId: 'w1',
			data: { ownerId: 'ann', credits: 1_000_000 },
		})
		const smuggled = makeOp('ann-node', 2, {
			collection: 'wallets',
			recordId: 'w2',
			data: { ownerId: 'ann', credits: 1_000_000 },
			atomicOps: { credits: { type: 'increment', value: 0 } },
		})
		// Even data that agrees with the intent is a choice, never the default shortcut.
		const agreeing = makeOp('ann-node', 3, {
			collection: 'wallets',
			recordId: 'w3',
			data: { ownerId: 'ann', credits: 0 },
			atomicOps: { credits: { type: 'increment', value: 0 } },
		})
		await sendAndAwaitAck(ann, [plain, smuggled, agreeing])
		expect(rejectionFor(ann.messages, plain.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(ann.messages, smuggled.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(ann.messages, agreeing.id)).toBe('ACCESS_DENIED')
		expect(await harness.store.findRecord('wallets', 'w2')).toBeNull()
		expect(await harness.store.findRecord('wallets', 'w3')).toBeNull()
		await harness.server.stop()
	})

	test('an unknown atomic type is refused, never judged as an unset field', async () => {
		const { harness, ann } = await walletHarness()
		const bogus = makeOp('ann-node', 1, {
			collection: 'wallets',
			recordId: 'w1',
			data: { ownerId: 'ann', credits: 1_000_000 },
			atomicOps: { credits: { type: 'bogus', value: 0 } as never },
		})
		await sendAndAwaitAck(ann, [bogus])
		expect(rejectionFor(ann.messages, bogus.id)).not.toBeNull()
		expect(await harness.store.findRecord('wallets', 'w1')).toBeNull()
		await harness.server.stop()
	})

	test('updates: the written value is judged, and must agree with its intent', async () => {
		const { harness, ann } = await walletHarness()
		const create = makeOp('ann-node', 1, {
			collection: 'wallets',
			recordId: 'w1',
			data: { ownerId: 'ann', credits: 0, level: 8 },
		})
		await sendAndAwaitAck(ann, [create])
		expect(rejectionFor(ann.messages, create.id)).toBeNull()

		// What a client sends for op.increment(1): data = previousData + 1. Accepted.
		const honest = makeOp('ann-node', 2, {
			type: 'update',
			collection: 'wallets',
			recordId: 'w1',
			data: { level: 9 },
			previousData: { level: 8 },
			atomicOps: { level: { type: 'increment', value: 1 } },
		})
		// A lying base: data agrees with previousData + 1, but the stored level is 9. After
		// the increment above the fold composes (9 + 1 = 10, allowed) unless a concurrent
		// plain write lands first, when it stores the claimed 11: both are judged, refused.
		const lyingBase = makeOp('ann-node', 3, {
			type: 'update',
			collection: 'wallets',
			recordId: 'w1',
			data: { level: 11 },
			previousData: { level: 10 },
			atomicOps: { level: { type: 'increment', value: 1 } },
		})
		// Data that disagrees with its own intent.
		const disagreeing = makeOp('ann-node', 4, {
			type: 'update',
			collection: 'wallets',
			recordId: 'w1',
			data: { credits: 1_000_000 },
			previousData: { credits: 0 },
			atomicOps: { credits: { type: 'increment', value: 0 } },
		})
		await sendAndAwaitAck(ann, [honest])
		expect(rejectionFor(ann.messages, honest.id)).toBeNull()
		await sendAndAwaitAck(ann, [lyingBase, disagreeing])
		expect(rejectionFor(ann.messages, lyingBase.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(ann.messages, disagreeing.id)).toBe('INVALID_ATOMIC_OP')
		expect(await harness.store.findRecord('wallets', 'w1')).toMatchObject({ level: 9, credits: 0 })
		await harness.server.stop()
	})

	test('a lying base after a plain write is refused (the fold would store the claimed value)', async () => {
		const { harness, ann } = await walletHarness()
		const create = makeOp('ann-node', 1, {
			collection: 'wallets',
			recordId: 'w1',
			data: { ownerId: 'ann', credits: 0, level: 2 },
		})
		await sendAndAwaitAck(ann, [create])
		// Stored level is 2 (a plain write): an increment does not compose with it, so the
		// fold stores data.level. The old check judged 2 + 1 = 3 and stored 50.
		const lying = makeOp('ann-node', 2, {
			type: 'update',
			collection: 'wallets',
			recordId: 'w1',
			data: { level: 50 },
			previousData: { level: 49 },
			atomicOps: { level: { type: 'increment', value: 1 } },
		})
		await sendAndAwaitAck(ann, [lying])
		expect(rejectionFor(ann.messages, lying.id)).toBe('ACCESS_DENIED')
		expect(await harness.store.findRecord('wallets', 'w1')).toMatchObject({ level: 2 })
		await harness.server.stop()
	})
})
