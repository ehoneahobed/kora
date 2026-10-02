import type { HLCTimestamp, HybridLogicalClock, Operation, SchemaDefinition } from '@korajs/core'
import type { ApplyResult, SyncStore } from '@korajs/sync'
import type { UplinkAuthorizationResult } from '../scopes/server-scope-filter'

/**
 * Owner recorded for a node id an admin released (see `ServerStore.releaseNodeClaim`):
 * the next principal to claim the node takes it over. Never a valid principal id.
 */
export const RELEASED_NODE_OWNER = ''

/**
 * A materialized record reconstructed from the operation log
 * or read from a materialized collection table.
 */
export interface MaterializedRecord {
	id: string
	[key: string]: unknown
}

/**
 * A conditional, atomic multi-operation apply. The store reads the target under a
 * cross-instance lock, lets the caller decide admission and build the operations
 * against that locked state, and applies them in one transaction, or applies
 * nothing. `admit` and `buildOperations` run inside the locked transaction so the
 * predicate check and any atomic-op resolution see the authoritative current value
 * even when multiple server instances race on the same target.
 */
export interface ConditionalApplyInput {
	/** Record the admission lock and predicate are keyed on. */
	target: { collection: string; id: string }
	/** Decides admission against the target's locked current state. */
	admit: (current: MaterializedRecord | null) => boolean
	/**
	 * Builds the operations to apply, given the locked current state and a clock the
	 * store has already advanced past the target record's latest committed operation.
	 * Stamping the built operations with this clock guarantees they sort strictly
	 * after every prior write to the target, so last-write-wins materialization
	 * reflects the serialized commit order even when two instances commit in the same
	 * millisecond. Without it, a same-millisecond tie could let materialization pick
	 * an earlier resolved value and undercount an atomic counter, admitting past a cap.
	 */
	buildOperations: (
		current: MaterializedRecord | null,
		context: ConditionalApplyContext,
	) => Promise<Operation[]>
	/**
	 * When set, a record whose prior existence proves this set already committed.
	 * Checked under the same lock as admission, so a retry is idempotent even across
	 * instances: it returns `idempotent: true` without re-running the operations.
	 */
	idempotencyKey?: { collection: string; id: string }
}

/** Context passed to {@link ConditionalApplyInput.buildOperations}. */
export interface ConditionalApplyContext {
	/**
	 * A clock the store has advanced past the target record's latest committed
	 * operation. Operations built here must be stamped with it (route context threads
	 * it into operation creation) so they sort strictly after every prior write.
	 */
	clock: HybridLogicalClock
	/**
	 * Read a record as stored (including a soft-deleted one) inside the store's
	 * conditional-apply transaction, for authorizing the built operations against the
	 * same state they commit over. Optional; callers fall back to a plain read.
	 */
	readStoredRow?: (collection: string, id: string) => Promise<MaterializedRecord | null>
}

/** Result of {@link ServerStore.applyConditional}. */
export interface ConditionalApplyResult {
	/** True when the predicate held (or the set was already committed). */
	admitted: boolean
	/** True when the idempotency key already existed and nothing was re-applied. */
	idempotent: boolean
	/** The operations that were applied (empty when not admitted or idempotent). */
	applied: Operation[]
}

/**
 * A stored operation paired with its server-assigned delivery sequence. The
 * delivery sequence is monotonic in commit order, so a batch of these can be
 * chained (each batch's base links to the previous batch's max) to give the
 * client a gap-free, scope-agnostic recovery stream.
 */
export interface DeliveredOperation {
	operation: Operation
	deliverySequence: number
	/**
	 * The record's scope-relevant values around this operation, captured from the
	 * server's own rows when it was applied (RT-14, RT-15). Absent (or null) for
	 * operations stored before snapshots existed that could not be backfilled.
	 */
	scopeSnapshot?: OperationScopeSnapshot | null
}

/**
 * Scope-relevant field values of a record, captured by the store from its own rows
 * when an operation is applied (never from the writer's `previousData`). Download
 * visibility of a historical operation is judged on `post`, so a later ownership
 * transfer does not disclose the record's earlier history to the new owner (RT-14),
 * and a scope exit is judged from `pre` to `post` (RT-15).
 *
 * Only scalar fields (string, number, boolean, enum, timestamp) and `id` are kept:
 * scope predicates compare with `Object.is`, so other kinds can never match. A
 * string longer than {@link MAX_SCOPE_SNAPSHOT_STRING_LENGTH} is left out (fails
 * closed for a scope on such a field) so a snapshot never copies large text.
 */
