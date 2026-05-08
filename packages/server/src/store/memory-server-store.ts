import type { Operation, VersionVector } from '@korajs/core'
import { generateUUIDv7 } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import type { MaterializedRecord, ServerStore } from './server-store'

/**
 * In-memory server store for testing and quick prototyping.
 * Not suitable for production — data does not survive process restart.
 */
export class MemoryServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly operations: Operation[] = []
	private readonly operationIndex = new Map<string, Operation>()
	private readonly versionVector: Map<string, number> = new Map()
	private closed = false

	constructor(nodeId?: string) {
		this.nodeId = nodeId ?? generateUUIDv7()
	}

	getVersionVector(): VersionVector {
		return new Map(this.versionVector)
	}

	getNodeId(): string {
		return this.nodeId
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		this.assertOpen()

		// Content-addressed dedup: same id = same content
		if (this.operationIndex.has(op.id)) {
			return 'duplicate'
		}

		this.operations.push(op)
		this.operationIndex.set(op.id, op)

		// Advance version vector
		const currentSeq = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentSeq) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		return 'applied'
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.assertOpen()

		return this.operations
			.filter(
				(op) => op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq,
			)
			.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
	}

	async getOperationCount(): Promise<number> {
		this.assertOpen()
		return this.operations.length
	}

	async materializeCollection(collection: string): Promise<MaterializedRecord[]> {
		this.assertOpen()

		// Filter and sort operations for this collection
		const collectionOps = this.operations
			.filter((op) => op.collection === collection)
			.sort((a, b) => {
				if (a.timestamp.wallTime !== b.timestamp.wallTime) return a.timestamp.wallTime - b.timestamp.wallTime
				if (a.timestamp.logical !== b.timestamp.logical) return a.timestamp.logical - b.timestamp.logical
				return a.sequenceNumber - b.sequenceNumber
			})

		// Replay operations to reconstruct current state
		const records = new Map<string, Record<string, unknown>>()
		const deleted = new Set<string>()

		for (const op of collectionOps) {
			switch (op.type) {
				case 'insert':
					if (op.data) {
						records.set(op.recordId, { id: op.recordId, ...op.data })
						deleted.delete(op.recordId)
					}
					break
				case 'update':
					if (op.data) {
						const existing = records.get(op.recordId) ?? { id: op.recordId }
						records.set(op.recordId, { ...existing, ...op.data })
						deleted.delete(op.recordId)
					}
					break
				case 'delete':
					deleted.add(op.recordId)
					break
			}
		}

		for (const id of deleted) {
			records.delete(id)
		}

		return Array.from(records.values()) as MaterializedRecord[]
	}

	async close(): Promise<void> {
		this.closed = true
	}

	// --- Testing helpers (not on interface) ---

	/**
	 * Get all stored operations (for test assertions).
	 */
	getAllOperations(): Operation[] {
		return [...this.operations]
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error('MemoryServerStore is closed')
		}
	}
}
