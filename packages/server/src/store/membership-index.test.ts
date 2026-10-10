/**
 * The membership index contract (beta.15 access step 3), on every server store: the
 * store keeps one interval per membership, opened and closed at the delivery sequence
 * of the operation that changed it, in the same transaction as that operation.
 * Postgres runs with KORA_PG_TEST_URL.
 */
import type { Operation, OperationTransform, SchemaDefinition } from '@korajs/core'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import type { MembershipInterval } from '../access/membership-index'
import { UplinkAuthorizationError } from '../scopes/server-scope-filter'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const accessSchema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
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
			access: { read: memberOfKey('group') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
		notes: { fields: { body: t.string(), ownerId: t.string().optional() } },
	},
})

/** The same collections without access rules (a database from before the rules). */
const plainSchema = defineSchema({
	version: 1,
	collections: {
		members: {
			fields: {
				userId: t.string(),
				group: t.string(),
				role: t.string(),
				expiresAt: t.timestamp().optional(),
			},
		},
		documents: { fields: { title: t.string(), ownerId: t.string() } },
		notes: { fields: { body: t.string() } },
	},
})

/** The access schema with `notes` added as a group collection (a rules deploy). */
const withNoteGroups = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: {
			documents: { owner: 'ownerId', role: 'manage' },
			notes: { owner: 'ownerId', role: 'manage' },
		},
	},
	collections: {
		members: {
			fields: {
				userId: t.string(),
				group: t.string(),
				role: t.string(),
				expiresAt: t.timestamp().optional(),
			},
			access: { read: memberOfKey('group') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
		notes: {
			fields: { body: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id') },
		},
	},
})

const accessSchemaV2: SchemaDefinition = { ...accessSchema, version: 2 }

/** v1 -> v2: every 'edit' membership becomes 'manage'. */
const promoteEditors: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (operation) =>
		operation.collection === 'members' && operation.data?.role === 'edit'
			? { ...operation, schemaVersion: 2, data: { ...operation.data, role: 'manage' } }
			: { ...operation, schemaVersion: 2 },
}