export interface OperationScopeSnapshot {
	/** Values before the operation; null when the record did not exist or was deleted. */
	pre: Record<string, unknown> | null
	/** Values after it; a delete keeps the record's last values; null when unknown. */
	post: Record<string, unknown> | null
}

/** Longest string value copied into an {@link OperationScopeSnapshot}. */
export const MAX_SCOPE_SNAPSHOT_STRING_LENGTH = 512

/**
 * Options for querying a materialized collection table.
 */
export interface CollectionQueryOptions {
	/** Exact-match filters on field values */
	where?: Record<string, unknown>
	/** Field name to order results by */
	orderBy?: string
	/** Sort direction (default: 'asc') */
	orderDirection?: 'asc' | 'desc'
	/** Maximum number of records to return */
	limit?: number
	/** Number of records to skip (for pagination) */
	offset?: number
	/** Include soft-deleted records (default: false) */
	includeDeleted?: boolean
}

/**
 * Options for {@link ServerStore.applyRemoteOperation}.
 */
export interface ApplyRemoteOptions {
	/**
	 * Authorization re-check for an operation submitted by an untrusted writer.
	 *
	 * The store calls it inside its apply critical section (the SQLite write
	 * transaction, the in-memory store's synchronous apply, or a Postgres
	 * transaction holding the per-record advisory lock shared with conditional
	 * applies) with the record as stored at that moment, including a soft-deleted
	 * one, or null when none exists. Returning a refusal aborts the apply and the
	 * store throws {@link UplinkAuthorizationError}; nothing is written.
	 *
	 * This closes the window between a caller's own pre-check and the write, where an
	 * ownership change or a same-id insert committed by another writer (or another
	 * server instance) could otherwise slip in.
	 */
	authorize?: (storedRow: MaterializedRecord | null) => UplinkAuthorizationResult
}

/**
 * Server-side store interface. Extends SyncStore with lifecycle,
 * introspection, and materialization methods needed by the sync server.
 */
export interface ServerStore extends SyncStore {
	/**
	 * Apply an operation to the log and materialized state. With
	 * `options.authorize`, the authorization is re-checked atomically with the write
	 * (see {@link ApplyRemoteOptions}). Stores written before this option existed
	 * may ignore it; callers always pre-check as well.
	 */
	applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult>

	/**
	 * Bind a client node id to the authenticated principal that first used it.
	 * Returns true when the node id is already owned by `userId`, was released by an
	 * admin (see {@link releaseNodeClaim}; the caller takes it over), or is unclaimed
	 * AND has no operation history. Returns false when another principal owns it, or
	 * when it is unclaimed but already has operations in the log: history written
	 * before node claims existed has no recorded writer, so nobody may adopt it
	 * until an admin releases it (RT-5). Called at handshake when auth is configured,
	 * so one user cannot upload operations under another user's device id. Every
	 * write after this check is preceded by a claim, so going forward the claim row
	 * records the writer of a node's history. Must be atomic per node id. Optional
	 * for custom stores; the built-in stores persist the claim.
	 */
	claimNode?(nodeId: string, userId: string): Promise<boolean>
	/**
	 * Admin release of a node id (RT-5): the next principal to claim it takes it
	 * over, even when the node has operation history. Returns true when the node had
	 * a claim or history to release, false when it was unknown.
	 */
	releaseNodeClaim?(nodeId: string): Promise<boolean>
	/**
	 * The owner a node id is currently claimed by, or null when unclaimed (RT-21).
	 * Optional; anonymous provisional claims need it together with
	 * {@link replaceNodeClaim}.
	 */
	getNodeClaimOwner?(nodeId: string): Promise<string | null>
	/**
	 * Atomically replace the owner of a node claim, only if it is still
	 * `expectedOwner` (compare-and-set, RT-21). Returns true when replaced. Used to
	 * confirm or re-issue an anonymous device's provisional claim; never creates one.
	 */
	replaceNodeClaim?(nodeId: string, expectedOwner: string, newOwner: string): Promise<boolean>
	/**
	 * Record that `owner` holds the bytes behind a blob content hash (it pushed them,
	 * proving possession) (RT-11). Idempotent. Optional; without it the sync server
	 * keeps ownership in memory (lost on restart, not shared between instances).
	 */
	recordBlobOwner?(hash: string, owner: string): Promise<void>
	/** The owners recorded for each hash (an empty list for unowned hashes). */
	getBlobOwners?(hashes: string[]): Promise<Map<string, string[]>>
	/**
	 * Atomically make `owner` the first owner of a hash nobody owns yet. Returns true
	 * when `owner` owns the hash afterwards (newly, or already), false when someone
	 * else does. Must be atomic per hash across server instances.
	 */
	claimBlobIfUnowned?(hash: string, owner: string): Promise<boolean>
	/**
	 * The scope snapshots captured when the given operations were applied (RT-14).
	 * Operations without one are absent from the result.
	 */
	getOperationScopeSnapshots?(operationIds: string[]): Promise<Map<string, OperationScopeSnapshot>>
	/**
	 * The greatest HLC timestamp among every stored operation of one record (its
	 * newest field write), or null when the record has no operations (RT-19). A
	 * scope-entry operation is stamped with it so it never overrides newer client data.
	 */
	getRecordLatestTimestamp?(collection: string, recordId: string): Promise<HLCTimestamp | null>
	/** Close the store and release resources */
	close(): Promise<void>

