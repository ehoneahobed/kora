import {
	CausalTracker,
	HybridLogicalClock,
	createVersionVector,
	generateUUIDv7,
	migrationStepsToSQL,
} from '@korajs/core'
import type {
	KoraEventEmitter,
	MigrationStep,
	Operation,
	OperationLog,
	SchemaDefinition,
	VersionVector,
} from '@korajs/core'
import { readBackupManifest as readManifest } from '../backup/backup'
import type { BackupManifest, BackupOptions, RestoreOptions, RestoreResult } from '../backup/types'
import { Collection } from '../collection/collection'
import { compactOperationLog } from '../compaction/compact-operation-log'
import type { CompactionResult, CompactionStrategy } from '../compaction/types'
import { StoreNotOpenError } from '../errors'
import { isIncomingNewerThanRow, serializeRowVersion } from '../lww/row-version'
import type { LocalMutationContext } from '../mutations/types'
import { QueryBuilder } from '../query/query-builder'
import {
	buildInsertQuery,
	buildLwwSoftDeleteQuery,
	buildLwwUpdateQuery,
	buildSoftDeleteQuery,
	buildUpdateQuery,
} from '../query/sql-builder'
import { RelationEnforcer } from '../relations/relation-enforcer'
import { buildReplaySnapshot } from '../replay/replay-to'
import type { ReplaySnapshot } from '../replay/replay-to'
import { SequenceManager } from '../sequences/sequence-manager'
import {
	deserializeOperationWithCollection,
	deserializeRecord,
	serializeOperation,
	serializeRecord,
} from '../serialization/serializer'
import { SubscriptionManager } from '../subscription/subscription-manager'
import {
	collectOperationsAheadOfServer,
	loadDeltaCursor,
	loadLastAckedServerVector,
	mergeVersionVectors,
	saveDeltaCursor,
	saveLastAckedServerVector,
} from '../sync/sync-state'
import { TransactionContext } from '../transaction/transaction-context'
import { TransactionSequenceAllocator } from '../transaction/transaction-sequence'
import type {
	ApplyRemoteOptions,
	ApplyResult,
	LocalMutationHandler,
	MaterializedRowSnapshot,
	MetaRow,
	OperationRow,
	RawCollectionRow,
	StorageAdapter,
	StoreConfig,
	StoreIsolation,
	VersionVectorRow,
} from '../types'
import { allocateNextSequenceNumber } from './sequence-allocator'
import { resolvePerTabNodeId } from './tab-node-id'

/**
 * Store is the main orchestrator. It owns a schema, a storage adapter,
 * a clock, and a subscription manager. It creates Collection instances
 * for each schema collection, and provides the sync contract via
 * applyRemoteOperation and getOperationRange.
 *
 * @example
 * ```typescript
 * const store = new Store({ schema, adapter })
 * await store.open()
 * const todo = await store.collection('todos').insert({ title: 'Hello' })
 * await store.close()
 * ```
 */
export class Store implements OperationLog {
	private opened = false
	private nodeId = ''
	private sequenceNumber = 0
	private versionVector: VersionVector = createVersionVector()
	private clock: HybridLogicalClock | null = null
	private collections = new Map<string, Collection>()
	private subscriptionManager: SubscriptionManager
	private sequenceManager: SequenceManager | null = null

	private readonly schema: SchemaDefinition
	private readonly adapter: StorageAdapter
	private readonly configNodeId: string | undefined
	private readonly dbName: string
	private readonly isolation: StoreIsolation
	private readonly emitter: KoraEventEmitter | null
	private localMutationHandler: LocalMutationHandler | null
	private relationEnforcer: RelationEnforcer | null = null
	private causalTracker: CausalTracker | null = null

	constructor(config: StoreConfig) {
		this.schema = config.schema
		this.adapter = config.adapter
		this.configNodeId = config.nodeId
		this.dbName = config.dbName ?? 'kora-db'
		this.isolation = config.isolation ?? 'shared'
		this.emitter = config.emitter ?? null
		this.localMutationHandler = config.localMutationHandler ?? null
		this.subscriptionManager = new SubscriptionManager({
			onQuerySubscribed: config.onQuerySubscribed,
		})
	}

