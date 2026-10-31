import type {
	ApplyFailureReason,
	ApplyResult,
	OfflineCompletion,
	Operation,
	OperationTransform,
	VersionVector,
} from '@korajs/core'
import type { QuarantinedOperation, SyncStatePersistence } from '../types'

export type { ApplyFailureReason, ApplyResult } from '@korajs/core'

/**
 * One delivery batch being applied in a single storage transaction (see
 * {@link SyncStore.applyDeliveryBatch}). Every method writes through that transaction;
 * `applyRemoteOperation` and `applyScopeRetraction` each run in their own savepoint, so a
 * failing one is undone alone and rejects.
 */
export interface SyncStoreBatch {
	/**
	 * Optional (C3b): the operations the engine is about to apply, so the store can read what
	 * they need in a few queries instead of a dozen per operation. Purely an optimization: an
	 * operation not announced is applied the same way, just with more reads.
	 */
	prefetch?(operations: readonly Operation[]): Promise<void>
	/** Apply one delivered operation (`position`: its delivery position, when known). */
	applyRemoteOperation(op: Operation, position: number | undefined): Promise<ApplyResult>
	/** Hide a record a scope retraction removed from the view, at `position`. */
	applyScopeRetraction(collection: string, recordId: string, position?: number): Promise<void>
	/** Record quarantined operations, and the watermark advance when given. */
	saveQuarantine(
		entries: QuarantinedOperation[],
		watermark?: { signature: string; watermark: number; completion?: OfflineCompletion },
	): Promise<void>
	/** Persist a view's delivery watermark (and the completion mark of a final batch). */
	saveDeliveryWatermark(
		signature: string,
		watermark: number,
		completion?: OfflineCompletion,
	): Promise<void>
	/**
	 * Run `effect` after the batch committed, in order with the store's own notifications.
	 * Dropped when the batch (or the step that registered it) rolls back.
	 */
	afterCommit(effect: () => void): void
}

/** Where a merged bulk replica's delivery progress lands in the live database. */
export interface BulkReplicationProgress {
	/** The delivery view (its signature) the replicated stream belonged to. */
	signature: string
	/** The delivery watermark the stream reached; every in-scope operation up to it is staged. */
	watermark: number
	/** The completion mark of the final batch, written with the watermark. */
	completion?: OfflineCompletion
}

/** What merging a bulk replica did. */
export type BulkReplicationMergeResult =
	| {
			kind: 'merged'
			operations: number
			records: number
			contestedRecords: number
			replayedOperations: number
			quarantined: number
			durationMs: number
			/** Events of the replica's applies that were not replayed to listeners (buffer cap). */
			eventsDropped?: number
			eventCounts?: Record<string, number>
			listenerErrors?: number
	  }
	| {
			kind: 'unmergeable'
			reason: string
			/** Stopped by the store closing, not because the stream cannot be merged. */
			cancelled?: true
	  }

/**
 * A scratch replica a large first sync is applied into before it is merged
 * (`docs/design/first-visit-parity.md` 5.7). The engine applies delivery batches into
 * `store` / `syncState` exactly as it would into the live database, then calls
 * {@link BulkReplication.merge} once with the final progress. Nothing about it is durable:
 * a crash or reload loses it and replication restarts from the live watermark.
 */
export interface BulkReplication {
	/** The replica's sync store: `applyDeliveryBatch` and the watermark live in it. */
	readonly store: SyncStore
	/** The replica's sync-state persistence, in the same database as {@link store}. */
	readonly syncState: SyncStatePersistence
	/**
	 * Merge the replica into the live database and write `progress` there, in the last
	 * transaction. The replica is closed afterwards whatever the outcome.
	 */
	merge(progress: BulkReplicationProgress): Promise<BulkReplicationMergeResult>
	/**
	 * Bytes the replica's database holds. The engine merges the staged prefix and continues
	 * directly when this passes `bulkReplication.maxBytes` (the replica lives in memory).
	 */
	sizeBytes?(): Promise<number>
	/**
	 * Drop the replica. A merge in flight is cancelled and awaited (bounded), so nothing
	 * commits after this resolves. Safe to call more than once.
	 */
	discard(): Promise<void>
	/**
	 * Tell the replica's clock the server's offset from this device's clock, as the live
	 * clock was told (a skew measured after the replica opened).
	 */
	setClockReferenceOffset?(offsetMs: number): void
}

