import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SqliteServerStore } from './sqlite-server-store'

function createTestOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('SqliteServerStore', () => {
	let store: SqliteServerStore

	beforeEach(() => {
		const sqlite = new Database(':memory:')
		const db = drizzle(sqlite)
		store = new SqliteServerStore(db, 'server-1')
	})

	afterEach(async () => {
		await store.close()
	})

	test('getVersionVector returns empty map initially', () => {
		const vv = store.getVersionVector()
		expect(vv.size).toBe(0)
	})

	test('getNodeId returns the provided node ID', () => {
		expect(store.getNodeId()).toBe('server-1')
	})

	test('getNodeId generates a UUID when none provided', () => {
		const sqlite = new Database(':memory:')
		const db = drizzle(sqlite)
		const autoStore = new SqliteServerStore(db)
		expect(autoStore.getNodeId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
	})

	test('materializes concurrent atomic increments to the composed sum', async () => {
		const schema = defineSchema({
			version: 1,
			collections: { counters: { fields: { count: t.number().default(0) } } },
		})
		await store.setSchema(schema)

		// Insert base, then three concurrent increments (distinct nodes, each read the
		// base value 0, so each carries its resolved value delta and its atomic intent).
		await store.applyRemoteOperation(
			createTestOp({
				id: 'ins',
				collection: 'counters',
				recordId: 'c1',
				type: 'insert',
				data: { count: 0 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			}),
		)
		const increment = (id: string, node: string, wall: number, delta: number): Operation =>
			createTestOp({
				id,
				nodeId: node,
				collection: 'counters',
				recordId: 'c1',
				type: 'update',
				data: { count: delta },
				previousData: { count: 0 },
				atomicOps: { count: { type: 'increment', value: delta } },
				timestamp: { wallTime: wall, logical: 0, nodeId: node },
			})
		await store.applyRemoteOperation(increment('a', 'node-a', 1001, 5))
		await store.applyRemoteOperation(increment('b', 'node-b', 1002, 3))
		await store.applyRemoteOperation(increment('c', 'node-c', 1003, 2))

		// Persisted, then rebuilt from the log through HLC-ordered replay: 0 + 5 + 3 + 2.
		const record = await store.findRecord('counters', 'c1')
		expect(record?.count).toBe(10)

		// The atomic intent round-trips through serialization (not just the resolved data).
		const [roundTripped] = await store.getOperationRange('node-b', 1, 1)
		expect(roundTripped?.atomicOps).toEqual({ count: { type: 'increment', value: 3 } })
	})

	test('applyRemoteOperation stores the operation and advances version vector', async () => {
		const op = createTestOp({ nodeId: 'node-a', sequenceNumber: 1 })

		const result = await store.applyRemoteOperation(op)

		expect(result).toBe('applied')
		expect(store.getVersionVector().get('node-a')).toBe(1)
		expect(await store.getOperationCount()).toBe(1)
	})

	test('applyRemoteOperation deduplicates by operation id', async () => {
		const op = createTestOp({ id: 'op-1', sequenceNumber: 1 })

		expect(await store.applyRemoteOperation(op)).toBe('applied')
		expect(await store.applyRemoteOperation(op)).toBe('duplicate')
		expect(await store.getOperationCount()).toBe(1)
	})

	test('version vector advances to highest sequence number per node', async () => {
		const op1 = createTestOp({ id: 'op-1', nodeId: 'node-a', sequenceNumber: 1 })
		const op3 = createTestOp({ id: 'op-3', nodeId: 'node-a', sequenceNumber: 3 })
		const op2 = createTestOp({ id: 'op-2', nodeId: 'node-a', sequenceNumber: 2 })

		await store.applyRemoteOperation(op1)
		await store.applyRemoteOperation(op3)
		await store.applyRemoteOperation(op2)

		// Should be 3, not 2 (max wins)
		expect(store.getVersionVector().get('node-a')).toBe(3)
	})

	test('getOperationRange filters by nodeId and sequence range', async () => {
		await store.applyRemoteOperation(createTestOp({ id: 'a1', nodeId: 'a', sequenceNumber: 1 }))
		await store.applyRemoteOperation(createTestOp({ id: 'a2', nodeId: 'a', sequenceNumber: 2 }))
		await store.applyRemoteOperation(createTestOp({ id: 'a3', nodeId: 'a', sequenceNumber: 3 }))
		await store.applyRemoteOperation(createTestOp({ id: 'b1', nodeId: 'b', sequenceNumber: 1 }))

		const range = await store.getOperationRange('a', 2, 3)
		expect(range).toHaveLength(2)
		expect(range[0]?.id).toBe('a2')
		expect(range[1]?.id).toBe('a3')
	})

	test('getOperationRange returns results sorted by sequenceNumber', async () => {
		// Insert out of order
		await store.applyRemoteOperation(createTestOp({ id: 'a3', nodeId: 'a', sequenceNumber: 3 }))
		await store.applyRemoteOperation(createTestOp({ id: 'a1', nodeId: 'a', sequenceNumber: 1 }))
		await store.applyRemoteOperation(createTestOp({ id: 'a2', nodeId: 'a', sequenceNumber: 2 }))

		const range = await store.getOperationRange('a', 1, 3)
		expect(range.map((op) => op.sequenceNumber)).toEqual([1, 2, 3])
	})

	test('getOperationRange returns empty array for unknown node', async () => {
		const range = await store.getOperationRange('unknown', 1, 10)
		expect(range).toEqual([])
	})

	test('getOperationCount returns total number of operations', async () => {
		expect(await store.getOperationCount()).toBe(0)

		await store.applyRemoteOperation(createTestOp({ id: 'op-1' }))
		await store.applyRemoteOperation(createTestOp({ id: 'op-2' }))
		expect(await store.getOperationCount()).toBe(2)
	})

	test('close prevents further operations', async () => {
		await store.close()

		await expect(store.applyRemoteOperation(createTestOp())).rejects.toThrow(
			'SqliteServerStore is closed',
		)
		await expect(store.getOperationRange('a', 1, 1)).rejects.toThrow('SqliteServerStore is closed')
		await expect(store.getOperationCount()).rejects.toThrow('SqliteServerStore is closed')
	})

	test('preserves all operation fields through serialization round-trip', async () => {
		const op = createTestOp({
			id: 'roundtrip-1',
			nodeId: 'node-x',
			type: 'update',
			collection: 'projects',
			recordId: 'rec-42',
			data: { title: 'updated', priority: 'high' },
			previousData: { title: 'original', priority: 'low' },
			timestamp: { wallTime: 999999, logical: 7, nodeId: 'node-x' },
			sequenceNumber: 42,
			causalDeps: ['dep-1', 'dep-2'],
			schemaVersion: 3,
		})

		await store.applyRemoteOperation(op)

		const [retrieved] = await store.getOperationRange('node-x', 42, 42)
		expect(retrieved).toBeDefined()
		expect(retrieved?.id).toBe(op.id)
		expect(retrieved?.nodeId).toBe(op.nodeId)
		expect(retrieved?.type).toBe(op.type)
		expect(retrieved?.collection).toBe(op.collection)
		expect(retrieved?.recordId).toBe(op.recordId)
		expect(retrieved?.data).toEqual(op.data)
		expect(retrieved?.previousData).toEqual(op.previousData)
		expect(retrieved?.timestamp).toEqual(op.timestamp)
		expect(retrieved?.sequenceNumber).toBe(op.sequenceNumber)
		expect(retrieved?.causalDeps).toEqual(op.causalDeps)
		expect(retrieved?.schemaVersion).toBe(op.schemaVersion)
	})

	test('handles delete operations with null data', async () => {
		const op = createTestOp({
			id: 'del-1',
			type: 'delete',
			data: null,
			previousData: null,
		})

		await store.applyRemoteOperation(op)

		const [retrieved] = await store.getOperationRange('node-a', 1, 1)
		expect(retrieved?.type).toBe('delete')
		expect(retrieved?.data).toBeNull()
		expect(retrieved?.previousData).toBeNull()
	})

	test('tracks multiple nodes in version vector', async () => {
		await store.applyRemoteOperation(
			createTestOp({ id: 'a1', nodeId: 'node-a', sequenceNumber: 5 }),
		)
		await store.applyRemoteOperation(
			createTestOp({ id: 'b1', nodeId: 'node-b', sequenceNumber: 3 }),
		)
		await store.applyRemoteOperation(
			createTestOp({ id: 'c1', nodeId: 'node-c', sequenceNumber: 1 }),
		)

		const vv = store.getVersionVector()
		expect(vv.size).toBe(3)
		expect(vv.get('node-a')).toBe(5)
		expect(vv.get('node-b')).toBe(3)
		expect(vv.get('node-c')).toBe(1)
	})

	test('materializes a reserved-word collection with a camelCase field', async () => {
		// `order` is a SQL keyword and `answerText` is camelCase — both only work
		// because every generated identifier is quoted. This proves the fix holds
		// on the server materialization path, not just the client store.
		const sqlite = new Database(':memory:')
		const db = drizzle(sqlite)
		const s = new SqliteServerStore(db, 'server-idsafe')
		const schema = defineSchema({
			version: 1,
			collections: { order: { fields: { answerText: t.string() } } },
		})
		await s.setSchema(schema)

		await s.applyRemoteOperation({
			id: 'op-idsafe-1',
			nodeId: 'node-a',
			type: 'insert',
			collection: 'order',
			recordId: 'rec-order-1',
			data: { answerText: 'hello' },
			previousData: null,
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		})

		const rows = await s.queryCollection('order')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.answerText).toBe('hello')

		const found = await s.findRecord('order', 'rec-order-1')
		expect(found?.answerText).toBe('hello')

		await s.close()
	})
})
