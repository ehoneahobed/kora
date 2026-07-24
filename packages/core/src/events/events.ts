import type { ConnectionQuality, Operation, SyncDiagnosticsSnapshot } from '../types'

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
	| {
			type: 'sync:schema-mismatch'
			clientSchemaVersion: number
			serverSchemaVersion: number
			supportedMin: number
			supportedMax: number
			reason: string
	  }
	| { type: 'sync:auth-failed'; reason: string }
	| {
			type: 'sync:clock-skew'
			/** serverTime - localTime in ms. Negative = this device's clock is fast. */
			skewMs: number
			severity: 'info' | 'slow-warning' | 'fast-blocked'
			source: 'handshake' | 'server-reject'
	  }
	| {
			type: 'sync:clock-rebase'
			/** Number of unsynced operations that were re-stamped. */
			rebasedCount: number
			/** How far ahead of server time the most future queued operation was, in ms. */
			maxSkewMs: number
	  }
	| { type: 'sync:sent'; operations: Operation[]; batchSize: number }
	| { type: 'sync:received'; operations: Operation[]; batchSize: number }
	| { type: 'sync:acknowledged'; sequenceNumber: number }
	| {
			type: 'sync:apply-failed'
			operationId: string
			collection: string
			recordId: string
			code: string
			message: string
			retriable: boolean
	  }
	| {
			/**
			 * The server rejected one of THIS client's outbound operations before it
			 * became authoritative. The op has been diverted out of the pending sync
			 * queue into the durable rejected store (kept, not retried); the app can
			 * surface the reason and decide whether to roll back the optimistic local
			 * write or let the user edit and resubmit.
			 */
			type: 'sync:operation-rejected'
			operationId: string
			collection: string
			recordId: string
			code: string
			message: string
			retriable: boolean
	  }
	| { type: 'query:subscribed'; queryId: string; collection: string }
	| { type: 'query:invalidated'; queryId: string; trigger: Operation }
	| { type: 'query:executed'; queryId: string; duration: number; resultCount: number }
	| { type: 'connection:quality'; quality: ConnectionQuality }
	| { type: 'sync:diagnostics'; diagnostics: SyncDiagnosticsSnapshot }
	| {
			type: 'sync:bandwidth'
			bytesPerSecond: number
			direction: 'in' | 'out'
	  }
	| {
			type: 'sync:initial-sync-progress'
			progress: number
			totalBatches: number
			receivedBatches: number
	  }
	| { type: 'awareness:updated'; states: Map<number, unknown> }
	| {
			type: 'state-machine:transition'
			collection: string
			recordId: string
			from: string
			to: string
			valid: boolean
	  }
	| {
			type: 'state-machine:rejected'
			collection: string
			recordId: string
			from: string
			to: string
			allowed: string[]
	  }
	| {
			type: 'store:persistence-error'
			dbName: string
			message: string
			code: string
	  }
	| {
			type: 'store:quota-exceeded'
			dbName: string
			message: string
	  }
	| {
			/**
			 * OPFS persistence was unavailable, so the store fell back to a
			 * NON-PERSISTENT in-memory database. Anything written this session is lost
			 * on reload. This is emitted instead of failing silently so the condition
			 * is observable rather than a data-loss trap.
			 */
			type: 'store:opfs-unavailable'
			dbName: string
			/**
			 * Why OPFS could not be used. `lock-conflict` means another runtime on this
			 * origin already holds the OPFS pool for this database; `timeout` means the
			 * VFS install did not complete in time (common in headless CI); `unsupported`
			 * means the runtime has no usable OPFS.
			 */
			reason: 'lock-conflict' | 'timeout' | 'unsupported'
			message: string
	  }
	| {
			/**
			 * Another runtime on this origin was already using this database name, so
			 * this runtime attached to it as a follower and now SHARES that one
			 * database. That is intended for multiple tabs of the SAME app; it is a bug
			 * if these are logically separate apps, which should each use a distinct
			 * store name (`store: { name: '...' }`) to stay isolated.
			 */
			type: 'store:db-name-collision'
			dbName: string
			message: string
	  }
	| {
			type: 'replay:completed'
			targetOperationId: string
			operationsApplied: number
			duration: number
	  }

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