/**
 * Interface that the local store must implement for sync.
 * This decouples @korajs/sync from @korajs/store — the store satisfies this interface.
 *
 * @korajs/store's Store class already implements these methods:
 * - getVersionVector() — returns the current version vector
 * - getNodeId() — returns this instance's nodeId
 * - applyRemoteOperation(op) — applies a remote op with dedup and merge
 * - getOperationRange(nodeId, fromSeq, toSeq) — fetches operations from the log
 */
export interface SyncStore {
	/** Get the current version vector for this store */
	getVersionVector(): VersionVector

	/** Get the node ID for this store instance */
	getNodeId(): string

	/**
	 * Apply a remote operation to the local store.
	 * Must handle deduplication (content-addressed) and merge resolution.
	 * @returns 'applied' if the operation was new, 'duplicate' if already seen, 'skipped' if filtered
	 */
	applyRemoteOperation(op: Operation): Promise<ApplyResult>

	/**
	 * Optional (C3): apply one delivery batch in a single storage transaction. `fn` runs
	 * inside it; when `fn` resolves the transaction commits, when it rejects the
	 * transaction rolls back and nothing of the batch is kept or published. Returns null
	 * when the store cannot batch now (the engine then applies operation by operation).
	 * The engine uses it only when {@link storageIdentity} matches its sync-state
	 * persistence's, so the watermark is written in the same database transaction.
	 */
	applyDeliveryBatch?<T>(fn: (batch: SyncStoreBatch) => Promise<T>): Promise<{ value: T } | null>

	/**
	 * Optional (first-visit parity S3): open a scratch replica to apply a large initial
	 * delivery stream into before merging it into this store. Null when this store cannot
	 * stage now (no in-memory engine, legacy materialization, records kept by a narrowing);
	 * the engine then applies the stream directly, as always.
	 */
	beginBulkReplication?(options?: { explicit: boolean }): Promise<BulkReplication | null>

	/**
	 * Optional: an object identifying the database this store writes to. Equal to
	 * {@link SyncStatePersistence.storageIdentity} when both live in one database.
	 */
	storageIdentity?(): object

	/**
	 * Optional: the schema transforms the store folds with (transforms at fold time,
	 * RT-84). The engine hands the store every operation exactly as delivered; the store
	 * folds its view. When present, it must match the engine's `operationTransforms`.
	 */
	getOperationTransforms?(): readonly OperationTransform[]