let seq = 0
function op(input: Partial<Operation> & Pick<Operation, 'collection' | 'recordId'>): Operation {
	seq += 1
	return {
		id: `op-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId: 'server-node',
		type: 'insert',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'server-node' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...input,
	}
}

async function deliverySeqOf(store: ServerStore, id: string): Promise<number> {
	const all = await store.getOperationsAfterDelivery(0, 10_000)
	const found = all.find((entry) => entry.operation.id === id)
	if (!found) throw new Error(`operation ${id} not stored`)
	return found.deliverySequence
}

function strip(intervals: MembershipInterval[]): Omit<MembershipInterval, 'userId'>[] {
	return intervals.map(({ userId: _u, ...rest }) => rest)
}

type Factory = (schema: SchemaDefinition) => Promise<ServerStore>

function runMembershipIndexContract(name: string, makeStore: Factory): void {
	describe(`membership index: ${name}`, () => {
		async function store(): Promise<ServerStore> {
			return makeStore(accessSchema)
		}

		test('a membership opens at its delivery sequence, changes role in place, closes on delete', async () => {
			const s = await store()
			const grant = op({
				collection: 'members',
				recordId: 'm1',
				data: { userId: 'ann', group: 'documents:d1', role: 'view' },
			})
			await s.applyRemoteOperation(grant)
			const joined = await deliverySeqOf(s, grant.id)
			expect(strip((await s.getMembershipIntervals?.('ann')) ?? [])).toEqual([
				{
					group: 'documents:d1',
					source: 'membership',
					recordId: 'm1',
					role: 'view',
					expiresAt: null,
					joinedSeq: joined,
					leftSeq: null,
				},
			])

			await s.applyRemoteOperation(
				op({
					type: 'update',
					collection: 'members',
					recordId: 'm1',
					data: { role: 'edit' },
					previousData: { role: 'view' },
					causalDeps: [grant.id],
				}),
			)
			const afterRole = (await s.getMembershipIntervals?.('ann')) ?? []
			expect(afterRole).toHaveLength(1)
			expect(afterRole[0]).toMatchObject({ role: 'edit', joinedSeq: joined, leftSeq: null })

			const revoke = op({ type: 'delete', collection: 'members', recordId: 'm1', data: null })
			await s.applyRemoteOperation(revoke)
			const left = await deliverySeqOf(s, revoke.id)
			expect((await s.getMembershipIntervals?.('ann'))?.[0]).toMatchObject({
				joinedSeq: joined,
				leftSeq: left,
			})

			// Re-joining appends a new interval.
			const rejoin = op({
				type: 'update',
				collection: 'members',
				recordId: 'm1',
				data: { role: 'view' },
				timestamp: { wallTime: 9_000_000, logical: 0, nodeId: 'server-node' },
			})
			await s.applyRemoteOperation(rejoin)
			const intervals = (await s.getMembershipIntervals?.('ann')) ?? []
			expect(intervals).toHaveLength(2)
			expect(intervals[1]).toMatchObject({
				joinedSeq: await deliverySeqOf(s, rejoin.id),
				leftSeq: null,
				role: 'view',
			})
		})

		test('a group record makes its owner a member; a server-side transfer moves it', async () => {
			const s = await store()
			const create = op({
				collection: 'documents',
				recordId: 'd1',
				data: { title: 'Doc', ownerId: 'ann' },
			})
			await s.applyRemoteOperation(create)
			expect(strip((await s.getMembershipIntervals?.('ann')) ?? [])).toEqual([
				{
					group: 'documents:d1',
					source: 'owner',
					recordId: 'd1',
					role: 'manage',
					expiresAt: null,
					joinedSeq: await deliverySeqOf(s, create.id),
					leftSeq: null,
				},
			])

			// An edit that leaves the owner alone changes nothing.
			await s.applyRemoteOperation(
				op({
					type: 'update',
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'Doc 2' },
					previousData: { title: 'Doc' },
				}),
			)
			expect((await s.getMembershipIntervals?.('ann')) ?? []).toHaveLength(1)

			const transfer = op({
				type: 'update',
				collection: 'documents',
				recordId: 'd1',
				data: { ownerId: 'bob' },
				previousData: { ownerId: 'ann' },
			})
			await s.applyRemoteOperation(transfer)
			const at = await deliverySeqOf(s, transfer.id)
			expect((await s.getMembershipIntervals?.('ann'))?.[0]?.leftSeq).toBe(at)
			expect((await s.getMembershipIntervals?.('bob'))?.[0]).toMatchObject({
				source: 'owner',
				joinedSeq: at,
				leftSeq: null,
			})

			// Deleting the group keeps its memberships (a restore brings it back).
			await s.applyRemoteOperation(
				op({ type: 'delete', collection: 'documents', recordId: 'd1', data: null }),
			)
			expect((await s.getMembershipIntervals?.('bob'))?.[0]?.leftSeq).toBeNull()
		})

		test('expiry is kept on the interval; other collections and duplicates change nothing', async () => {
			const s = await store()
			const grant = op({
				collection: 'members',
				recordId: 'm2',
				data: { userId: 'cat', group: 'documents:d9', role: 'view', expiresAt: 5_000 },
			})
			await s.applyRemoteOperation(grant)
			expect(await s.applyRemoteOperation(grant)).toBe('duplicate')
			await s.applyRemoteOperation(op({ collection: 'notes', recordId: 'n1', data: { body: 'x' } }))
			const intervals = (await s.getMembershipIntervals?.('cat')) ?? []
			expect(intervals).toHaveLength(1)
			expect(intervals[0]).toMatchObject({ expiresAt: 5_000, leftSeq: null })
		})

		test('a refused write leaves the index untouched', async () => {
			const s = await store()
			await expect(
				s.applyRemoteOperation(
					op({
						collection: 'members',
						recordId: 'm3',
						data: { userId: 'dan', group: 'documents:d1', role: 'manage' },
					}),
					{
						authorize: () => ({ allowed: false, code: 'SCOPE_VIOLATION', message: 'no' }),
					},
				),
			).rejects.toBeInstanceOf(UplinkAuthorizationError)
			expect((await s.getMembershipIntervals?.('dan')) ?? []).toEqual([])
		})

		test('the first access schema builds the index from existing records, held from the start', async () => {
			const s = await makeStore(plainSchema)
			await s.applyRemoteOperation(
				op({
					collection: 'members',
					recordId: 'm4',
					data: { userId: 'eve', group: 'documents:d1', role: 'view' },
				}),
			)
			await s.applyRemoteOperation(
				op({ collection: 'documents', recordId: 'd4', data: { title: 'T', ownerId: 'eve' } }),
			)
			expect((await s.getMembershipIntervals?.('eve')) ?? []).toEqual([])
			await s.setSchema(accessSchema, { accessRulesEnforced: true })
			const intervals = (await s.getMembershipIntervals?.('eve')) ?? []
			expect(intervals.map((i) => [i.source, i.group, i.joinedSeq, i.leftSeq]).sort()).toEqual([
				['membership', 'documents:d1', 0, null],
				['owner', 'documents:d4', 0, null],
			])
		})

		test('a replace-mode backup restore rebuilds the index from the restored records', async () => {
			const source = await store()
			await source.applyRemoteOperation(
				op({
					collection: 'members',
					recordId: 'm5',
					data: { userId: 'fay', group: 'documents:d2', role: 'edit' },
				}),
			)
			const backup = await source.exportBackup()
			const restored = await store()
			await restored.importBackup(backup, false)
			expect((await restored.getMembershipIntervals?.('fay'))?.[0]).toMatchObject({
				group: 'documents:d2',
				role: 'edit',
				joinedSeq: 0,
				leftSeq: null,
			})
		})

		test('restoring a deleted group under a new owner moves the owner membership', async () => {
			const s = await store()
			await s.applyRemoteOperation(
				op({ collection: 'documents', recordId: 'g1', data: { title: 'T', ownerId: 'ann' } }),
			)
			await s.applyRemoteOperation(
				op({ type: 'delete', collection: 'documents', recordId: 'g1', data: null }),
			)
			const restore = op({
				type: 'update',
				collection: 'documents',
				recordId: 'g1',
				data: { ownerId: 'bob' },
				timestamp: { wallTime: 9_500_000, logical: 0, nodeId: 'server-node' },
			})
			await s.applyRemoteOperation(restore)
			const at = await deliverySeqOf(s, restore.id)
			expect((await s.getMembershipIntervals?.('ann'))?.[0]?.leftSeq).toBe(at)
			expect((await s.getMembershipIntervals?.('bob'))?.[0]).toMatchObject({
				joinedSeq: at,
				leftSeq: null,
			})
		})

		test('a rules deploy that adds a group collection keeps existing joinedSeq', async () => {
			const s = await store()
			const grant = op({
				collection: 'members',
				recordId: 'm6',
				data: { userId: 'gus', group: 'documents:d1', role: 'view' },
			})
			await s.applyRemoteOperation(grant)
			const joined = await deliverySeqOf(s, grant.id)
			await s.applyRemoteOperation(
				op({ collection: 'notes', recordId: 'n9', data: { body: 'x', ownerId: 'gus' } }),
			)
			await s.setSchema(withNoteGroups, { accessRulesEnforced: true })
			const intervals = (await s.getMembershipIntervals?.('gus')) ?? []
			expect(intervals.find((i) => i.source === 'membership')?.joinedSeq).toBe(joined)
			// The newly indexed group collection is backfilled from the start.
			expect(intervals.find((i) => i.source === 'owner')).toMatchObject({
				group: 'notes:n9',
				joinedSeq: 0,
			})
		})

		test('a re-fold that changes a role (transforms) updates the open interval', async () => {
			const s = await store()
			await s.applyRemoteOperation(
				op({
					collection: 'members',
					recordId: 'm7',
					data: { userId: 'hal', group: 'documents:d1', role: 'edit' },
				}),
			)
			const joined = (await s.getMembershipIntervals?.('hal'))?.[0]?.joinedSeq
			await s.setSchema(accessSchemaV2, {
				accessRulesEnforced: true,
				operationTransforms: [promoteEditors],
			})
			expect((await s.getMembershipIntervals?.('hal'))?.[0]).toMatchObject({
				role: 'manage',
				joinedSeq: joined,
				leftSeq: null,
			})
		})

		test('a backup restore keeps the owner of a deleted group', async () => {
			const source = await store()
			await source.applyRemoteOperation(
				op({ collection: 'documents', recordId: 'g2', data: { title: 'T', ownerId: 'ida' } }),
			)
			await source.applyRemoteOperation(
				op({ type: 'delete', collection: 'documents', recordId: 'g2', data: null }),
			)
			const restored = await store()
			await restored.importBackup(await source.exportBackup(), false)
			expect((await restored.getMembershipIntervals?.('ida'))?.[0]).toMatchObject({
				group: 'documents:g2',
				leftSeq: null,
			})
		})

		test('long user ids and group keys are indexed in full', async () => {
			const s = await store()
			const longUser = `u-${'x'.repeat(700)}`
			const longGroup = `documents:${'d'.repeat(700)}`
			await s.applyRemoteOperation(
				op({
					collection: 'members',
					recordId: 'm8',
					data: { userId: longUser, group: longGroup, role: 'view' },
				}),
			)
			expect((await s.getMembershipIntervals?.(longUser))?.[0]?.group).toBe(longGroup)
		})

		test('an access schema is still refused without the enforcement option', async () => {
			const s = await makeStore(plainSchema)
			await expect(s.setSchema(accessSchema)).rejects.toThrow(/does not enforce yet/)
		})
	})
}

runMembershipIndexContract('memory', async (schema) => {
	const store = new MemoryServerStore('server-node')
	await store.setSchema(schema, { accessRulesEnforced: true })
	return store
})

runMembershipIndexContract('sqlite', async (schema) => {
	const store = createSqliteServerStore({ filename: ':memory:', nodeId: 'server-node' })
	await store.setSchema(schema, { accessRulesEnforced: true })
	return store
})

const PG_URL = process.env.KORA_PG_TEST_URL
const pgClients: ReturnType<typeof postgres>[] = []
let pgSchemas = 0

if (PG_URL) {
	runMembershipIndexContract('postgres', async (schema) => {
		pgSchemas += 1
		const name = `kora_membership_${process.pid}_${pgSchemas}`
		const admin = postgres(PG_URL, { max: 1 })
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const client = postgres(PG_URL, { max: 4, connection: { search_path: name } })
		pgClients.push(client)
		const store = new PostgresServerStore(drizzle(client), 'server-node')
		await store.setSchema(schema, { accessRulesEnforced: true })
		return store
	})
	afterAll(async () => {
		await Promise.all(pgClients.map((client) => client.end()))
	})
}

test('memory resetForTests clears the membership index', async () => {
	const store = new MemoryServerStore('server-node')
	await store.setSchema(accessSchema, { accessRulesEnforced: true })
	await store.applyRemoteOperation(
		op({
			collection: 'members',
			recordId: 'r1',
			data: { userId: 'zed', group: 'documents:d1', role: 'view' },
		}),
	)
	store.resetForTests()
	await store.setSchema(accessSchema, { accessRulesEnforced: true })
	expect(await store.getMembershipIntervals('zed')).toEqual([])
})
