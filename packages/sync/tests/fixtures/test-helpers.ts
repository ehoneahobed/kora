import type {
	KoraEvent,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
	Operation,
	VersionVector,
} from '@korajs/core'
import type { SyncStore } from '../../src/engine/sync-store'

/**
 * Create a mock SyncStore for testing.
 * Maintains an in-memory operation log and version vector.
 */
export function createMockSyncStore(options?: {
	nodeId?: string
	initialOps?: Operation[]
	initialVector?: VersionVector
}): SyncStore & {
	getAllOperations(): Operation[]
	addOperation(op: Operation): void
} {
	const nodeId = options?.nodeId ?? 'test-node'
	const operations: Operation[] = [...(options?.initialOps ?? [])]
	const versionVector: VersionVector = options?.initialVector
		? new Map(options.initialVector)
		: new Map()

	// Initialize version vector from initial operations
	for (const op of operations) {
		const current = versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > current) {
			versionVector.set(op.nodeId, op.sequenceNumber)
		}
	}

	return {
		getVersionVector(): VersionVector {
			return new Map(versionVector)
		},

		getNodeId(): string {
			return nodeId
		},

		async applyRemoteOperation(op: Operation): Promise<'applied' | 'duplicate' | 'skipped'> {
			// Content-addressed dedup
			if (operations.some((existing) => existing.id === op.id)) {
				return 'duplicate'
			}

			operations.push(op)
			const current = versionVector.get(op.nodeId) ?? 0
			if (op.sequenceNumber > current) {
				versionVector.set(op.nodeId, op.sequenceNumber)
			}
			return 'applied'
		},

		async getOperationRange(
			targetNodeId: string,
			fromSeq: number,
			toSeq: number,
		): Promise<Operation[]> {
			return operations
				.filter(
					(op) =>
						op.nodeId === targetNodeId &&
						op.sequenceNumber >= fromSeq &&
						op.sequenceNumber <= toSeq,
				)
				.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
		},

		getAllOperations(): Operation[] {
			return [...operations]
		},

		addOperation(op: Operation): void {
			if (!operations.some((existing) => existing.id === op.id)) {
				operations.push(op)
				const current = versionVector.get(op.nodeId) ?? 0
				if (op.sequenceNumber > current) {
					versionVector.set(op.nodeId, op.sequenceNumber)
				}
			}
		},
	}
}

/**
 * Create test operations for a given node.
 */
export function createTestOperations(
	count: number,
	nodeId: string,
	collection = 'todos',
): Operation[] {
	const ops: Operation[] = []
	for (let i = 1; i <= count; i++) {
		ops.push({
			id: `${nodeId}-op-${i}`,
			nodeId,
			type: 'insert',
			collection,
			recordId: `${nodeId}-rec-${i}`,
			data: { title: `Item ${i}`, index: i },
			previousData: null,
			timestamp: { wallTime: 1000 + i, logical: 0, nodeId },
			sequenceNumber: i,
			causalDeps: i > 1 ? [`${nodeId}-op-${i - 1}`] : [],
			schemaVersion: 1,
		})
	}
	return ops
}

/**
 * Create a mock event emitter that records all events.
 */
export function createMockEmitter(): KoraEventEmitter & { events: KoraEvent[] } {
	const events: KoraEvent[] = []
	// Using Function type for test mock — production code uses proper KoraEventListener generics
	const listeners = new Map<string, Set<(event: KoraEvent) => void>>()

	return {
		events,
		on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
			if (!listeners.has(type)) listeners.set(type, new Set())
			const wrappedListener = listener as unknown as (event: KoraEvent) => void
			listeners.get(type)?.add(wrappedListener)
			return () => listeners.get(type)?.delete(wrappedListener)
		},
		off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
			listeners.get(type)?.delete(listener as unknown as (event: KoraEvent) => void)
		},
		emit(event: KoraEvent): void {
			events.push(event)
			const set = listeners.get(event.type)
			if (set) {
				for (const listener of set) {
					listener(event)
				}
			}
		},
	}
}

/**
 * Create a deterministic seeded pseudo-random number generator.
 * Uses a simple LCG (linear congruential generator).
 */
export function createSeededRandom(seed: number): () => number {
	let state = seed
	return () => {
		// Parameters from Numerical Recipes
		state = (state * 1664525 + 1013904223) & 0xffffffff
		return (state >>> 0) / 0xffffffff
	}
}