	/**
	 * Open the store: initialize the database, load or generate a node ID,
	 * restore the sequence number and version vector, and create Collection instances.
	 */
	async open(): Promise<void> {
		await this.adapter.open(this.schema)

		// Run schema migrations if needed
		await this.runMigrationsIfNeeded()

		// Load or generate node ID
		this.nodeId = await this.loadOrGenerateNodeId()
		this.clock = new HybridLogicalClock(this.nodeId)
		this.causalTracker = new CausalTracker()

		// Initialize sequence manager
		this.sequenceManager = new SequenceManager(this.adapter, this.nodeId)

		// Load sequence number and version vector
		this.sequenceNumber = await this.loadSequenceNumber()
		this.versionVector = await this.loadVersionVector()

		// Create RelationEnforcer if the schema has relations.
		// The enforcer is shared across all Collection instances so that
		// cascading deletes can cross collection boundaries.
		const hasRelations = Object.keys(this.schema.relations).length > 0
		this.relationEnforcer = hasRelations
			? new RelationEnforcer({
					schema: this.schema,
					adapter: this.adapter,
					clock: this.clock,
					nodeId: this.nodeId,
				})
			: null

		// Create collection instances
		for (const [name, definition] of Object.entries(this.schema.collections)) {
			const col = new Collection(
				name,
				definition,
				this.schema,
				this.adapter,
				this.clock,
				this.nodeId,
				() => this.allocateSequenceNumber(),
				(collectionName, operation) => {
					this.recordOperationSequence(operation)
					this.subscriptionManager.notify(collectionName, operation)
					if (this.emitter) {
						this.emitter.emit({ type: 'operation:created', operation })
					}
				},
				this.relationEnforcer,
				this.localMutationHandler,
				this.causalTracker,
			)
			this.collections.set(name, col)
		}

		this.opened = true
	}

	/**
	 * Close the store: clear subscriptions and close the adapter.
	 */
	async close(): Promise<void> {
		this.subscriptionManager.clear()
		this.collections.clear()
		this.opened = false
		await this.adapter.close()
	}

	/**
	 * Get a Collection instance for CRUD operations.
	 * @throws {StoreNotOpenError} If the store is not open
	 * @throws {Error} If the collection name is not in the schema
	 */
	collection(name: string): CollectionAccessor {
		this.ensureOpen()
		const col = this.collections.get(name)
		if (!col) {
			throw new Error(
				`Unknown collection "${name}". Available: ${[...this.collections.keys()].join(', ')}`,
			)
		}

		const definition = this.schema.collections[name]
		if (!definition) {
			throw new Error(`Collection definition not found for "${name}"`)
		}

		return {
			insert: (data: Record<string, unknown>) => col.insert(data),
			findById: (id: string) => col.findById(id),
			update: (id: string, data: Record<string, unknown>) => col.update(id, data),
			delete: (id: string) => col.delete(id),
			where: (conditions) =>
				new QueryBuilder(
					name,
					definition,
					this.adapter,
					this.subscriptionManager,
					conditions,
					this.schema,
				),
		}
	}

	/**
	 * Get the current version vector.
	 */
	getVersionVector(): VersionVector {
		this.ensureOpen()
		return new Map(this.versionVector)
	}

	/**
	 * Get the node ID for this store instance.
	 */
	getNodeId(): string {
		this.ensureOpen()
		return this.nodeId
	}

