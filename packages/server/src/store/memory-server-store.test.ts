import type { Operation } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'

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

describe('MemoryServerStore', () => {
	test('getVersionVector returns empty map initially', () => {
		const store = new MemoryServerStore('server-1')
		const vv = store.getVersionVector()
		expect(vv.size).toBe(0)
	})

	test('getNodeId returns the provided node ID', () => {
		const store = new MemoryServerStore('server-1')
		expect(store.getNodeId()).toBe('server-1')
	})

	test('getNodeId generates a UUID when none provided', () => {
		const store = new MemoryServerStore()
		expect(store.getNodeId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		)
	})

	test('applyRemoteOperation stores the operation and advances version vector', async () => {
		const store = new MemoryServerStore('server-1')
		const op = createTestOp({ nodeId: 'node-a', sequenceNumber: 1 })

		const result = await store.applyRemoteOperation(op)

		expect(result).toBe('applied')
		expect(store.getVersionVector().get('node-a')).toBe(1)
		expect(await store.getOperationCount()).toBe(1)
	})

	test('applyRemoteOperation deduplicates by operation id', async () => {
		const store = new MemoryServerStore('server-1')
		const op = createTestOp({ id: 'op-1', sequenceNumber: 1 })

		expect(await store.applyRemoteOperation(op)).toBe('applied')
		expect(await store.applyRemoteOperation(op)).toBe('duplicate')
		expect(await store.getOperationCount()).toBe(1)
	})

	test('version vector advances to highest sequence number per node', async () => {
		const store = new MemoryServerStore('server-1')
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
		const store = new MemoryServerStore('server-1')
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
		const store = new MemoryServerStore('server-1')
		// Insert out of order
		await store.applyRemoteOperation(createTestOp({ id: 'a3', nodeId: 'a', sequenceNumber: 3 }))
		await store.applyRemoteOperation(createTestOp({ id: 'a1', nodeId: 'a', sequenceNumber: 1 }))
		await store.applyRemoteOperation(createTestOp({ id: 'a2', nodeId: 'a', sequenceNumber: 2 }))

		const range = await store.getOperationRange('a', 1, 3)
		expect(range.map((op) => op.sequenceNumber)).toEqual([1, 2, 3])
	})

	test('getOperationRange returns empty array for unknown node', async () => {
		const store = new MemoryServerStore('server-1')
		const range = await store.getOperationRange('unknown', 1, 10)
		expect(range).toEqual([])
	})

	test('getOperationCount returns total number of operations', async () => {
		const store = new MemoryServerStore('server-1')
		expect(await store.getOperationCount()).toBe(0)

		await store.applyRemoteOperation(createTestOp({ id: 'op-1' }))
		await store.applyRemoteOperation(createTestOp({ id: 'op-2' }))
		expect(await store.getOperationCount()).toBe(2)
	})

	test('close prevents further operations', async () => {
		const store = new MemoryServerStore('server-1')
		await store.close()

		await expect(store.applyRemoteOperation(createTestOp())).rejects.toThrow(
			'MemoryServerStore is closed',
		)
		await expect(store.getOperationRange('a', 1, 1)).rejects.toThrow('MemoryServerStore is closed')
		await expect(store.getOperationCount()).rejects.toThrow('MemoryServerStore is closed')
	})

	test('getAllOperations returns a copy of all operations', async () => {
		const store = new MemoryServerStore('server-1')
		const op1 = createTestOp({ id: 'op-1' })
		const op2 = createTestOp({ id: 'op-2' })
		await store.applyRemoteOperation(op1)
		await store.applyRemoteOperation(op2)

		const all = store.getAllOperations()
		expect(all).toHaveLength(2)
		expect(all[0]?.id).toBe('op-1')
		expect(all[1]?.id).toBe('op-2')

		// Verify it's a copy
		all.length = 0
		expect(store.getAllOperations()).toHaveLength(2)
	})
})
