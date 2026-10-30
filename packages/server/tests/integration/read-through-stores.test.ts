/**
 * The read-through endpoint on every server store (memory, SQLite, and Postgres when
 * KORA_PG_TEST_URL is set): the same answers, the encrypted-record rule, access-rule
 * membership intervals and revocation. The generated-log invariant is in
 * `read-through-property.test.ts`.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { ReadResponse } from '../../src/read/read-types'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import { deliveryStoreKinds, removeDeliveryTempFiles } from '../fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../fixtures/pg-test-schemas'
import { createHarness, makeOp } from '../repro/rt-fixture'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { schools: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		schools: {
			fields: { name: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId') },
		},
		lessons: {
			fields: { schoolId: t.string(), title: t.string() },
			access: { read: member('schoolId', 'view', { group: 'schools' }) },
		},
	},
})

let revoked = false
const auth = new TokenAuthProvider({
	validate: async (token) =>
		['ann', 'bob'].includes(token) && !(revoked && token === 'bob') ? { userId: token } : null,
})

async function read(
	harness: Awaited<ReturnType<typeof createHarness>>,
	token: string,
	collection = 'lessons',
): Promise<{ status: number; response: ReadResponse | null; ids: string[] }> {
	const answer = await harness.server.handleReadRequest({
		method: 'POST',
		authorization: `Bearer ${token}`,
		contentType: 'application/json',
		body: JSON.stringify({
			v: 1,
			schemaVersion: 1,
			queries: [{ key: 'q', collection, where: {}, orderBy: [] }],
		}),
	})
	const response = answer.status === 200 ? (JSON.parse(answer.body ?? '') as ReadResponse) : null
	return {
		status: answer.status,
		response,
		ids: (response?.results[0]?.records ?? []).map((r) => r.id),
	}
}

for (const kind of deliveryStoreKinds()) {
	describe(`read-through on ${kind.name}`, () => {
		async function setup() {
			revoked = false
			const handle = await kind.make()
			const harness = await createHarness(
				schema,
				auth,
				{ readThrough: { authGuard: { ttlMs: 0 } } },
				handle.store as unknown as MemoryServerStore,
			)
			const ctx = harness.server.getKoraContext()
			for (const school of ['s1', 's2']) {
				await ctx.apply({
					collection: 'schools',
					type: 'insert',
					recordId: school,
					data: { name: school, ownerId: 'ann' },
				})
			}
			await ctx.apply({
				collection: 'lessons',
				type: 'insert',
				recordId: 'l1',
				data: { schoolId: 's1', title: 'one' },
			})
			await ctx.apply({
				collection: 'lessons',
				type: 'insert',
				recordId: 'l2',
				data: { schoolId: 's2', title: 'two' },
			})
			return { harness, ctx, handle }
		}

		test('membership intervals decide what a member reads, and a revoke ends it', async () => {
			const { harness, handle } = await setup()
			try {
				expect((await read(harness, 'bob')).ids).toEqual([])
				await harness.server.access.grant({ userId: 'bob', group: ['schools', 's1'], role: 'view' })
				expect((await read(harness, 'bob')).ids).toEqual(['l1'])
				await harness.server.access.grant({ userId: 'bob', group: ['schools', 's2'], role: 'view' })
				expect((await read(harness, 'bob')).ids.sort()).toEqual(['l1', 'l2'])
				const before = (await read(harness, 'bob')).response?.grantKey
				await harness.server.access.revoke({ userId: 'bob', group: ['schools', 's1'] })
				const after = await read(harness, 'bob')
				expect(after.ids).toEqual(['l2'])
				expect(after.response?.grantKey).not.toBe(before)
				// The owner reads both through the owner role.
				expect((await read(harness, 'ann')).ids.sort()).toEqual(['l1', 'l2'])
			} finally {
				await handle.done()
			}
		})

		test('a member of a group the principal left is not served that group history', async () => {
			const { harness, ctx, handle } = await setup()
			try {
				await harness.server.access.grant({ userId: 'bob', group: ['schools', 's1'], role: 'view' })
				await harness.server.access.revoke({ userId: 'bob', group: ['schools', 's1'] })
				// A write after the revoke is outside the closed interval too.
				await ctx.apply({
					collection: 'lessons',
					type: 'insert',
					recordId: 'l3',
					data: { schoolId: 's1', title: 'later' },
				})
				expect((await read(harness, 'bob')).ids).toEqual([])
			} finally {
				await handle.done()
			}
		})

		test('a revoked credential reads nothing', async () => {
			const { harness, handle } = await setup()
			try {
				await harness.server.access.grant({ userId: 'bob', group: ['schools', 's1'], role: 'view' })
				expect((await read(harness, 'bob')).status).toBe(200)
				revoked = true
				expect((await read(harness, 'bob')).status).toBe(401)
			} finally {
				revoked = false
				await handle.done()
			}
		})

		test('a record with an encrypted operation is never read through', async () => {
			const { harness, handle } = await setup()
			try {
				// Written to the store directly: the server only accepts a sealed upload from a
				// device of an end-to-end encrypted deployment, which this fixture is not.
				const sealed = makeOp('ann-node', 1, {
					type: 'update',
					collection: 'lessons',
					recordId: 'l1',
					data: null,
					encrypted: { v: 2, keyId: 'k', iv: 'aa', ciphertext: 'bb' } as never,
				})
				await handle.store.applyRemoteOperation(sealed)
				const stored = await handle.store.recordsWithEncryptedOperations?.('lessons', ['l1', 'l2'])
				if (stored === undefined) {
					// A store that cannot tell must fail closed: nothing is read through.
					const result = await read(harness, 'ann')
					expect(result.response?.results[0]?.status).toBe('unsupported')
					expect(result.ids).toEqual([])
					return
				}
				if (!stored.has('l1')) throw new Error('SEALED NOT STORED')
				const result = await read(harness, 'ann')
				// Only the sealed record is left out, and the answer says it is incomplete.
				expect(result.response?.results[0]?.status).toBe('partial')
				expect(result.response?.results[0]?.reason).toBe('encrypted-records')
				expect(result.ids).toEqual(['l2'])
				expect(JSON.stringify(result.response)).not.toContain('one')
			} finally {
				await handle.done()
			}
		})

		test('the answer matches the sync stream for the same state', async () => {
			const { harness, handle } = await setup()
			try {
				await harness.server.access.grant({ userId: 'bob', group: ['schools', 's2'], role: 'view' })
				const result = await read(harness, 'bob')
				expect(result.response?.frontier).toBe(await handle.store.getMaxDeliverySequence())
				const record = result.response?.results[0]?.records[0]
				expect(record?.values).toMatchObject({ schoolId: 's2', title: 'two' })
				expect(record?.fieldVersions.title).toBeDefined()
			} finally {
				await handle.done()
			}
		})
	})
}
