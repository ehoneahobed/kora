import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PostgresServerStore } from './postgres-server-store'

/**
 * Real-Postgres proof that atomic-op intent persists through the operation log and is
 * composed during materialization. Requires a running Postgres; set KORA_PG_TEST_URL
 * (for example `postgres://postgres@localhost:5433/postgres`) to enable.
 */
const PG_URL = process.env.KORA_PG_TEST_URL

const schema = defineSchema({
	version: 1,
	collections: { counters: { fields: { count: t.number().default(0) } } },
})

describe.skipIf(!PG_URL)('Postgres atomic-op materialization', () => {
	let client: ReturnType<typeof postgres>
	let store: PostgresServerStore

	// Isolate this file's tables in a dedicated schema so it can run in parallel with
	// other Postgres test files that also drop and recreate `operations`/`sync_state`
	// on the same database without racing each other's DDL.
	const PG_SCHEMA = 'kora_test_atomic_mat'

	beforeAll(async () => {
		client = postgres(PG_URL as string, { max: 2, connection: { search_path: PG_SCHEMA } })
		await client.unsafe(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`)
	})

	afterAll(async () => {
		await store.close()
		await client.end()
	})

	beforeEach(async () => {
		await client.unsafe('DROP TABLE IF EXISTS counters, operations, sync_state CASCADE')
		store = new PostgresServerStore(drizzle(client), 'server-pg')
		await store.setSchema(schema)
	})

	function op(overrides: Partial<Operation>): Operation {
		return {
			id: `op-${Math.random().toString(36).slice(2)}`,
			nodeId: 'node-a',
			type: 'insert',
			collection: 'counters',
			recordId: 'c1',
			data: { count: 0 },
			previousData: null,
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
			...overrides,
		}
	}

	test('composes concurrent increments and round-trips the atomic intent', async () => {
		await store.applyRemoteOperation(
			op({ id: 'ins', timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' } }),
		)
		const increment = (id: string, node: string, wall: number, delta: number): Operation =>
			op({
				id,
				nodeId: node,
				type: 'update',
				data: { count: delta },
				previousData: { count: 0 },
				atomicOps: { count: { type: 'increment', value: delta } },
				timestamp: { wallTime: wall, logical: 0, nodeId: node },
			})
		await store.applyRemoteOperation(increment('a', 'node-a', 1001, 5))
		await store.applyRemoteOperation(increment('b', 'node-b', 1002, 3))
		await store.applyRemoteOperation(increment('c', 'node-c', 1003, 2))

		const record = await store.findRecord('counters', 'c1')
		expect(record?.count).toBe(10)

		const [roundTripped] = await store.getOperationRange('node-b', 1, 1)
		expect(roundTripped?.atomicOps).toEqual({ count: { type: 'increment', value: 3 } })
	})

	test('max intent composes across the log', async () => {
		await store.applyRemoteOperation(
			op({ id: 'ins', timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' } }),
		)
		const maxOp = (id: string, node: string, wall: number, value: number): Operation =>
			op({
				id,
				nodeId: node,
				type: 'update',
				data: { count: value },
				previousData: { count: 0 },
				atomicOps: { count: { type: 'max', value } },
				timestamp: { wallTime: wall, logical: 0, nodeId: node },
			})
		await store.applyRemoteOperation(maxOp('a', 'node-a', 1001, 50))
		await store.applyRemoteOperation(maxOp('b', 'node-b', 1002, 90))
		await store.applyRemoteOperation(maxOp('c', 'node-c', 1003, 70))

		const record = await store.findRecord('counters', 'c1')
		expect(record?.count).toBe(90)
	})
})
