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
 * Thrown on an insert into a collection with a field declared `t.string().stamp('userId')`
 * when Kora cannot fill it: the app does not know the signed-in user yet, or the insert
 * names another user.
 */
export class StampedFieldError extends KoraError {
	constructor(
		message: string,
		code: 'STAMP_USER_UNKNOWN' | 'STAMP_MISMATCH',
		context: Record<string, unknown>,
	) {
		super(message, code, context)
		this.name = 'StampedFieldError'
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
 * Thrown when the store opens a database a NEWER build of the app already migrated: its
 * stored schema version is above this code's `schema.version` (RT-109). Running older
 * code against it would write operations of the old schema into the new one, or fail
 * part-way, so the store refuses before changing anything and emits `store:schema-ahead`.
 *
 * Fix: run the newer build (reload while online, or accept the app's update prompt).
 * Never lower `schema.version` in a deployed app.
 */
export class SchemaVersionAheadError extends KoraError {
	constructor(
		public readonly dbName: string,
		public readonly storedVersion: number,
		public readonly codeVersion: number,
	) {
		super(
			`Database "${dbName}" is at schema version ${storedVersion}, newer than this build's schema version ${codeVersion}: a newer build of the app already migrated it. It was not opened and nothing in it changed. Run the newer build (reload while online, or accept the update); never lower schema.version in a deployed app.`,
			'SCHEMA_VERSION_AHEAD',
			{ dbName, storedVersion, codeVersion },
		)
		this.name = 'SchemaVersionAheadError'
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
 * (in the error context). The same leader de-duplicates it; a leader that took
 * over since keeps no record of it, so a retried write may then apply twice.
 * Retriable.
 */
export class LeaderUnresponsiveError extends NoLeaderError {
	constructor(operation: string, silentMs: number, requestId: string) {
		super(
			operation,
			`The leader tab stopped responding (no heartbeat for ${silentMs}ms) during "${operation}". The request may or may not have been applied; retry it with the same requestId: the same leader de-duplicates it, but a leader that took over since cannot.`,
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
 * Thrown when an explicit local-database management operation needs exclusive
 * access but the database is open in some tab or worker on this origin.
 */
export class StorageInUseError extends KoraError {
	constructor(dbName: string) {
		super(
			`Database "${dbName}" is open in a tab on this origin; close it before managing its local storage.`,
			'STORAGE_IN_USE',
			{ dbName },
		)
		this.name = 'StorageInUseError'
	}
}

/** Thrown when an explicitly named local database does not exist. */
export class LocalDatabaseNotFoundError extends KoraError {
	constructor(dbName: string) {
		super(`Database "${dbName}" does not exist on this origin.`, 'LOCAL_DATABASE_NOT_FOUND', {
			dbName,
		})
		this.name = 'LocalDatabaseNotFoundError'
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

/**
 * Thrown by a local write while the store's pinned node id (an auth device id) belongs
 * to another user than the one signed in (F9): a browser two users shared. The write
 * could only be stored under the owner's node and would later upload as the owner's.
 */
export class NodeOwnedByAnotherUserError extends KoraError {
	constructor(nodeId: string, principal: string | null) {
		super(
			"This device belongs to another account, so changes made while this account is signed in here cannot be saved: they would be uploaded as the device owner's. Sign in as the device's owner, or use this account on its own device.",
			'NODE_OWNED_BY_ANOTHER_USER',
			{ nodeId, principal },
		)
		this.name = 'NodeOwnedByAnotherUserError'
	}
}

/** Builds named in a {@link BuildSupersededError}. */
export interface BuildSupersededInfo {
	/** The build this tab runs. */
	currentBuild: string
	/** The build of the tab that superseded it. */
	newerBuild: string
}

/**
 * Thrown by a write started in a tab that a tab running a newer build of the app (or a
 * later-opened deployment) has superseded (version gate). Nothing of the write was
 * applied. The tab is retiring: it shows "A new version of this app is available. Reload
 * to continue." and only a reload, which loads the newer build, brings writes back.
 * Retriable after the reload. A local refusal: never a server rejection.
 *
 * Carries the collection and operation that were refused, never the data.
 */
export class BuildSupersededError extends KoraError {
	readonly collection: string | undefined
	readonly operation: string
	readonly retriable = true

	constructor(scope: { collection?: string; operation: string }, info: BuildSupersededInfo) {
		super(
			`A newer version of this app (build "${info.newerBuild}") is open in another tab, so this tab (build "${info.currentBuild}") no longer writes to the local database: ${scope.operation}${scope.collection ? ` on "${scope.collection}"` : ''} was not applied. Reload the page to continue with the new version.`,
			'BUILD_SUPERSEDED',
			{
				...(scope.collection !== undefined ? { collection: scope.collection } : {}),
				operation: scope.operation,
				currentBuild: info.currentBuild,
				newerBuild: info.newerBuild,
				retriable: true,
			},
		)
		this.name = 'BuildSupersededError'
		this.collection = scope.collection
		this.operation = scope.operation
	}
}

/**
 * Thrown when the local database was opened by a build whose Kora storage format is newer
 * than this code's (version gate, section 3). Older code does not know the newer layout of
 * Kora's internal tables and keys, so the store refuses before writing anything and emits
 * `store:format-ahead`. Like a schema ahead, it never falls back to an empty database.
 *
 * Fix: run the newer build (reload while online). A release that bumps the format cannot
 * be rolled back by redeploying an earlier build.
 */
export class StorageFormatAheadError extends KoraError {
	constructor(
		public readonly dbName: string,
		public readonly storedFormat: number,
		public readonly codeFormat: number,
	) {
		super(
			`Database "${dbName}" uses Kora storage format ${storedFormat}, newer than this build's format ${codeFormat}: a newer build of the app already opened it. It was not opened and nothing in it changed. Run the newer build (reload while online).`,
			'STORAGE_FORMAT_AHEAD',
			{ dbName, storedFormat, codeFormat },
		)
		this.name = 'StorageFormatAheadError'
	}
}

/**
 * Thrown when a browser has no Web Locks: without them Kora cannot keep two tabs from
 * keeping separate copies of the database and overwriting each other's writes, so storage
 * open is refused (version gate, section 4.1.1). Every browser Kora supports has Web
 * Locks; test environments (jsdom, happy-dom) set `store.allowUncoordinatedTabs: true`.
 */
export class TabCoordinationUnavailableError extends KoraError {
	constructor(dbName: string) {
		super(
			`Database "${dbName}" was not opened: this browser has no Web Locks (navigator.locks), so Kora cannot keep two tabs of the app from overwriting each other's writes. Use a current browser. In a test environment without Web Locks, set store.allowUncoordinatedTabs: true.`,
			'TAB_COORDINATION_UNAVAILABLE',
			{ dbName },
		)
		this.name = 'TabCoordinationUnavailableError'
	}
}

/**
 * Thrown by a pending version gate open (or resume) when the gate was closed meanwhile
 * (the app or adapter closed while it waited for an older tab): storage does not open.
 */
export class VersionGateClosedError extends KoraError {
	constructor(dbName: string) {
		super(
			`The version gate of database "${dbName}" was closed before it opened; the database was not opened.`,
			'VERSION_GATE_CLOSED',
			{ dbName },
		)
		this.name = 'VersionGateClosedError'
	}
}

/**
 * Thrown by a local write whose operation is committed and visible but could not be made
 * durable before the promise resolved (IndexedDB fallback only: the snapshot that holds the
 * write failed, or the copy of the database it was made in was replaced).
 *
 * The write is NOT rolled back, so do not retry it: a retry would create a second record.
 * `context.operationId` names the operation; `context.reason` is `'save-failed'` (quota or
 * broken IndexedDB: the write stays in memory and in the outbound queue, and the store keeps
 * retrying the snapshot) or `'snapshot-superseded'` (the storage leader tab changed before
 * any snapshot held the write: it may be lost, and Kora cannot recover it). Tell the user
 * their last change may not have been saved.
 */
export class WriteNotDurableError extends KoraError {
	constructor(
		message: string,
		public readonly operationId: string,
		public readonly reason: 'save-failed' | 'snapshot-superseded',
		options?: { cause?: unknown; dbName?: string },
	) {
		super(message, 'WRITE_NOT_DURABLE', {
			operationId,
			reason,
			...(options?.dbName !== undefined ? { dbName: options.dbName } : {}),
			...(options?.cause !== undefined
				? { cause: options.cause instanceof Error ? options.cause.message : String(options.cause) }
				: {}),
		})
		this.name = 'WriteNotDurableError'
		if (options?.cause !== undefined) this.cause = options.cause
	}
}
