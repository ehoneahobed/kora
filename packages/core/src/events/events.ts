import type { ConnectionQuality, Operation } from '../types'

/**
 * Trace of a merge decision. Records all inputs and outputs for debugging and DevTools.
 */
export interface MergeTrace {
	operationA: Operation
	operationB: Operation
	field: string
	strategy: string
	inputA: unknown
	inputB: unknown
	base: unknown | null
	output: unknown
	tier: 1 | 2 | 3
	constraintViolated: string | null
	duration: number
}

/**
 * All events emitted by the Kora framework.
 * These are consumed by DevTools and can be observed by the developer.
 */
export type KoraEvent =
	| { type: 'operation:created'; operation: Operation }
	| { type: 'operation:applied'; operation: Operation; duration: number }
	| { type: 'merge:started'; operationA: Operation; operationB: Operation }
	| { type: 'merge:completed'; trace: MergeTrace }
	| { type: 'merge:conflict'; trace: MergeTrace }
	| { type: 'constraint:violated'; constraint: string; trace: MergeTrace }
	| { type: 'sync:connected'; nodeId: string }
	| { type: 'sync:disconnected'; reason: string }
	| { type: 'sync:sent'; operations: Operation[]; batchSize: number }
	| { type: 'sync:received'; operations: Operation[]; batchSize: number }
	| { type: 'sync:acknowledged'; sequenceNumber: number }
	| { type: 'query:subscribed'; queryId: string; collection: string }
	| { type: 'query:invalidated'; queryId: string; trigger: Operation }
	| { type: 'query:executed'; queryId: string; duration: number; resultCount: number }
	| { type: 'connection:quality'; quality: ConnectionQuality }

/** Extract the event type string union from KoraEvent */
export type KoraEventType = KoraEvent['type']

/** Extract a specific event by its type */
export type KoraEventByType<T extends KoraEventType> = Extract<KoraEvent, { type: T }>

/** Listener function for a specific event type */
export type KoraEventListener<T extends KoraEventType> = (event: KoraEventByType<T>) => void

/**
 * Event emitter interface for the Kora framework.
 * All packages that emit events must implement this interface.
 */
export interface KoraEventEmitter {
	on<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): () => void
	off<T extends KoraEventType>(type: T, listener: KoraEventListener<T>): void
	emit<T extends KoraEventType>(event: KoraEventByType<T>): void
}
