import { KoraError } from '@korajs/core'

/**
 * Thrown when a query is invalid (bad field names, invalid operators, etc.).
 */
export class QueryError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'QUERY_ERROR', context)
		this.name = 'QueryError'
	}
}

/**
 * Thrown when a record is not found by ID (findById, update, delete on missing record).
 */
export class RecordNotFoundError extends KoraError {
	constructor(collection: string, recordId: string) {
		super(`Record "${recordId}" not found in collection "${collection}"`, 'RECORD_NOT_FOUND', {
			collection,
			recordId,
		})
		this.name = 'RecordNotFoundError'
	}
}

/**
 * Thrown inside `applyRemoteOperation` when the row's version state changed
 * between the caller's snapshot read and the guarded write (a concurrent local
 * mutation landed in the window). The transaction is rolled back with nothing
 * written; the caller re-reads fresh state, recomputes its merge, and retries.
 * This is the optimistic-concurrency guard that keeps merge-engine results
 * (richtext, add-wins arrays, constraint resolutions) from clobbering newer
 * local edits they never saw.
 */
export class OptimisticLockError extends KoraError {
	constructor(collection: string, recordId: string) {
		super(
			`Row version changed while merging record "${recordId}" in "${collection}"; retry with fresh state`,
			'OPTIMISTIC_LOCK',
			{ collection, recordId },
		)
		this.name = 'OptimisticLockError'
	}
}

/**
 * Thrown when a storage adapter operation fails.
 */
export class AdapterError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'ADAPTER_ERROR', context)
		this.name = 'AdapterError'
	}
}

/**
 * Thrown when an operation is attempted on a store that has not been opened.
 */
export class StoreNotOpenError extends KoraError {
	constructor() {
		super('Store is not open. Call store.open() before performing operations.', 'STORE_NOT_OPEN')
		this.name = 'StoreNotOpenError'
	}
}

/**
 * Thrown when the Web Worker fails to initialize (WASM load failure, OPFS unavailable, etc.).
 */
export class WorkerInitError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(`Worker initialization failed: ${message}`, 'WORKER_INIT_ERROR', context)
		this.name = 'WorkerInitError'
	}
}

/**
 * Thrown when the Web Worker does not respond within the configured timeout.
 */
export class WorkerTimeoutError extends KoraError {
	constructor(operation: string, timeoutMs: number) {
		super(
			`Worker did not respond within ${timeoutMs}ms for operation "${operation}"`,
			'WORKER_TIMEOUT',
			{ operation, timeoutMs },
		)
		this.name = 'WorkerTimeoutError'
	}
}

/**
 * Thrown when IndexedDB persistence operations fail (serialize/deserialize).
 */
export class PersistenceError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(`Persistence error: ${message}`, 'PERSISTENCE_ERROR', context)
		this.name = 'PersistenceError'
	}
}
