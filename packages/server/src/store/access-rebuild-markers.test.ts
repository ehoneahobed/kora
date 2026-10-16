/**
 * Membership index rebuilds across instances of one database: every rebuild keeps its
 * own marker, a rebuild finishing never clears another's, and an instance learns of
 * another's restore at its next write. Postgres runs with KORA_PG_TEST_URL.
 */
import type { Operation, OperationTransform } from '@korajs/core'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
	},
})

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

const promoteEditors: OperationTransform = {
	fromVersion: 1,
	toVersion: 1,
	transform: (operation) => operation,
}

describe('memory store: a re-fold that failed part-way is retried in full', () => {
	test('retrying the same transforms rebuilds the index', async () => {
		const store = new MemoryServerStore('server-node')
		const toV2 = (operation: Operation): Operation => ({ ...operation, schemaVersion: 2 })
		await store.setSchema(
			{ ...schema, version: 2 },
			{ operationTransforms: [{ fromVersion: 1, toVersion: 2, transform: toV2 }] },
		)
		await store.applyRemoteOperation(
			op({
				collection: 'members',
				recordId: 'm1',
				data: { userId: 'u', group: 'documents:d', role: 'view' },
			}),
		)
		let fail = true
		const flaky: OperationTransform = {
			fromVersion: 1,
			toVersion: 2,
			transform: (operation) => {
				if (fail) throw new Error('transform failed')
				return toV2(operation)
			},
		}
		await expect(store.setOperationTransforms([flaky])).rejects.toThrow('transform failed')
		expect(store.isAccessIndexReady()).toBe(false)
		fail = false
		await store.setOperationTransforms([flaky])
		expect(store.isAccessIndexReady()).toBe(true)
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL
const clients: ReturnType<typeof postgres>[] = []

async function sharedPostgres(): Promise<[PostgresServerStore, PostgresServerStore]> {
	const name = `kora_markers_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
	const admin = postgres(PG_URL ?? '', { max: 1 })
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	await admin.end()
	const make = async (instance: string): Promise<PostgresServerStore> => {
		const client = postgres(PG_URL ?? '', { max: 4, connection: { search_path: name } })
		clients.push(client)
		const store = new PostgresServerStore(drizzle(client), 'server-node', undefined, {
			instanceId: instance,
		})
		await store.setSchema(schema)
		return store
	}
	const a = await make('a')
	return [a, await make('b')]
}

describe.skipIf(!PG_URL)('postgres: rebuilds on several instances', () => {
	afterAll(async () => {
		await Promise.all(clients.map((client) => client.end()))
	})

	test("a rebuild finishing never clears another instance's marker", async () => {
		const [a, b] = await sharedPostgres()
		let release = (): void => {}
		const paused = new Promise<void>((resolve) => {
			release = resolve
		})
		const rebuild = a as unknown as { reconcileMembershipIndex: () => Promise<void> }
		const original = rebuild.reconcileMembershipIndex.bind(a)
		rebuild.reconcileMembershipIndex = async () => {
			await paused
			return original()
		}
		// Instance a re-folds (its marker is written) and waits before its index rebuild.
		const first = a.setOperationTransforms([promoteEditors])
		await new Promise((resolve) => setTimeout(resolve, 200))
		// Instance b completes a rebuild of its own meanwhile: a's marker must stay.
		await b.setOperationTransforms([])
		expect((await b.getAccessIndexState()).rebuilding).toBe(true)
		expect(b.isAccessIndexReady()).toBe(false)
		release()
		await first
		expect((await b.getAccessIndexState()).rebuilding).toBe(false)
		expect(b.isAccessIndexReady()).toBe(true)
		expect(a.isAccessIndexReady()).toBe(true)
	})

	test("an instance sees another's restore at its next write, before any poll", async () => {
		const [a, b] = await sharedPostgres()
		const before = b.accessIndexGeneration()
		await a.importBackup(await a.exportBackup(), false)
		const after = (await a.getAccessIndexState()).generation
		expect(after).not.toBe(before)
		// b has not polled: its view is stale until a write takes the counter lock.
		expect(b.accessIndexGeneration()).toBe(before)
		await b.applyRemoteOperation(
			op({
				collection: 'members',
				recordId: 'm9',
				data: { userId: 'z', group: 'documents:x', role: 'view' },
			}),
		)
		expect(b.accessIndexGeneration()).toBe(after)
	})
})
