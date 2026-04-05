import type { Operation } from '@korajs/core'
import type { QueueStorage } from '../types'

/**
 * In-memory QueueStorage implementation for testing.
 * Operations are lost on process restart — production should use
 * IndexedDB or OPFS-backed storage.
 */
export class MemoryQueueStorage implements QueueStorage {
	private operations: Map<string, Operation> = new Map()

	async load(): Promise<Operation[]> {
		return [...this.operations.values()]
	}

	async enqueue(op: Operation): Promise<void> {
		this.operations.set(op.id, op)
	}

	async dequeue(ids: string[]): Promise<void> {
		for (const id of ids) {
			this.operations.delete(id)
		}
	}

	async count(): Promise<number> {
		return this.operations.size
	}
}
