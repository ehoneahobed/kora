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
 * Thrown when a write reaches a storage adapter that could not obtain durable
 * storage (it opened, or was promoted to leader, on a non-persistent in-memory
 * database). Kora refuses such writes instead of accepting data that would be
 * lost on reload. Reads still work.
 *
 * Fix: close other tabs or apps using the same origin's OPFS storage and reopen,
 * or opt in explicitly with `allowNonDurable: true` if in-memory storage is
 * acceptable for this app.
 */
export class StorageDurabilityError extends KoraError {
	constructor(dbName: string, phase: 'open' | 'promotion', reason: string) {
		super(
			`Database "${dbName}" has no durable storage (${reason} during ${phase}); writes are refused so they are not silently lost on reload. Close other tabs or apps using this origin's storage and reload, or set allowNonDurable: true to accept in-memory storage.`,
			'STORAGE_DURABILITY_LOST',
			{ dbName, phase, reason },
		)
		this.name = 'StorageDurabilityError'
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
 * Thrown when a follower tab cannot reach a live leader tab over the multi-tab
 * broadcast channel (the leader tab was closed, crashed, or is unresponsive).
 * Distinct from {@link WorkerTimeoutError}: this fails fast on a confirmed-absent
 * leader instead of waiting out the full RPC timeout.
 */
export class NoLeaderError extends KoraError {
	constructor(
		operation: string,
		message = `No live leader tab is answering multi-tab storage RPC for operation "${operation}"`,
		code = 'NO_LEADER',
		context: Record<string, unknown> = {},
	) {
		super(message, code, { operation, ...context })
		this.name = 'NoLeaderError'
	}
}

/**
 * Thrown to a follower tab's pending storage requests when the leader tab that
 * was answering stopped sending heartbeats (hung, frozen, or suspended). The
 * request may or may not have been applied: retry it with the same `requestId`
 * (in the error context) and the leader de-duplicates it. Retriable.
 */
export class LeaderUnresponsiveError extends NoLeaderError {
	constructor(operation: string, silentMs: number, requestId: string) {
		super(
			operation,
			`The leader tab stopped responding (no heartbeat for ${silentMs}ms) during "${operation}". The request may or may not have been applied; retry it with the same requestId and the leader de-duplicates it.`,
			'LEADER_UNRESPONSIVE',
			{ silentMs, requestId, retriable: true },
		)
		this.name = 'LeaderUnresponsiveError'
	}
}

/**
 * Thrown to pending storage requests when their bridge was torn down, typically
 * because this tab was just promoted to leader or the leader handed over.
 * Retriable: the next attempt goes to the new leader.
 */
export class BridgeTerminatedError extends KoraError {
	constructor(operation: string, reason: string) {
		super(
			`Storage request "${operation}" was interrupted (${reason}); retry it against the new storage leader.`,
			'BRIDGE_TERMINATED',
			{ operation, reason, retriable: true },
		)
		this.name = 'BridgeTerminatedError'
	}
}

/** Thrown when a storage request is cancelled through its `AbortSignal`. */
export class RequestAbortedError extends KoraError {
	constructor(operation: string, requestId: string) {
		super(
			`Storage request "${operation}" was aborted by the caller. A write may already have reached the leader; retry with the same requestId to stay idempotent.`,
			'REQUEST_ABORTED',
			{ operation, requestId },
		)
		this.name = 'RequestAbortedError'
	}
}

/**
 * Thrown by `deleteDatabase()` when the database is open in some tab or worker
 * on this origin. Close it everywhere (or call `app.close()`) and retry.
 */
export class StorageInUseError extends KoraError {
	constructor(dbName: string) {
		super(
			`Database "${dbName}" is open in a tab on this origin; close it before deleting it.`,
			'STORAGE_IN_USE',
			{ dbName },
		)
		this.name = 'StorageInUseError'
	}
}

/**
 * Thrown by `deleteDatabase()` when the database still holds operations that
 * never reached the server. Sync first, or pass `{ force: true }` to discard them.
 */
export class UnsyncedDataError extends KoraError {
	constructor(dbName: string) {
		super(
			`Database "${dbName}" has unsynced operations; deleting it would lose them. Sync first, or pass { force: true } to discard them deliberately.`,
			'UNSYNCED_DATA',
			{ dbName },
		)
		this.name = 'UnsyncedDataError'
	}
}

/**
 * Thrown when a database's data lives in a storage backend this runtime cannot
 * read (for example it was written to OPFS, and OPFS is unavailable now). Kora
 * refuses to start an empty, disjoint copy rather than hide the existing data.
 */
export class StorageBackendMismatchError extends KoraError {
	constructor(dbName: string, recorded: string, requested: string, reason: string) {
		super(
			`Database "${dbName}" is stored in ${recorded}, but this session can only use ${requested} (${reason}). Kora will not start a separate empty copy; reload in a browser profile where ${recorded} is available.`,
			'STORAGE_BACKEND_MISMATCH',
			{ dbName, recorded, requested, reason },
		)
		this.name = 'StorageBackendMismatchError'
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
