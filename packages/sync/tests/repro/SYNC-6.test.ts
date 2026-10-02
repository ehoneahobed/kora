/**
 * SYNC-6 repro: OutboundQueue.acknowledge() never removes ids from the `seen` dedup
 * set (acknowledgeThrough/reject/removeByIds all do). The set grows by one id per
 * uploaded op for the life of the app, and an acknowledged op can never be enqueued
 * again even when the op-log reconcile later finds it unsynced.
 * Asserts CORRECT behavior.
 */
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryQueueStorage } from '../../src/engine/memory-queue-storage'
import { OutboundQueue } from '../../src/engine/outbound-queue'

function op(i: number): Operation {
	return {
		id: `op-${i}`,
		nodeId: 'n1',
		type: 'insert',
		collection: 'todos',
		recordId: `r-${i}`,
		data: { title: `t${i}` },
		previousData: null,
		timestamp: { wallTime: 1000 + i, logical: 0, nodeId: 'n1' },
		sequenceNumber: i,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('SYNC-6: OutboundQueue seen set', () => {
	test('acknowledged ids are released (bounded memory, re-enqueue possible)', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()
		for (let i = 1; i <= 1000; i++) {
			await queue.enqueue(op(i))
			const batch = queue.takeBatch(10)
			if (batch) await queue.acknowledge(batch.batchId)
		}
		const seen = (queue as unknown as { seen: Set<string> }).seen
		expect(seen.size, 'seen retains every acknowledged id').toBe(0)

		// Re-enqueue after ack (e.g. reconcile found it unsynced) must queue it again.
		await queue.enqueue(op(1))
		expect(queue.size).toBe(1)
	})
})
