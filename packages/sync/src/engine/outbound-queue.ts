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
	/**
	 * Ids of queued operations that were put on the wire at least once. Such an op may
	 * already be stored on the server (its ack can be lost), so a clock rebase must never
	 * re-stamp it (W3 step 4). Persisted through the storage when it supports it.
	 */
	private readonly sent: Set<string> = new Set()
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
		if (this.storage.loadSentIds) {
			for (const id of await this.storage.loadSentIds()) {
				if (this.seen.has(id)) this.sent.add(id)
			}
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
		// Release the ids (SYNC-6): the seen set must only hold ops still owned by the
		// queue, or it grows forever and an acked op could never be re-enqueued (for
		// example when a restored server needs it again).
		for (const id of ids) {
			this.seen.delete(id)
			this.sent.delete(id)
		}
		await this.storage.dequeue(ids)
	}

	/**
	 * Acknowledge only operations in an in-flight batch whose local sequence number is
	 * covered by the server's ack. Any later operations return to the front of the
	 * queue for retry. This is required when the server accepts a prefix but rejects a
	 * later operation retriably (for example a stale-scope push after auth changed).
	 */
	async acknowledgeThrough(
		batchId: string,
		lastSequenceNumber: number,
	): Promise<{ acknowledged: Operation[]; returned: Operation[] }> {
		const ops = this.inFlight.get(batchId)
		if (!ops) return { acknowledged: [], returned: [] }

		this.inFlight.delete(batchId)
		const acknowledged = ops.filter((op) => op.sequenceNumber <= lastSequenceNumber)
		const retry = ops.filter((op) => op.sequenceNumber > lastSequenceNumber)

		if (retry.length > 0) {
			this.queue.unshift(...retry)
			if (this.queue.length > 1) {
				this.queue = topologicalSort(this.queue)
			}
		}

		if (acknowledged.length > 0) {
			const ids = acknowledged.map((op) => op.id)
			for (const id of ids) {
				this.seen.delete(id)
				this.sent.delete(id)
			}
			await this.storage.dequeue(ids)
		}
		return { acknowledged, returned: retry }
	}

	/**
	 * Record that a taken batch was put on the wire. Its operations may now be stored on
	 * the server even if no ack ever arrives, so they are excluded from clock rebases.
	 */
	async markSent(batchId: string): Promise<void> {
		const ops = this.inFlight.get(batchId)
		if (!ops) return
		const fresh = ops.filter((op) => !this.sent.has(op.id))
		if (fresh.length === 0) return
		for (const op of fresh) this.sent.add(op.id)
		await this.storage.markSent?.(fresh)
	}

	/** Whether this queued operation was ever put on the wire. */
	wasSent(opId: string): boolean {
		return this.sent.has(opId)
	}

	/**
	 * Forget the sent flag of operations the server explicitly refused without storing
	 * (for example a batch refused with INVALID_TIMESTAMP), so a clock rebase may re-stamp
	 * them. In memory only: after a restart they are conservatively treated as sent.
	 */
	clearSent(opIds: string[]): void {
		for (const id of opIds) this.sent.delete(id)
	}

	/** Whether the queue owns this operation (queued or in flight). */
	has(opId: string): boolean {
		return this.seen.has(opId)
	}

	/** Every operation currently in flight, across batches. */
	getInFlight(): Operation[] {
		return [...this.inFlight.values()].flat()
	}

	/**
	 * Replace some queued (not in-flight) operations by rewritten ones, for example after
	 * a clock rebase re-stamped never-sent operations under new content-addressed ids.
	 * Operations not named in `oldIds` are untouched.
	 */
	async replace(oldIds: string[], newOps: Operation[]): Promise<void> {
		const remove = new Set(oldIds)
		this.queue = this.queue.filter((op) => !remove.has(op.id))
		for (const id of oldIds) {
			this.seen.delete(id)
			this.sent.delete(id)
		}
		if (oldIds.length > 0) {
			await this.storage.dequeue(oldIds)
		}
		for (const op of newOps) {
			if (this.seen.has(op.id)) continue
			this.seen.add(op.id)
			this.queue.push(op)
			await this.storage.enqueue(op)
		}
		if (this.queue.length > 1) {
			this.queue = topologicalSort(this.queue)
		}
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
	 * All queued operations (not counting in-flight), in causal order.
	 */
	getAll(): Operation[] {
		return [...this.queue]
	}

	/**
	 * Atomically replace the entire queue with a new set of operations.
	 *
	 * Used after a timestamp rebase rewrote the queued operations under new
	 * content-addressed ids: the old entries must vanish from memory AND from
	 * persistent storage in one step, or a page refresh could resurrect
	 * stale-stamped ops the server would reject. Resets the seen set to exactly
	 * the new ids so the rewritten ops are not treated as duplicates.
	 */
	async replaceAll(ops: Operation[]): Promise<void> {
		const removeIds: string[] = this.queue.map((op) => op.id)
		for (const batch of this.inFlight.values()) {
			for (const op of batch) {
				removeIds.push(op.id)
			}
		}
		this.inFlight.clear()

		this.queue = ops.length > 1 ? topologicalSort([...ops]) : [...ops]
		this.seen.clear()
		this.sent.clear()
		for (const op of this.queue) {
			this.seen.add(op.id)
		}

		if (removeIds.length > 0) {
			await this.storage.dequeue(removeIds)
		}
		for (const op of this.queue) {
			await this.storage.enqueue(op)
		}
	}

	/**
	 * Whether initialize() has been called.
	 */
	get isInitialized(): boolean {
		return this.initialized
	}

	/**
	 * Remove a single operation the server permanently rejected — from the queue,
	 * from any in-flight batch, and from durable storage — so a later batch ack or
	 * a reconnect `returnBatch` can never resend or resurrect it. Returns the
	 * removed operation so the caller can record it in a durable rejected store,
	 * or null if it was not present (already acknowledged and removed).
	 */
	async reject(opId: string): Promise<Operation | null> {
		let removed: Operation | null = null

		// Common case: the op was just sent and sits in an in-flight batch.
		for (const [batchId, ops] of this.inFlight) {
			const idx = ops.findIndex((op) => op.id === opId)
			if (idx !== -1) {
				removed = ops[idx] ?? null
				ops.splice(idx, 1)
				if (ops.length === 0) {
					this.inFlight.delete(batchId)
				}
				break
			}
		}

		// Otherwise it may still be queued (not yet sent).
		if (!removed) {
			const idx = this.queue.findIndex((op) => op.id === opId)
			if (idx !== -1) {
				removed = this.queue[idx] ?? null
				this.queue.splice(idx, 1)
			}
		}

		this.seen.delete(opId)
		this.sent.delete(opId)
		await this.storage.dequeue([opId])
		return removed
	}

	/** Remove every pending/in-flight operation for a record so authorization loss cannot upload it. */
	async rejectRecord(collection: string, recordId: string): Promise<Operation[]> {
		const matching = [...this.queue, ...[...this.inFlight.values()].flat()].filter(
			(op) => op.collection === collection && op.recordId === recordId,
		)
		const removed: Operation[] = []
		for (const operation of matching) {
			const rejected = await this.reject(operation.id)
			if (rejected) removed.push(rejected)
		}
		return removed
	}

	/**
	 * Remove operations by id from queue and persistent storage.
	 * Used when ops were already sent during handshake delta exchange.
	 */
	async removeByIds(ids: string[]): Promise<void> {
		if (ids.length === 0) return
		const idSet = new Set(ids)
		this.queue = this.queue.filter((op) => !idSet.has(op.id))
		for (const id of ids) {
			this.seen.delete(id)
			this.sent.delete(id)
		}
		await this.storage.dequeue(ids)
	}
}
