import type { Operation } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import type { QueueStorage } from '../types'

/**
 * A batch of operations taken from the queue for sending.
 */
export interface OutboundBatch {
	/** Unique identifier for this batch */
	batchId: string
	/** Operations in this batch, in causal order */
	operations: Operation[]
}

/**
 * Outbound operation queue with pluggable persistence.
 * Manages operations waiting to be sent to the sync server.
 *
 * Operations are deduplicated by ID (content-addressed) and maintained
 * in causal order via topological sort.
 */
export class OutboundQueue {
	private queue: Operation[] = []
	private readonly seen: Set<string> = new Set()
	private readonly inFlight: Map<string, Operation[]> = new Map()
	private nextBatchId = 0
	private initialized = false

	constructor(private readonly storage: QueueStorage) {}

	/**
	 * Load persisted operations from storage.
	 * Must be called before using the queue.
	 */
	async initialize(): Promise<void> {
		const stored = await this.storage.load()
		for (const op of stored) {
			if (!this.seen.has(op.id)) {
				this.seen.add(op.id)
				this.queue.push(op)
			}
		}
		// Ensure causal order
		if (this.queue.length > 1) {
			this.queue = topologicalSort(this.queue)
		}
		this.initialized = true
	}

	/**
	 * Add an operation to the outbound queue.
	 * Deduplicates by operation ID. Persists to storage.
	 */
	async enqueue(op: Operation): Promise<void> {
		if (this.seen.has(op.id)) return

		this.seen.add(op.id)
		this.queue.push(op)
		await this.storage.enqueue(op)

		// Re-sort to maintain causal order when new ops arrive
		if (this.queue.length > 1) {
			this.queue = topologicalSort(this.queue)
		}
	}

	/**
	 * Take a batch of operations from the front of the queue.
	 * Moves them to in-flight status. Returns null if queue is empty.
	 *
	 * @param batchSize - Maximum number of operations in the batch
	 */
	takeBatch(batchSize: number): OutboundBatch | null {
		if (this.queue.length === 0) return null

		const ops = this.queue.splice(0, batchSize)
		const batchId = `batch-${this.nextBatchId++}`
		this.inFlight.set(batchId, ops)

		return { batchId, operations: ops }
	}

	/**
	 * Acknowledge a batch, removing its operations permanently.
	 */
	async acknowledge(batchId: string): Promise<void> {
		const ops = this.inFlight.get(batchId)
		if (!ops) return

		this.inFlight.delete(batchId)
		const ids = ops.map((op) => op.id)
		await this.storage.dequeue(ids)
	}

	/**
	 * Return a failed batch to the front of the queue for retry.
	 * Prepends the operations to maintain priority.
	 */
	returnBatch(batchId: string): void {
		const ops = this.inFlight.get(batchId)
		if (!ops) return

		this.inFlight.delete(batchId)
		// Prepend returned ops, then re-sort for causal order
		this.queue.unshift(...ops)
		if (this.queue.length > 1) {
			this.queue = topologicalSort(this.queue)
		}
	}

	/**
	 * Number of operations waiting in the queue (not counting in-flight).
	 */
	get size(): number {
		return this.queue.length
	}

	/**
	 * Total operations including in-flight.
	 */
	get totalPending(): number {
		let inFlightCount = 0
		for (const ops of this.inFlight.values()) {
			inFlightCount += ops.length
		}
		return this.queue.length + inFlightCount
	}

	/**
	 * Whether the queue has any operations to send.
	 */
	get hasOperations(): boolean {
		return this.queue.length > 0
	}

	/**
	 * Peek at the first `count` operations without removing them.
	 */
	peek(count: number): Operation[] {
		return this.queue.slice(0, count)
	}

	/**
	 * Whether initialize() has been called.
	 */
	get isInitialized(): boolean {
		return this.initialized
	}
}
