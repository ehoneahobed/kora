import type { Operation } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { MemoryQueueStorage } from './memory-queue-storage'
import { OutboundQueue } from './outbound-queue'

function makeOp(id: string, seq: number, deps: string[] = []): Operation {
	return {
		id,
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: `Op ${id}` },
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'node-1' },
		sequenceNumber: seq,
		causalDeps: deps,
		schemaVersion: 1,
	}
}

describe('OutboundQueue', () => {
	test('initializes from empty storage', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()
		expect(queue.size).toBe(0)
		expect(queue.hasOperations).toBe(false)
		expect(queue.isInitialized).toBe(true)
	})

	test('enqueue adds operations', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))
		await queue.enqueue(makeOp('op-2', 2))

		expect(queue.size).toBe(2)
		expect(queue.hasOperations).toBe(true)
	})

	test('enqueue deduplicates by operation ID', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		const op = makeOp('op-1', 1)
		await queue.enqueue(op)
		await queue.enqueue(op) // Same ID — should be ignored

		expect(queue.size).toBe(1)
	})

	test('enqueue persists to storage', async () => {
		const storage = new MemoryQueueStorage()
		const queue = new OutboundQueue(storage)
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))
		expect(await storage.count()).toBe(1)
	})

	test('initialize loads from storage', async () => {
		const storage = new MemoryQueueStorage()
		await storage.enqueue(makeOp('op-1', 1))
		await storage.enqueue(makeOp('op-2', 2))

		const queue = new OutboundQueue(storage)
		await queue.initialize()

		expect(queue.size).toBe(2)
	})

	test('maintains causal order after enqueue', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		// Enqueue dependent first, then dependency
		const dep = makeOp('op-1', 1)
		const dependent = makeOp('op-2', 2, ['op-1'])

		await queue.enqueue(dependent)
		await queue.enqueue(dep)

		const peeked = queue.peek(2)
		// op-1 should come before op-2 (causal order)
		expect(peeked[0]?.id).toBe('op-1')
		expect(peeked[1]?.id).toBe('op-2')
	})

	test('takeBatch returns operations and moves to in-flight', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))
		await queue.enqueue(makeOp('op-2', 2))
		await queue.enqueue(makeOp('op-3', 3))

		const batch = queue.takeBatch(2)
		expect(batch).not.toBeNull()
		expect(batch?.operations).toHaveLength(2)
		expect(batch?.batchId).toBeDefined()

		// Only 1 left in queue (the 3rd was not taken)
		expect(queue.size).toBe(1)
		// But totalPending includes in-flight
		expect(queue.totalPending).toBe(3)
	})

	test('takeBatch returns null for empty queue', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		expect(queue.takeBatch(10)).toBeNull()
	})

	test('takeBatch respects batchSize', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		for (let i = 1; i <= 5; i++) {
			await queue.enqueue(makeOp(`op-${i}`, i))
		}

		const batch = queue.takeBatch(3)
		expect(batch?.operations).toHaveLength(3)
		expect(queue.size).toBe(2)
	})

	test('acknowledge removes batch from storage', async () => {
		const storage = new MemoryQueueStorage()
		const queue = new OutboundQueue(storage)
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))
		await queue.enqueue(makeOp('op-2', 2))

		const batch = queue.takeBatch(2)
		if (!batch) throw new Error('Expected batch')

		await queue.acknowledge(batch.batchId)
		expect(await storage.count()).toBe(0)
		expect(queue.totalPending).toBe(0)
	})

	test('acknowledge is no-op for unknown batchId', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		// Should not throw
		await queue.acknowledge('unknown-batch')
	})

	test('returnBatch restores operations to queue', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))
		await queue.enqueue(makeOp('op-2', 2))

		const batch = queue.takeBatch(2)
		if (!batch) throw new Error('Expected batch')
		expect(queue.size).toBe(0)

		queue.returnBatch(batch.batchId)
		expect(queue.size).toBe(2)
	})

	test('returnBatch is no-op for unknown batchId', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		// Should not throw
		queue.returnBatch('unknown-batch')
		expect(queue.size).toBe(0)
	})

	test('multiple in-flight batches', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		for (let i = 1; i <= 6; i++) {
			await queue.enqueue(makeOp(`op-${i}`, i))
		}

		const batch1 = queue.takeBatch(3)
		const batch2 = queue.takeBatch(3)

		expect(batch1?.operations).toHaveLength(3)
		expect(batch2?.operations).toHaveLength(3)
		expect(queue.size).toBe(0)
		expect(queue.totalPending).toBe(6)

		if (!batch1 || !batch2) throw new Error('Expected both batches')

		// Acknowledge first batch
		await queue.acknowledge(batch1.batchId)
		expect(queue.totalPending).toBe(3)

		// Return second batch
		queue.returnBatch(batch2.batchId)
		expect(queue.size).toBe(3)
		expect(queue.totalPending).toBe(3)
	})

	test('peek returns operations without removing them', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))
		await queue.enqueue(makeOp('op-2', 2))

		const peeked = queue.peek(1)
		expect(peeked).toHaveLength(1)
		expect(queue.size).toBe(2) // Unchanged
	})

	test('peek with count larger than queue returns all', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		await queue.enqueue(makeOp('op-1', 1))

		const peeked = queue.peek(10)
		expect(peeked).toHaveLength(1)
	})

	test('causal order preserved through storage roundtrip', async () => {
		const storage = new MemoryQueueStorage()

		// Add ops in reverse causal order
		const op1 = makeOp('op-1', 1)
		const op2 = makeOp('op-2', 2, ['op-1'])
		const op3 = makeOp('op-3', 3, ['op-2'])

		await storage.enqueue(op3)
		await storage.enqueue(op1)
		await storage.enqueue(op2)

		const queue = new OutboundQueue(storage)
		await queue.initialize()

		const peeked = queue.peek(3)
		expect(peeked[0]?.id).toBe('op-1')
		expect(peeked[1]?.id).toBe('op-2')
		expect(peeked[2]?.id).toBe('op-3')
	})
})