	/**
	 * Apply a remote operation received from sync.
	 * Checks for duplicates, applies to the data table, persists the operation,
	 * and updates the version vector.
	 */
	async applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult> {
		this.ensureOpen()

		const collection = op.collection
		const definition = this.schema.collections[collection]
		if (!definition) {
			return 'skipped'
		}

		// Check for duplicate (content-addressed dedup)
		const existing = await this.adapter.query<{ id: string }>(
			`SELECT id FROM _kora_ops_${collection} WHERE id = ?`,
			[op.id],
		)
		if (existing.length > 0) {
			return 'duplicate'
		}

		// Advance the local HLC; severe clock drift throws ClockDriftError (surfaced as sync:apply-failed).
		if (this.clock) {
			this.clock.receive(op.timestamp)
		}

		const remoteVersion = serializeRowVersion(op.timestamp)
		const wallTime = op.timestamp.wallTime

		// Apply the operation to the data table (LWW-guarded; op log always appended below)
		await this.adapter.transaction(async (tx) => {
			if (op.type === 'insert' && op.data) {
				const existing = await tx.query<RawCollectionRow>(
					`SELECT _updated_at, _version FROM ${collection} WHERE id = ?`,
					[op.recordId],
				)
				const row = existing[0]
				if (row && !isIncomingNewerThanRow(op.timestamp, row)) {
					// Stale remote insert — skip materialization, still record op below
				} else {
					const serializedData = serializeRecord(op.data, definition.fields)
					const record: Record<string, unknown> = {
						id: op.recordId,
						...serializedData,
						_created_at: wallTime,
						_updated_at: wallTime,
						_version: remoteVersion,
					}
					const insertQuery = buildInsertQuery(collection, record)
					await tx.execute(insertQuery.sql, insertQuery.params)
				}
			} else if (op.type === 'update' && op.data) {
				const serializedChanges = serializeRecord(op.data, definition.fields)
				const updatePayload: Record<string, unknown> = {
					...serializedChanges,
					_updated_at: wallTime,
					_version: remoteVersion,
				}
				if (options?.reactivateIfDeleted) {
					updatePayload._deleted = 0
				}
				const updateQuery = buildLwwUpdateQuery(
					collection,
					op.recordId,
					updatePayload,
					remoteVersion,
				)
				await tx.execute(updateQuery.sql, updateQuery.params)
			} else if (op.type === 'delete') {
				const deleteQuery = buildLwwSoftDeleteQuery(
					collection,
					op.recordId,
					wallTime,
					remoteVersion,
				)
				await tx.execute(deleteQuery.sql, deleteQuery.params)
			}

			// Persist the operation
			const opRow = serializeOperation(op)
			const opInsert = buildInsertQuery(
				`_kora_ops_${collection}`,
				opRow as unknown as Record<string, unknown>,
			)
			await tx.execute(opInsert.sql, opInsert.params)

			// Update version vector
			const currentSeq = this.versionVector.get(op.nodeId) ?? 0
			if (op.sequenceNumber > currentSeq) {
				this.versionVector.set(op.nodeId, op.sequenceNumber)
				await tx.execute(
					'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
					[op.nodeId, op.sequenceNumber],
				)
			}
		})

		// Notify subscriptions
		this.subscriptionManager.notify(collection, op)

		return 'applied'
	}

