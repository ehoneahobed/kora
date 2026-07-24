import type { HybridLogicalClock, Operation, SchemaDefinition } from '@korajs/core'
import type { SyncStore } from '@korajs/sync'

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
}

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
 * Server-side store interface. Extends SyncStore with lifecycle,
 * introspection, and materialization methods needed by the sync server.
 */
export interface ServerStore extends SyncStore {
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