	/**
	 * Get operations from a specific node within a sequence range.
	 * Used for computing deltas during sync.
	 * @param nodeId - The originating node
	 * @param fromSeq - Start sequence number (inclusive)
	 * @param toSeq - End sequence number (inclusive)
	 */
	getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]>

	/**
	 * Optional: re-stamp never-acknowledged local operations after a fast device
	 * clock was corrected (timestamp rebase). Optional so hand-rolled SyncStore
	 * implementations keep working; when absent the engine simply skips the
	 * rebase and falls back to the clock-block behavior.
	 *
	 * @param ids - Operation ids that are candidates for re-stamping
	 * @param correctedNowMs - Trusted "now" (server time at handshake) in ms
	 */
	/**
	 * Optional: move the device to a fresh node id, re-authoring the given unsynced
	 * operations under it (RT-21). Called after the server refused the node id
	 * (`NODE_ID_CLAIMED`). Returns the new node id and the rewritten operations.
	 */
	rotateNodeId?(ids: string[]): Promise<{
		nodeId: string
		operations: Operation[]
		/** Old operation id -> its re-authored id. */
		idMapping?: Record<string, string>
	}>

	/**
	 * Optional: the server refused the store's pinned node id as another user's (`true`),
	 * or accepted it again (`false`). A pinned store refuses local writes meanwhile (F9).
	 */
	setPinnedNodeOwnedElsewhere?(owned: boolean): void

	/**
	 * Optional: re-author another local node's given unsynced operations under a fresh
	 * node id bound to `principal`, without moving the store's own node. Called when the
	 * server refused an adopted node whose writes belong to the signed-in user but that
	 * no claims-aware server ever accepted (a beta.12 node with unowned history).
	 */
	reauthorLocalNode?(
		fromNodeId: string,
		ids: string[],
		principal: string,
	): Promise<{ nodeId: string; operations: Operation[]; idMapping?: Record<string, string> }>

	/**
	 * Optional: re-author the given operations of a retired local node (one this
	 * database's pinned node moved off, possibly shared with another user's database)
	 * under the store's own node, or a fresh node of the same user when that is not
	 * possible. The engine passes only operations the server said it does not store.
	 */
	reauthorIntoOwnNode?(
		fromNodeId: string,
		ids: string[],
	): Promise<{ nodeId: string; operations: Operation[]; idMapping?: Record<string, string> }>

	/**
	 * Optional: move the device back to a node id this database authored under before
	 * (RT-38), without rewriting anything. Used after the server refused the current node
	 * (another principal owns it) to try a node the signed-in principal owns.
	 */
	switchNodeId?(nodeId: string): Promise<void>

	/**
	 * Optional: bind local writes to the signed-in user (RT-42). Moves the store to the
	 * user's own node (or a fresh one) when the current node belongs to another user.
	 * `conflict`: the node id is pinned and belongs to another user.
	 */
	/** The user signed out: stop filling stamped fields with the previous user. */
	clearSignedInUser?(): void
	bindPrincipal?(principal: string): Promise<{
		nodeId: string
		previousNodeId: string
		switched: boolean
		conflict: boolean
	}>

	/**
	 * Optional durability barrier (RT-35): resolve once every write committed so far is
	 * durable on this device; reject when it cannot be made durable. The engine awaits it
	 * before any operation leaves the device, so the server never holds an operation the
	 * device could lose on reload.
	 */
	ensureDurable?(): Promise<void>

	/**
	 * Optional: raise a local node's sequence counter to at least `floor`, in a
	 * transaction (RT-35: the server holds operations of this node the device lost).
	 * @returns Whether the counter moved
	 */
	raiseSequenceFloor?(nodeId: string, floor: number): Promise<boolean>

	/**
	 * Optional: give a local operation a fresh sequence number above `floor` (RT-35: the
	 * server refused it with `SEQUENCE_CONFLICT` because it holds another operation of
	 * this node, lost locally, under that number). A version-2 operation is re-hashed
	 * under a new id; its never-sent dependents (`rewritableDependents`) are rewritten
	 * to name the new id, transitively.
	 * @returns The renumbered operation, the rewritten dependents and the id mapping,
	 *   or null when it is not in the log
	 */
	resequenceOperation?(
		operationId: string,
		nodeId: string,
		floor: number,
		rewritableDependents?: readonly string[],
	): Promise<{
		operation: Operation
		dependents: Operation[]
		idMapping: Record<string, string>
	} | null>

	/**
	 * Optional: take over another local node id's unsynced writes (RT-40). Resolves to a
	 * release function when no live tab uses it, or null when one does.
	 */
	claimLocalNode?(nodeId: string): Promise<(() => void) | null>

	rebaseUnsyncedOperations?(
		ids: string[],
		correctedNowMs: number,
	): Promise<{ operations: Operation[]; idMapping: Record<string, string>; rebasedCount: number }>

	/**
	 * Optional (W7): the server's node ids whose writes win `merge('server-
	 * authoritative')` fields, from the handshake response. The store persists them
	 * and folds with them (re-folding affected records when the set changes).
	 */
	setAuthoritativeNodeIds?(
		nodeIds: readonly string[],
		revokedNodeIds?: readonly string[],
	): Promise<void>

	/**
	 * Optional: read a record's current materialized field values, used to backfill
	 * scope / query-subset fields that a partial update (or a delete) does not carry
	 * in its own data. Without it, such an operation would be judged out of scope by
	 * its changed fields alone and wrongly dropped from sync. Optional so hand-rolled
	 * SyncStore implementations keep working; when absent, the engine falls back to
	 * judging visibility from the operation's own data.
	 *
	 * @returns the record's fields, or null when it cannot be read.
	 */
	readRecordFields?(collection: string, recordId: string): Promise<Record<string, unknown> | null>

	/**
	 * Optional: whether the local schema defines this collection. Lets the engine tell a
	 * merge-decided `'skipped'` (the record is settled, nothing to keep) from a skip
	 * because the collection is unknown (the operation must be quarantined and replayed
	 * after a schema upgrade). Without it every `'skipped'` result is quarantined.
	 */
	hasCollection?(collection: string): boolean

	/**
	 * Remove a record from this client's materialized authorization view without
	 * writing a domain delete to the replicated operation log.
	 */
	applyScopeRetraction?(collection: string, recordId: string, position?: number): Promise<void>
	/**
	 * Optional: where in the delivery stream the operation about to be applied was
	 * delivered (`position` absent: unknown; `replay`: a quarantine replay), or `null` to
	 * clear it. A record a scope retraction hid is shown again only by an operation
	 * delivered after the retraction.
	 */
	noteDeliveryPosition?(
		operationId: string,
		position: { position?: number; replay: boolean } | null,
	): void
	/**
	 * Optional: a delivery run starts at `watermark`. Positions a run that went further
	 * recorded (retraction markers, quarantined operations) move before it, so the new
	 * run decides a record's visibility.
	 */
	rebaseDeliveryRun?(watermark: number): Promise<void>
	/**
	 * Access rules: retract every materialized row of `collection` outside `scope`
	 * (null: every row), except the record ids in `keep` (rows with unsent local
	 * operations). Returns the retracted ids.
	 */
	applyCollectionNarrowing?(
		collection: string,
		scope: Record<string, unknown> | null,
		keep: ReadonlySet<string>,
		position?: number,
	): Promise<string[]>
	/**
	 * Hide the records a narrowing kept for their unsent operations once none is pending
	 * and they are still outside the narrowed scope (an operation was refused).
	 */
	recheckAccessNarrowing?(
		pending: (collection: string) => ReadonlySet<string>,
		options?: { retractedOnly?: boolean; position?: number },
	): Promise<Array<{ collection: string; recordId: string }>>
	/**
	 * Defer the retraction of an access-collection record with unsent writes until they
	 * resolve. False when the collection is not access-controlled (retract now).
	 */
	deferScopeRetraction?(collection: string, recordId: string): Promise<boolean>
	/**
	 * Retract every currently materialized row outside a newly accepted scope. With
	 * `shouldContinue`, the store checks it before each retraction and stops once it
	 * returns false (the session that accepted the scope ended), returning what it did.
	 */
	applyScopeNarrowing?(
		scopes: Record<string, Record<string, unknown>>,
		options?: { shouldContinue?: () => boolean; position?: number },
	): Promise<Array<{ collection: string; recordId: string }>>

	/**
	 * Optional (W7): the delivery stream caught up (its final batch fully applied).
	 * The store retires local-only provisional cascades of remote deletes (RT-69) and
	 * drops row snapshots whose history a full resync brought back (RT-68). With
	 * `provisionalOnly` it only retires the provisional cascades: a stream batch that is
	 * not the end of a resync must not settle row snapshots (RT-93).
	 *
	 * @returns How many row snapshots were dropped
	 */
	settleAfterCatchUp?(options?: { provisionalOnly?: boolean }): Promise<number>
}
