import type { ConnectionQuality, Operation, SyncDiagnosticsSnapshot } from '../types'

export interface SyncApplyFailureEvent {
	operationId: string
	collection: string
	recordId: string
	code: string
	message: string
	retriable: boolean
	firstSeenAt: number
	retryCount: number
}

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
			type: 'sync:suspended'
			reason: 'auth-loading' | 'auth-required' | 'auth-rejected' | 'device-revoked' | string
	  }
	| { type: 'sync:apply-blocked'; failure: SyncApplyFailureEvent }
	| { type: 'sync:apply-retrying'; failure: SyncApplyFailureEvent }
	| { type: 'sync:apply-recovered'; failure: SyncApplyFailureEvent }
	| { type: 'sync:apply-abandoned'; failure: SyncApplyFailureEvent }
	| {
			type: 'sync:clock-skew'
			/** serverTime - localTime in ms. Negative = this device's clock is fast. */
			skewMs: number
			severity: 'info' | 'slow-warning' | 'fast-blocked'
			source: 'handshake' | 'server-reject'
	  }
	| {
			/**
			 * The server refused this device's node id (`NODE_ID_CLAIMED`, RT-21), so the
			 * device moved to a fresh node id and re-queued its unsynced writes under it.
			 */
			type: 'sync:node-id-rotated'
			previousNodeId: string
			nodeId: string
			/** Unsynced operations re-authored under the new node id. */
			reenqueuedCount: number
			/**
			 * Unsynced operations left under the previous node id, held for the principal
			 * that owns it (RT-38): they upload when that user signs in again on this device.
			 */
			heldCount?: number
	  }
	| {
			/**
			 * Sync bookkeeping of one of this database's own node ids (Phase 2):
			 * - `history-behind`: the server holds more of this node's operations than the
			 *   device (its log lost a tail, RT-35); the counter was raised past them and a
			 *   full resync fetches them back.
			 * - `adoption-started` / `adoption-completed` / `adoption-refused`: the engine
			 *   uploads the unsynced writes of a node no live tab uses (RT-40).
			 * - `held`: the server refused this node for the signed-in principal; its unsynced
			 *   writes wait for the principal that owns it (RT-38).
			 * - `server-behind`: the server holds fewer of this node's operations than the
			 *   device had acknowledged (a server restored from a backup, RT-45); the device
			 *   re-uploads them from the server's position.
			 * - `adoption-parked`: an adopted node made no upload progress for a whole session
			 *   (for example a write the server keeps deferring); the next session tries the
			 *   other nodes first (RT-46).
			 * - `clone-detected`: another live copy of this database uses the same node id
			 *   (copied app data, a restored image); this copy moved to a fresh node id (RT-44).
			 * - `principal-switched`: the signed-in user changed; local writes from now on are
			 *   authored under that user's own node (RT-42).
			 * - `held-assigned` / `held-discarded`: the app assigned a held node's writes to
			 *   the signed-in user, or discarded them from sync (RT-50).
			 */
			type: 'sync:local-node'
			nodeId: string
			action:
				| 'history-behind'
				| 'server-behind'
				| 'adoption-started'
				| 'adoption-completed'
				| 'adoption-refused'
				| 'adoption-parked'
				| 'held'
				| 'clone-detected'
				| 'principal-switched'
				| 'held-assigned'
				| 'held-discarded'
			/** For `history-behind` / `server-behind`: the device's sequence and the server's. */
			localSequence?: number
			serverSequence?: number
			/** Unsynced operations concerned, when known. */
			operationCount?: number
	  }
	| {
			type: 'sync:clock-rebase'
			/** Number of unsynced operations that were re-stamped. */
			rebasedCount: number
			/** How far ahead of server time the most future queued operation was, in ms. */
			maxSkewMs: number
	  }
	| { type: 'sync:sent'; operations: Operation[]; batchSize: number }
	| {
			type: 'sync:received'
			operations: Operation[]
			batchSize: number
			/** Server-ingest outcomes. Omitted for ordinary client-side receive events. */
			uniqueOperations?: number
			duplicateOperations?: number
			rejectedOperations?: number
	  }
	| { type: 'sync:acknowledged'; sequenceNumber: number }
	| {
			type: 'sync:scope-retracted'
			collection: string
			recordId: string
			quarantinedOperationIds: string[]
	  }
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
	| {
			type: 'sync:delivery-gap'
			expectedBase: number
			receivedBase: number
			currentWatermark: number
			messageId: string
			repeatCount: number
	  }
	| {
			type: 'sync:delivery-stalled'
			sessionId: string
			watermark: number
			outstandingMaxDeliverySequence: number
			repeatCount: number
			reason: 'unacknowledged-delivery'
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
			/**
			 * The local database could not be made durable before an upload several times in
			 * a row (storage quota exceeded, IndexedDB broken; RT-49). Uploads no longer wait
			 * for it, so the server holds the only durable copy of new writes (a reload
			 * recovers them from it) until `sync:durability-restored`. Writes are still
			 * accepted; warn the user (free up storage, stay online).
			 */
			type: 'sync:durability-degraded'
			message: string
			failedAttempts: number
	  }
	| { type: 'sync:durability-restored' }
	| {
			type: 'store:quota-exceeded'
			dbName: string
			message: string
	  }
	| {
			/**
			 * The log-integrity scan (W8 step 0) changed the operation log: it repaired rows
			 * written by an earlier release (a JSON-encoded timestamp from a beta.12 backup
			 * restore) and/or moved rows it could not repair to the quarantine table, where
			 * no fold reads them. `clean` is false while anything is quarantined or this
			 * database's own nodes have sequence gaps. See `store.verifyLogIntegrity()`.
			 */
			type: 'store:log-integrity'
			dbName: string
			repaired: number
			quarantined: number
			gaps: number
			clean: boolean
			message: string
	  }
	| {
			/**
			 * The database was re-materialized with the W7 per-field fold (once, on the
			 * first open with fold-state version N, or after a replace-mode restore).
			 * `mode`: `'log'` rebuilt every record from its clean log (repairing
			 * pre-W7 divergence); `'snapshot+log'` used each row as a base snapshot
			 * because the log was compacted or has gaps; `'kept'` left every row as it
			 * was because the log has quarantined rows (never rebuilt from).
			 */
			type: 'store:rematerialized'
			dbName: string
			mode: 'log' | 'snapshot+log' | 'kept'
			records: number
			changedRows: number
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
			 * A preferred storage backend could not provide durable storage, so Kora
			 * promoted the app to another durable backend before user code observed the
			 * store. This is informational: data still survives reloads.
			 */
			type: 'store:storage-fallback'
			dbName: string
			from: 'opfs' | 'sqlite-wasm'
			to: 'indexeddb'
			reason: 'lock-conflict' | 'timeout' | 'unsupported'
			message: string
	  }
	| {
			/**
			 * BLOCKING. The store could not obtain durable storage when it opened or when
			 * this tab was promoted to storage leader, so it is running on a
			 * non-persistent in-memory database. Writes are refused with
			 * `StorageDurabilityError` (unless the app opted into non-durable storage)
			 * instead of being accepted and lost on reload. Apps should show a blocking
			 * state, for example asking the user to close other tabs and reload.
			 */
			type: 'store:durability-lost'
			dbName: string
			phase: 'open' | 'promotion'
			reason: 'lock-conflict' | 'timeout' | 'unsupported' | 'open-failed'
			message: string
	  }
	| {
			/**
			 * BLOCKING while `state` is `waiting`. Another holder (a previous storage
			 * owner still shutting down, or a tab running an older Kora that does not
			 * take part in the ownership protocol) has the database's OPFS storage, so
			 * the open waits instead of falling back to non-durable storage. Apps
			 * should show a "close other tabs of this app" state; `resolved` follows
			 * when the wait ends.
			 */
			type: 'store:storage-blocked'
			dbName: string
			/** `pool`: the database's own pool; `legacy-pool`: the pre-W8a shared pool. */
			resource: 'pool' | 'legacy-pool'
			state: 'waiting' | 'resolved'
			waitedMs?: number
			message: string
	  }
	| {
			/**
			 * Informational. The database's data was moved between storage locations
			 * explicitly (the pre-W8a shared OPFS pool to the database's own pool, or
			 * between OPFS and IndexedDB), so there is still exactly one copy.
			 */
			type: 'store:storage-migrated'
			dbName: string
			from: 'legacy-opfs-pool' | 'opfs' | 'indexeddb'
			to: 'opfs' | 'indexeddb'
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
