import type {
	KoraEvent,
	KoraEventByType,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
	MergeTrace,
	Operation,
} from '@korajs/core'
import type { TimestampedEvent } from '../../src/types'

/**
 * Creates a mock KoraEventEmitter that tracks listeners and can emit events.
 * Useful for testing instrumenter attachment and event forwarding.
 */
export function createMockEmitter(): KoraEventEmitter & {
	/** Emit a typed event to all registered listeners */
	emit<T extends KoraEventType>(event: KoraEventByType<T>): void
	/** Get count of registered listeners for a specific event type */
	listenerCount(type: KoraEventType): number
	/** Get total count of all registered listeners across all types */
	totalListenerCount(): number
} {
	// Use a simple function store to avoid complex generic casts.
	// Each event type maps to a set of listener functions stored as unknown.
	const listeners = new Map<KoraEventType, Set<unknown>>()

	return {
		on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void {
			if (!listeners.has(type)) {
				listeners.set(type, new Set())
			}
			const set = listeners.get(type)
			set?.add(listener)
			return () => {
				set?.delete(listener)
			}
		},

		off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void {
			const set = listeners.get(type)
			if (set) {
				set.delete(listener)
			}
		},

		emit<T extends KoraEventType>(event: KoraEventByType<T>): void {
			const set = listeners.get(event.type)
			if (set) {
				for (const listener of set) {
					;(listener as (event: KoraEvent) => void)(event)
				}
			}
		},

		listenerCount(type: KoraEventType): number {
			return listeners.get(type)?.size ?? 0
		},

		totalListenerCount(): number {
			let count = 0
			for (const set of listeners.values()) {
				count += set.size
			}
			return count
		},
	}
}

/** Creates a minimal valid Operation for testing */
export function createSampleOperation(overrides?: Partial<Operation>): Operation {
	return {
		id: 'op-test-001',
		nodeId: 'node-001',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-001',
		data: { title: 'Test todo' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-001' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

/** Creates a sample MergeTrace for testing */
export function createSampleMergeTrace(overrides?: Partial<MergeTrace>): MergeTrace {
	return {
		operationA: createSampleOperation({ id: 'op-a' }),
		operationB: createSampleOperation({ id: 'op-b', nodeId: 'node-002' }),
		field: 'title',
		strategy: 'lww',
		inputA: 'Local title',
		inputB: 'Remote title',
		base: 'Original title',
		output: 'Remote title',
		tier: 1,
		constraintViolated: null,
		duration: 0.5,
		...overrides,
	}
}

/** Creates a typed KoraEvent for testing. Provides sensible defaults per event type. */
export function createSampleEvent<T extends KoraEventType>(
	type: T,
	overrides?: Partial<Omit<KoraEventByType<T>, 'type'>>,
): KoraEventByType<T> {
	const defaults: Record<KoraEventType, KoraEvent> = {
		'operation:created': { type: 'operation:created', operation: createSampleOperation() },
		'operation:applied': {
			type: 'operation:applied',
			operation: createSampleOperation(),
			duration: 1.2,
		},
		'merge:started': {
			type: 'merge:started',
			operationA: createSampleOperation({ id: 'op-a' }),
			operationB: createSampleOperation({ id: 'op-b', nodeId: 'node-002' }),
		},
		'merge:completed': { type: 'merge:completed', trace: createSampleMergeTrace() },
		'merge:conflict': {
			type: 'merge:conflict',
			trace: createSampleMergeTrace({ strategy: 'lww' }),
		},
		'constraint:violated': {
			type: 'constraint:violated',
			constraint: 'unique:email',
			trace: createSampleMergeTrace({ constraintViolated: 'unique:email', tier: 2 }),
		},
		'sync:connected': { type: 'sync:connected', nodeId: 'node-001' },
		'sync:disconnected': { type: 'sync:disconnected', reason: 'timeout' },
		'sync:sent': {
			type: 'sync:sent',
			operations: [createSampleOperation()],
			batchSize: 1,
		},
		'sync:received': {
			type: 'sync:received',
			operations: [createSampleOperation({ id: 'op-remote', nodeId: 'node-002' })],
			batchSize: 1,
		},
		'sync:acknowledged': { type: 'sync:acknowledged', sequenceNumber: 5 },
		'query:subscribed': {
			type: 'query:subscribed',
			queryId: 'q-001',
			collection: 'todos',
		},
		'query:invalidated': {
			type: 'query:invalidated',
			queryId: 'q-001',
			trigger: createSampleOperation(),
		},
		'query:executed': {
			type: 'query:executed',
			queryId: 'q-001',
			duration: 2.5,
			resultCount: 10,
		},
		'connection:quality': { type: 'connection:quality', quality: 'good' },
	}

	const base = defaults[type] as KoraEventByType<T>
	if (overrides) {
		return { ...base, ...overrides }
	}
	return base
}

/** Creates a TimestampedEvent wrapping a KoraEvent */
export function createTimestampedEvent(
	id: number,
	event: KoraEvent,
	receivedAt?: number,
): TimestampedEvent {
	return {
		id,
		event,
		receivedAt: receivedAt ?? 1000 + id,
	}
}
