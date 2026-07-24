import { createRequire } from 'node:module'
import type { Operation } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { SqliteServerStore, createSqliteServerStore } from './sqlite-server-store'

// better-sqlite3 is a native CJS addon; load it (and its drizzle adapter) through a
// CJS require so this works in the ESM test runtime, matching the store's own loader.
const esmRequire = createRequire(import.meta.url)

/**
 * Delivery-sequence substrate for the gap-free server->client watermark. These tests
 * pin the guarantees the watermark relies on, across every server store:
 *   1. Every stored operation is assigned a strictly increasing delivery sequence.
 *   2. getOperationsAfterDelivery returns exactly the operations above a cursor, in
 *      delivery order, honoring the limit.
 *   3. Pre-column operations (written before the delivery_seq migration) are backfilled
 *      deterministically so their order is stable across restarts.
 *   4. (Postgres only) Concurrent commits across instances get monotonic delivery
 *      sequences whose order equals visibility order, so a `> watermark` scan can never
 *      skip an operation that later becomes visible below the cursor.
 */

function op(overrides: Partial<Operation> = {}): Operation {
	const rand = Math.random().toString(36).slice(2)
	return {
		id: `op-${rand}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${rand}`,
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

/** Contract every ServerStore must satisfy for the delivery watermark to hold. */
function runDeliveryContract(name: string, makeStore: () => Promise<ServerStore> | ServerStore) {
	describe(`delivery sequence contract: ${name}`, () => {
		test('assigns strictly increasing delivery sequences in insertion order', async () => {
			const store = await makeStore()
			const a = op()
			const b = op()
			const c = op()
			await store.applyRemoteOperation(a)
			await store.applyRemoteOperation(b)
			await store.applyRemoteOperation(c)

			const all = await store.getOperationsAfterDelivery(0, 100)
			expect(all.map((d) => d.operation.id)).toEqual([a.id, b.id, c.id])
			const seqs = all.map((d) => d.deliverySequence)
			expect(seqs[0]).toBeLessThan(seqs[1] as number)
			expect(seqs[1]).toBeLessThan(seqs[2] as number)
			expect(await store.getMaxDeliverySequence()).toBe(seqs[2])
			await store.close()
		})

		test('getOperationsAfterDelivery returns only operations above the cursor', async () => {
			const store = await makeStore()
			const a = op()
			const b = op()
			const c = op()
			for (const o of [a, b, c]) await store.applyRemoteOperation(o)

			const all = await store.getOperationsAfterDelivery(0, 100)
			const afterFirst = await store.getOperationsAfterDelivery(all[0]?.deliverySequence ?? 0, 100)
			expect(afterFirst.map((d) => d.operation.id)).toEqual([b.id, c.id])

			const afterAllSeq = all[all.length - 1]?.deliverySequence ?? 0
			expect(await store.getOperationsAfterDelivery(afterAllSeq, 100)).toHaveLength(0)
			await store.close()
		})

		test('honors the limit while preserving delivery order', async () => {
			const store = await makeStore()
			const ops = [op(), op(), op(), op(), op()]
			for (const o of ops) await store.applyRemoteOperation(o)

			const firstTwo = await store.getOperationsAfterDelivery(0, 2)
			expect(firstTwo.map((d) => d.operation.id)).toEqual([ops[0]?.id, ops[1]?.id])

			const nextTwo = await store.getOperationsAfterDelivery(firstTwo[1]?.deliverySequence ?? 0, 2)
			expect(nextTwo.map((d) => d.operation.id)).toEqual([ops[2]?.id, ops[3]?.id])
			await store.close()
		})

		test('a duplicate does not advance the delivery stream twice', async () => {
			const store = await makeStore()
			const a = op({ id: 'dup-1' })
			await store.applyRemoteOperation(a)
			await store.applyRemoteOperation(a) // duplicate id

			const all = await store.getOperationsAfterDelivery(0, 100)
			expect(all).toHaveLength(1)
			expect(all[0]?.operation.id).toBe('dup-1')
			await store.close()
		})
	})
}

runDeliveryContract('memory', () => new MemoryServerStore('server-mem'))
runDeliveryContract('sqlite', () => createSqliteServerStore({ filename: ':memory:' }))

/**
 * Backup export must preserve delivery (commit) order, not per-node sequenceNumber order.
 * A dependent with a LOWER sequenceNumber than its dependency (a cross-node causal edge)
 * must still export after its dependency, so a restored store reassigns delivery
 * sequences causally and a resumed client never receives the dependent first.
 */
function runBackupOrderContract(name: string, makeStore: () => Promise<ServerStore> | ServerStore) {
	test(`backup preserves delivery order across a cross-node dependency: ${name}`, async () => {
		const source = await makeStore()
		// Delivery order 1,2 = [dep, dependent]. But the dependent has the LOWER
		// sequenceNumber (1 < 5), so a sequenceNumber-ordered export would emit it first.
		const dep = op({ id: 'dep', nodeId: 'node-x', sequenceNumber: 5 })
		const dependent = op({
			id: 'dependent',
			nodeId: 'node-y',
			sequenceNumber: 1,
			causalDeps: ['dep'],
		})
		await source.applyRemoteOperation(dep)
		await source.applyRemoteOperation(dependent)
		const backup = await source.exportBackup()
		await source.close()

		const restored = await makeStore()
		await restored.importBackup(backup, false)
		const delivered = await restored.getOperationsAfterDelivery(0, 100)
		// The dependency must come first in the restored delivery order.
		expect(delivered.map((d) => d.operation.id)).toEqual(['dep', 'dependent'])
		await restored.close()
	})
}

runBackupOrderContract('memory', () => new MemoryServerStore())
runBackupOrderContract('sqlite', () => createSqliteServerStore({ filename: ':memory:' }))

// --- SQLite backfill of pre-column rows ---

describe('sqlite delivery-seq backfill', () => {
	test('backfills rows written before the column existed, ordered deterministically', () => {
		const Database = esmRequire('better-sqlite3')
		const { drizzle: drizzleSqlite } = esmRequire('drizzle-orm/better-sqlite3')
		const sqlite = new Database(':memory:')
		// Simulate a legacy operations table with no delivery_seq column.
		sqlite.exec(`
			CREATE TABLE operations (
				id TEXT PRIMARY KEY, node_id TEXT NOT NULL, type TEXT NOT NULL,
				collection TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT, previous_data TEXT,
				atomic_ops TEXT, wall_time INTEGER NOT NULL, logical INTEGER NOT NULL,
				timestamp_node_id TEXT NOT NULL, sequence_number INTEGER NOT NULL,
				causal_deps TEXT NOT NULL DEFAULT '[]', schema_version INTEGER NOT NULL,
				received_at INTEGER NOT NULL
			);
		`)
		// Insert three legacy rows out of received order to prove the deterministic sort.
		const insert = sqlite.prepare(`
			INSERT INTO operations (id, node_id, type, collection, record_id, wall_time, logical,
				timestamp_node_id, sequence_number, causal_deps, schema_version, received_at)
			VALUES (?, 'n', 'insert', 'todos', ?, 1000, 0, 'n', 1, '[]', 1, ?)
		`)
		insert.run('legacy-c', 'rc', 300)
		insert.run('legacy-a', 'ra', 100)
		insert.run('legacy-b', 'rb', 200)

		// Constructing the store runs ensureTables, which adds the column and backfills.
		const store = new SqliteServerStore(drizzleSqlite(sqlite), 'server-sqlite')

		const rows = sqlite
			.prepare('SELECT id, delivery_seq FROM operations ORDER BY delivery_seq')
			.all() as { id: string; delivery_seq: number }[]
		expect(rows.map((r) => r.id)).toEqual(['legacy-a', 'legacy-b', 'legacy-c'])
		expect(rows.map((r) => r.delivery_seq)).toEqual([1, 2, 3])

		// A new operation continues above the backfilled maximum.
		return store.applyRemoteOperation(op({ id: 'fresh' })).then(async () => {
			const fresh = sqlite
				.prepare('SELECT delivery_seq FROM operations WHERE id = ?')
				.get('fresh') as { delivery_seq: number }
			expect(fresh.delivery_seq).toBe(4)
			await store.close()
		})
	})
})

// --- Postgres: commit-order assignment across concurrent instances ---

const PG_URL = process.env.KORA_PG_TEST_URL
const PG_SCHEMA = 'kora_test_delivery'

describe.skipIf(!PG_URL)('postgres delivery sequence', () => {
	let admin: ReturnType<typeof postgres>

	beforeAll(async () => {
		admin = postgres(PG_URL as string, { max: 1, connection: { search_path: PG_SCHEMA } })
		await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		await admin.end()
	})

	beforeEach(async () => {
		await admin.unsafe('DROP TABLE IF EXISTS operations, sync_state, delivery_counter CASCADE')
	})

	function makeStore(nodeId: string): PostgresServerStore {
		const client = postgres(PG_URL as string, { max: 6, connection: { search_path: PG_SCHEMA } })
		return new PostgresServerStore(drizzle(client), nodeId)
	}

	test('assigns monotonic delivery sequences with no visibility gap under concurrency', async () => {
		// Two instances sharing one database append concurrently. The counter row locked
		// inside each append transaction forces delivery order to equal commit order, so a
		// scan from 0 sees every operation exactly once in a strictly increasing sequence.
		const a = makeStore('server-a')
		const b = makeStore('server-b')
		await a.getMaxDeliverySequence() // await ready

		const N = 40
		const applies: Promise<unknown>[] = []
		for (let i = 0; i < N; i++) {
			const store = i % 2 === 0 ? a : b
			applies.push(
				store.applyRemoteOperation(op({ id: `c-${i}`, nodeId: i % 2 === 0 ? 'a' : 'b' })),
			)
		}
		await Promise.all(applies)

		const all = await a.getOperationsAfterDelivery(0, 1000)
		expect(all).toHaveLength(N)
		// Strictly increasing, contiguous 1..N (single-schema fresh table).
		const seqs = all.map((d) => d.deliverySequence)
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number)
		}
		expect(new Set(all.map((d) => d.operation.id)).size).toBe(N)
		await a.close()
		await b.close()
	})

	test('backup export/import preserves delivery order across a cross-node dependency', async () => {
		const source = makeStore('server-src')
		const dep = op({ id: 'dep', nodeId: 'node-x', sequenceNumber: 5 })
		const dependent = op({
			id: 'dependent',
			nodeId: 'node-y',
			sequenceNumber: 1,
			causalDeps: ['dep'],
		})
		await source.applyRemoteOperation(dep)
		await source.applyRemoteOperation(dependent)
		const backup = await source.exportBackup()

		// Wipe and restore into the same schema.
		await admin.unsafe('DROP TABLE IF EXISTS operations, sync_state, delivery_counter CASCADE')
		const restored = makeStore('server-restored')
		await restored.importBackup(backup, false)
		const delivered = await restored.getOperationsAfterDelivery(0, 100)
		expect(delivered.map((d) => d.operation.id)).toEqual(['dep', 'dependent'])
		await source.close()
		await restored.close()
	})
})