	/** Get the total number of stored operations */
	getOperationCount(): Promise<number>

	/**
	 * The highest delivery sequence currently visible in the store (0 when empty).
	 * Used to initialize a fresh client's watermark baseline and for diagnostics.
	 */
	getMaxDeliverySequence(): Promise<number>

	/**
	 * Operations with `deliverySequence > afterDeliverySequence`, ordered ascending
	 * by delivery sequence, at most `limit` of them. This is the substrate for the
	 * gap-free server->client stream: the caller (a client session) applies its own
	 * scope filter and chains the results into batches, advancing the client's
	 * durable watermark as batches are acknowledged. Because delivery sequence is
	 * assigned in commit order, a lower sequence is always visible before any higher
	 * one, so this scan can never skip an operation that later appears below the
	 * cursor.
	 */
	getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]>

	/**
	 * Conditionally apply a set of operations atomically, serialized across server
	 * instances on the target record. Optional: stores that can only run in a single
	 * process (or do not back a shared database) may omit it, and callers fall back
	 * to per-instance serialization. The Postgres store implements it with a
	 * transaction-scoped advisory lock so concurrent admissions cannot both pass a
	 * cap check (`applyConditional` returns `admitted: false` for the loser).
	 */
	applyConditional?(input: ConditionalApplyInput): Promise<ConditionalApplyResult>

	/**
	 * Atomically reserve the next sequence number for a server-originated operation
	 * on this store's own node. Stores that serve conditional applies concurrently
	 * (the Postgres store, which does not serialize behind a single mutation tail)
	 * must implement this so two in-flight server operations cannot be handed the
	 * same sequence number, which would let one shadow the other during version-vector
	 * delta sync. Stores whose server writes are fully serialized may omit it, and
	 * callers fall back to reading the version vector.
	 */
	reserveSequenceNumber?(): number

	/**
	 * Set the schema for materialized collection tables.
	 * Creates collection tables and indexes based on the schema definition.
	 * If operations already exist in the store, backfills the materialized
	 * tables from the operation log.
	 *
	 * @param schema - The schema definition describing all collections
	 */
	setSchema(schema: SchemaDefinition): Promise<void>

	/** Schema used for materialized tables and server-side validation, if set. */
	getSchema(): SchemaDefinition | null

	/**
	 * Get all records from a materialized collection.
	 * When schema is set, reads directly from the collection table (O(1) indexed).
	 * When schema is not set, falls back to replaying the operation log.
	 * Deleted records are excluded.
	 *
	 * @param collection - The collection name to query
	 * @returns Array of records with their current state
	 */
	materializeCollection(collection: string): Promise<MaterializedRecord[]>

	/**
	 * Query records from a materialized collection with filtering, ordering,
	 * and pagination. Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name to query
	 * @param options - Query options (where, orderBy, limit, offset)
	 * @returns Array of matching records
	 */
	queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]>

	/**
	 * Find a single record by ID from a materialized collection.
	 * Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name
	 * @param id - The record ID
	 * @returns The record or null if not found (or deleted)
	 */
	findRecord(collection: string, id: string): Promise<MaterializedRecord | null>

	/**
	 * Count records in a materialized collection, optionally filtered.
	 * Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name
	 * @param where - Optional exact-match filters
	 * @returns Number of matching records
	 */
	countCollection(collection: string, where?: Record<string, unknown>): Promise<number>

	/**
	 * Export all data as a portable backup binary.
	 * Ships operations, version vector, and metadata in a self-describing format
	 * with SHA-256 checksum.
	 */
	exportBackup(): Promise<Uint8Array>

	/**
	 * Restore data from a portable backup binary.
	 * Operations are applied through applyRemoteOperation for safe merge.
	 *
	 * @param data - Backup binary
	 * @param merge - If true, merge with existing operations; if false, replace all
	 */
	importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }>
}