	/**
	 * Get operations from a node within a sequence number range.
	 * Implements the OperationLog interface for computeDelta.
	 */
	async getRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		return this.getOperationRange(nodeId, fromSeq, toSeq)
	}

	/**
	 * Get operations from a node within a sequence number range.
	 */
	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.ensureOpen()
		const allOps: Operation[] = []

		for (const collectionName of Object.keys(this.schema.collections)) {
			const rows = await this.adapter.query<OperationRow>(
				`SELECT * FROM _kora_ops_${collectionName} WHERE node_id = ? AND sequence_number >= ? AND sequence_number <= ? ORDER BY sequence_number ASC`,
				[nodeId, fromSeq, toSeq],
			)
			for (const row of rows) {
				allOps.push(deserializeOperationWithCollection(row, collectionName))
			}
		}

		// Sort by sequence number across collections
		allOps.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
		return allOps
	}

	/**
	 * Load every operation from the local append-only log across all collections.
	 * Used by sync delta computation, backup export, and time-travel replay.
	 */
	async getAllOperations(): Promise<Operation[]> {
		this.ensureOpen()
		const allOps: Operation[] = []

		for (const collectionName of Object.keys(this.schema.collections)) {
			const rows = await this.adapter.query<OperationRow>(
				`SELECT * FROM _kora_ops_${collectionName} ORDER BY sequence_number ASC`,
			)
			for (const row of rows) {
				allOps.push(deserializeOperationWithCollection(row, collectionName))
			}
		}

		return allOps
	}

	/**
	 * Rebuild an in-memory snapshot of materialized state at a causal cut in the op log.
	 * Does not mutate the live store — intended for DevTools time-travel inspection.
	 *
	 * @param operationId - Content-addressed id of the operation to replay through (inclusive)
	 * @throws {OperationError} When the operation id is not present in the local log
	 */
	async replayTo(operationId: string): Promise<ReplaySnapshot> {
		this.ensureOpen()
		const start = Date.now()
		const allOps = await this.getAllOperations()
		const snapshot = buildReplaySnapshot(this.schema, allOps, operationId)

		if (this.emitter) {
			this.emitter.emit({
				type: 'replay:completed',
				targetOperationId: operationId,
				operationsApplied: snapshot.operationsApplied.length,
				duration: Date.now() - start,
			})
		}

		return snapshot
	}

	/**
	 * Persist a merge trace to the durable audit log.
	 */
	async appendAuditTrace(trace: import('../audit/types').PersistedAuditTrace): Promise<void> {
		this.ensureOpen()
		const { appendAuditTrace: append } = await import('../audit/audit-trace-store')
		await append(this.adapter, trace)
	}

	/**
	 * Read persisted audit traces with optional filters.
	 */
	async getAuditTraces(
		query?: import('../audit/types').AuditTraceQuery,
	): Promise<import('../audit/types').PersistedAuditTrace[]> {
		this.ensureOpen()
		const { readAuditTraces } = await import('../audit/audit-trace-store')
		return readAuditTraces(this.adapter, query)
	}

	/**
	 * Export operations and merge traces as a portable audit bundle.
	 */
	async exportAudit(options?: import('../audit/types').AuditExportOptions): Promise<Uint8Array> {
		this.ensureOpen()
		const { exportAudit: doExport } = await import('../audit/export-audit')
		return doExport(this.adapter, this.schema, this.nodeId, this.schema.version, options)
	}

	/**
	 * Get the schema definition.
	 */
	getSchema(): SchemaDefinition {
		return this.schema
	}

	/**
	 * Route local CRUD through the unified apply pipeline (korajs ApplyPipeline).
	 */
	setLocalMutationHandler(handler: LocalMutationHandler | null): void {
		this.localMutationHandler = handler
		for (const col of this.collections.values()) {
			col.setMutationHandler(handler)
		}
	}

	/**
	 * Build mutation context for a collection (used by ApplyPipeline side effects).
	 */
	createMutationContext(
		collection: string,
		options?: { inTransaction?: boolean; extraCausalDeps?: string[] },
	): LocalMutationContext {
		this.ensureOpen()
		const definition = this.schema.collections[collection]
		if (!definition || !this.clock) {
			throw new StoreNotOpenError()
		}
		return {
			collection,
			definition,
			schema: this.schema,
			adapter: this.adapter,
			clock: this.clock,
			nodeId: this.nodeId,
			allocateSequenceNumber: () => this.allocateSequenceNumber(),
			onMutation: (collectionName, operation) => {
				this.recordOperationSequence(operation)
				this.subscriptionManager.notify(collectionName, operation)
				if (this.emitter) {
					this.emitter.emit({ type: 'operation:created', operation })
				}
			},
			relationEnforcer: this.relationEnforcer,
			causalTracker: this.causalTracker,
			inTransaction: options?.inTransaction ?? false,
			extraCausalDeps: options?.extraCausalDeps,
		}
	}

	/**
	 * Load a materialized row by ID, including soft-deleted tombstones.
	 */
	async findMaterializedRow(
		collection: string,
		recordId: string,
	): Promise<MaterializedRowSnapshot | null> {
		this.ensureOpen()
		const definition = this.schema.collections[collection]
		if (!definition) {
			return null
		}

		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${collection} WHERE id = ?`,
			[recordId],
		)
		const row = rows[0]
		if (!row) {
			return null
		}

		return {
			record: deserializeRecord(row, definition.fields),
			deleted: row._deleted === 1,
		}
	}

	/**
	 * Latest operation from this device for a record (used for delete-vs-update merge on sync).
	 */
	/**
	 * Load the last server version vector acknowledged by this client (persisted in `_kora_meta`).
	 */
	async loadLastAckedServerVector(): Promise<VersionVector> {
		this.ensureOpen()
		return loadLastAckedServerVector(this.adapter)
	}

	/**
	 * Persist the last server version vector this client believes the server has applied.
	 */
	async saveLastAckedServerVector(vector: VersionVector): Promise<void> {
		this.ensureOpen()
		await saveLastAckedServerVector(this.adapter, vector)
	}

	/**
	 * Load persisted delta cursor for resuming paginated initial sync.
	 */
	async loadDeltaCursor(): Promise<string | null> {
		this.ensureOpen()
		return loadDeltaCursor(this.adapter)
	}

	/**
	 * Persist or clear the delta cursor for paginated initial sync resume.
	 */
	async saveDeltaCursor(cursor: string | null): Promise<void> {
		this.ensureOpen()
		await saveDeltaCursor(this.adapter, cursor)
	}

	/**
	 * Local operations not yet reflected on the server version vector.
	 */
	async getUnsyncedOperations(serverVector: VersionVector): Promise<Operation[]> {
		this.ensureOpen()
		return collectOperationsAheadOfServer(
			this.getVersionVector(),
			serverVector,
			(nodeId, fromSeq, toSeq) => this.getOperationRange(nodeId, fromSeq, toSeq),
		)
	}

	/**
	 * Count of local operations ahead of the server version vector.
	 */
	async countUnsyncedOperations(serverVector: VersionVector): Promise<number> {
		const ops = await this.getUnsyncedOperations(serverVector)
		return ops.length
	}

	/**
	 * Compact the local operation log using materialized rows as the baseline.
	 * Only removes ops the server has acknowledged (per {@link CompactionStrategy}).
	 */
	async compact(strategy: CompactionStrategy): Promise<CompactionResult> {
		this.ensureOpen()
		if (strategy.mode === 'never') {
			return compactOperationLog(this.adapter, this.schema, strategy, createVersionVector())
		}

		const serverVector = strategy.serverVector ?? (await loadLastAckedServerVector(this.adapter))
		return compactOperationLog(this.adapter, this.schema, strategy, serverVector)
	}

	/**
	 * Merge session remote vector with persisted last-acked vector (max per node).
	 */
	mergeServerVectors(sessionVector: VersionVector, persistedVector: VersionVector): VersionVector {
		return mergeVersionVectors(persistedVector, sessionVector)
	}

	async getLatestLocalOperationForRecord(
		collection: string,
		recordId: string,
	): Promise<Operation | null> {
		this.ensureOpen()
		const rows = await this.adapter.query<OperationRow>(
			`SELECT * FROM _kora_ops_${collection} WHERE node_id = ? AND record_id = ? ORDER BY sequence_number DESC LIMIT 1`,
			[this.nodeId, recordId],
		)
		const row = rows[0]
		if (!row) {
			return null
		}
		return deserializeOperationWithCollection(row, collection)
	}

	/**
	 * Latest operation for a record from any node (for 3-way merge when local op log is empty).
	 */
	async getLatestOperationForRecord(
		collection: string,
		recordId: string,
	): Promise<Operation | null> {
		this.ensureOpen()
		const rows = await this.adapter.query<OperationRow>(
			`SELECT * FROM _kora_ops_${collection} WHERE record_id = ?`,
			[recordId],
		)

		let latest: Operation | null = null
		for (const row of rows) {
			const op = deserializeOperationWithCollection(row, collection)
			if (!latest || HybridLogicalClock.compare(op.timestamp, latest.timestamp) > 0) {
				latest = op
			}
		}
		return latest
	}

	/** Expose the subscription manager for direct access (e.g., by QueryBuilder) */
	getSubscriptionManager(): SubscriptionManager {
		return this.subscriptionManager
	}

	/**
	 * Get the sequence manager for offline-safe sequence generation.
	 * @throws {StoreNotOpenError} If the store is not open
	 */
	getSequenceManager(): SequenceManager {
		this.ensureOpen()
		if (!this.sequenceManager) {
			throw new StoreNotOpenError()
		}
		return this.sequenceManager
	}

	/**
	 * Create a TransactionContext for atomic multi-collection operations.
	 * The returned context buffers all mutations and commits them atomically.
	 *
	 * After commit, the caller is responsible for notifying subscriptions
	 * and emitting events for each operation.
	 */
	createTransaction(): TransactionContext {
		this.ensureOpen()
		if (!this.clock) {
			throw new StoreNotOpenError()
		}
		return new TransactionContext({
			schema: this.schema,
			adapter: this.adapter,
			clock: this.clock,
			nodeId: this.nodeId,
			sequenceAllocator: new TransactionSequenceAllocator(this.adapter, this.nodeId),
			relationEnforcer: this.relationEnforcer,
			causalTracker: this.causalTracker,
			localMutationHandler: this.localMutationHandler,
		})
	}

	/**
	 * Execute a function within a transaction. All mutations performed on the
	 * TransactionContext are committed atomically. Subscription notifications
	 * are batched and fired after the commit.
	 *
	 * If the function throws, the transaction is rolled back and the error is re-thrown.
	 *
	 * @param fn - Function receiving a TransactionContext for buffered operations
	 * @returns The operations that were committed
	 */
	async transaction(fn: (tx: TransactionContext) => Promise<void>): Promise<Operation[]> {
		const tx = this.createTransaction()
		this.causalTracker?.beginTransaction()
		try {
			await fn(tx)
			const { operations } = await tx.commit()

			this.causalTracker?.clearTransaction()

			// Notify subscriptions and emit events after commit
			for (const op of operations) {
				this.recordOperationSequence(op)
				this.subscriptionManager.notify(op.collection, op)
				if (this.emitter) {
					this.emitter.emit({ type: 'operation:created', operation: op })
				}
			}

			return operations
		} catch (error) {
			tx.rollback()
			this.causalTracker?.clearTransaction()
			throw error
		}
	}

	/**
	 * Export all data as a portable backup binary.
	 * Includes operations, version vector, metadata, and optionally materialized records.
	 *
	 * @param options - Backup options (includeRecords, collections, onProgress)
	 * @returns Backup as a Uint8Array
	 */
	async exportBackup(options?: BackupOptions): Promise<Uint8Array> {
		this.ensureOpen()
		const { exportBackup: doExport } = await import('../backup/backup')
		return doExport(this.adapter, this.schema, this.nodeId, this.schema.version, options)
	}

	/**
	 * Restore data from a backup binary.
	 *
	 * @param data - The backup data
	 * @param options - Restore options (merge, collections, onProgress)
	 * @returns Result of the restore operation
	 */
	async importBackup(data: Uint8Array, options?: RestoreOptions): Promise<RestoreResult> {
		this.ensureOpen()
		const { restoreBackup: doRestore } = await import('../backup/backup')
		return doRestore(this.adapter, this.schema, data, options)
	}

	/**
	 * Read backup manifest without loading the entire backup.
	 *
	 * @param data - The raw backup data
	 * @returns The backup manifest
	 */
	static readBackupManifest(data: Uint8Array): BackupManifest {
		return readManifest(data)
	}

	private recordOperationSequence(operation: Operation): void {
		const prev = this.versionVector.get(operation.nodeId) ?? 0
		if (operation.sequenceNumber > prev) {
			this.versionVector.set(operation.nodeId, operation.sequenceNumber)
		}
		if (operation.nodeId === this.nodeId) {
			this.sequenceNumber = Math.max(this.sequenceNumber, operation.sequenceNumber)
		}
	}

	private async allocateSequenceNumber(): Promise<number> {
		const seq = await allocateNextSequenceNumber(this.adapter, this.nodeId)
		this.sequenceNumber = seq
		this.versionVector.set(this.nodeId, seq)
		return seq
	}

	/**
	 * Check the stored schema version and run any pending migrations.
	 * Migrations are applied in version order within a transaction.
	 */
	private async runMigrationsIfNeeded(): Promise<void> {
		const storedVersion = await this.getStoredSchemaVersion()
		const targetVersion = this.schema.version

		if (storedVersion >= targetVersion) {
			// Already up to date (or first run with version 1)
			if (storedVersion === 0) {
				// First open — store the initial version
				await this.adapter.execute(
					"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('schema_version', ?)",
					[String(targetVersion)],
				)
			}
			return
		}

		// Run each migration in order from storedVersion+1 to targetVersion
		const migrations = this.schema.migrations ?? {}
		for (let v = storedVersion + 1; v <= targetVersion; v++) {
			const migration = migrations[v]
			if (!migration) continue

			// Generate SQL from structural steps
			const sqlStatements = migrationStepsToSQL(migration.steps)

			// Execute structural changes individually, tolerating "duplicate column" errors
			// because generateSQL already emits --kora:safe-alter ALTER TABLE statements
			// for the current schema's columns (run via generateFullDDL in adapter.open()).
			for (const sql of sqlStatements) {
				try {
					await this.adapter.execute(sql)
				} catch (e) {
					const msg = (e as Error).message || ''
					if (!msg.includes('duplicate column name')) {
						throw e
					}
					// Column already exists (added by safe-alter in generateSQL) — safe to skip
				}
			}

			// Run backfills in a transaction
			const backfillSteps = migration.steps.filter(
				(s): s is Extract<MigrationStep, { type: 'backfill' }> => s.type === 'backfill',
			)
			for (const step of backfillSteps) {
				await this.runBackfill(step.collection, step.transform)
			}
		}

		// Update stored schema version
		await this.adapter.execute(
			"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('schema_version', ?)",
			[String(targetVersion)],
		)
	}

	/**
	 * Get the stored schema version from _kora_meta. Returns 0 if not set.
	 */
	private async getStoredSchemaVersion(): Promise<number> {
		const rows = await this.adapter.query<MetaRow>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		return rows[0] ? Number(rows[0].value) : 0
	}

	/**
	 * Run a backfill transform on all records in a collection.
	 * Reads all rows, applies the transform, and updates changed fields.
	 */
	private async runBackfill(
		collection: string,
		transform: (record: Record<string, unknown>) => Record<string, unknown>,
	): Promise<void> {
		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${collection} WHERE _deleted = 0`,
		)

		await this.adapter.transaction(async (tx) => {
			for (const row of rows) {
				const updates = transform(row as Record<string, unknown>)
				const fields = Object.keys(updates)
				if (fields.length === 0) continue

				const setClauses = fields.map((f) => `${f} = ?`).join(', ')
				const values = fields.map((f) => {
					const val = updates[f]
					// Serialize booleans to 0/1 for SQLite
					if (typeof val === 'boolean') return val ? 1 : 0
					// Serialize arrays/objects to JSON
					if (Array.isArray(val) || (typeof val === 'object' && val !== null)) {
						return JSON.stringify(val)
					}
					return val
				})
				values.push(row.id)

				await tx.execute(`UPDATE ${collection} SET ${setClauses} WHERE id = ?`, values)
			}
		})
	}

	private async loadOrGenerateNodeId(): Promise<string> {
		if (this.configNodeId) {
			if (this.isolation !== 'per-tab') {
				await this.adapter.execute(
					"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('node_id', ?)",
					[this.configNodeId],
				)
			}
			return this.configNodeId
		}

		if (this.isolation === 'per-tab') {
			return resolvePerTabNodeId(this.dbName)
		}

		// Try to load existing node ID
		const rows = await this.adapter.query<MetaRow>(
			"SELECT value FROM _kora_meta WHERE key = 'node_id'",
		)
		if (rows[0]) {
			return rows[0].value
		}

		// Generate new node ID
		const newNodeId = generateUUIDv7()
		await this.adapter.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', ?)", [
			newNodeId,
		])
		return newNodeId
	}

	private async loadSequenceNumber(): Promise<number> {
		const rows = await this.adapter.query<VersionVectorRow>(
			'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
			[this.nodeId],
		)
		return rows[0]?.sequence_number ?? 0
	}

	private async loadVersionVector(): Promise<VersionVector> {
		const rows = await this.adapter.query<VersionVectorRow>(
			'SELECT node_id, sequence_number FROM _kora_version_vector',
		)
		const vector = createVersionVector()
		for (const row of rows) {
			vector.set(row.node_id, row.sequence_number)
		}
		return vector
	}

	private ensureOpen(): void {
		if (!this.opened) {
			throw new StoreNotOpenError()
		}
	}
}

/**
 * Public-facing collection accessor. Provides CRUD + where.
 */
export interface CollectionAccessor {
	insert(data: Record<string, unknown>): Promise<import('../types').CollectionRecord>
	findById(id: string): Promise<import('../types').CollectionRecord | null>
	update(id: string, data: Record<string, unknown>): Promise<import('../types').CollectionRecord>
	delete(id: string): Promise<void>
	where(conditions: Record<string, unknown>): QueryBuilder
}
