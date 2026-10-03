import { type Operation, defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Real-Postgres contract for operation scope snapshots (RT-14, RT-15) and blob
 * ownership (RT-11): snapshots captured at apply time and backfilled from the log on
 * migration, and a first blob claim that has exactly one winner across instances.
 * Set KORA_PG_TEST_URL to run.
 */
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), owner: t.string() } } },
})

let seq = 0
function op(overrides: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `pg-snap-${Date.now()}-${seq}`,
		nodeId: 'n',
		type: 'insert',
		collection: 'todos',
		recordId: 'todo-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'n' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		// Version 2: previousData is only a hint (a version-1 update would read it as a clear).
		hashVersion: 2,
		...overrides,
	}
}

describe.skipIf(!PG_URL)('Postgres scope snapshots and blob owners', () => {
	let client: ReturnType<typeof postgres>
	const PG_SCHEMA = 'kora_test_scope_snapshot'

	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 6, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		await client.end()
	})

	beforeEach(async () => {
		await client.unsafe(
			'DROP TABLE IF EXISTS todos, operations, sync_state, node_claims, blob_owners, delivery_counter CASCADE',
		)
	})

	test('snapshots are captured at apply time and backfilled on migration', async () => {
		const store = new PostgresServerStore(drizzle(client), 'server-pg')
		const legacy = op({ data: { title: 'draft', owner: 'bob' } })
		// Written before the schema (and thus snapshots) existed on this store.
		await store.applyRemoteOperation(legacy)
		await store.setSchema(schema)
		const edit = op({ type: 'update', data: { title: 'x' }, previousData: { owner: 'alice' } })
		const transfer = op({ type: 'update', data: { owner: 'alice' } })
		await store.applyRemoteOperation(edit)
		await store.applyRemoteOperation(transfer)
		const snapshots = await store.getOperationScopeSnapshots([legacy.id, edit.id, transfer.id])
		expect(snapshots.get(legacy.id)?.post?.owner).toBe('bob')
		expect(snapshots.get(edit.id)?.pre?.owner).toBe('bob')
		expect(snapshots.get(transfer.id)?.post?.owner).toBe('alice')
		const delivered = await store.getOperationsAfterDelivery(0, 10)
		expect(delivered.map((d) => d.scopeSnapshot?.post?.owner)).toEqual(['bob', 'bob', 'alice'])
		await store.close()
	})

	test('concurrent first claims of a blob hash have exactly one winner', async () => {
		const a = new PostgresServerStore(drizzle(client), 'server-a')
		const b = new PostgresServerStore(drizzle(client), 'server-b')
		await a.setSchema(schema)
		await b.setSchema(schema)
		const hash = 'a'.repeat(64)
		const results = await Promise.all([
			a.claimBlobIfUnowned(hash, 'alice'),
			b.claimBlobIfUnowned(hash, 'bob'),
			a.claimBlobIfUnowned(hash, 'carol'),
		])
		expect(results.filter(Boolean)).toHaveLength(1)
		await b.recordBlobOwner(hash, 'dave')
		const owners = (await a.getBlobOwners([hash])).get(hash) ?? []
		expect(owners).toHaveLength(2)
		expect(owners).toContain('dave')
		await a.close()
		await b.close()
	})
})
