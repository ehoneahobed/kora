import {
	HybridLogicalClock,
	createVersionVector,
	generateUUIDv7,
	migrationStepsToSQL,
} from '@korajs/core'
import { readBackupManifest as readManifest } from '../backup/backup'
import type { BackupOptions, RestoreOptions, RestoreResult, BackupManifest } from '../backup/types'
import type {
	KoraEventEmitter,
	MigrationStep,
	Operation,
	OperationLog,
	SchemaDefinition,
	VersionVector,
} from '@korajs/core'
import { Collection } from '../collection/collection'
import { StoreNotOpenError } from '../errors'
import { QueryBuilder } from '../query/query-builder'
import { buildInsertQuery, buildSoftDeleteQuery, buildUpdateQuery } from '../query/sql-builder'
import { RelationEnforcer } from '../relations/relation-enforcer'
import { SequenceManager } from '../sequences/sequence-manager'
import {
	deserializeOperationWithCollection,
	serializeOperation,
	serializeRecord,
} from '../serialization/serializer'
import { SubscriptionManager } from '../subscription/subscription-manager'
import { TransactionContext } from '../transaction/transaction-context'
import type {
	ApplyResult,
	MetaRow,
	OperationRow,
	RawCollectionRow,
	StorageAdapter,
	StoreConfig,
	VersionVectorRow,
} from '../types'

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
	private subscriptionManager = new SubscriptionManager()
	private sequenceManager: SequenceManager | null = null

	private readonly schema: SchemaDefinition
	private readonly adapter: StorageAdapter
	private readonly configNodeId: string | undefined
	private readonly emitter: KoraEventEmitter | null

	constructor(config: StoreConfig) {
		this.schema = config.schema
		this.adapter = config.adapter
		this.configNodeId = config.nodeId
		this.emitter = config.emitter ?? null
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

		// Initialize sequence manager
		this.sequenceManager = new SequenceManager(this.adapter, this.nodeId)

		// Load sequence number and version vector
		this.sequenceNumber = await this.loadSequenceNumber()
		this.versionVector = await this.loadVersionVector()

		// Create RelationEnforcer if the schema has relations.
		// The enforcer is shared across all Collection instances so that
		// cascading deletes can cross collection boundaries.
		const hasRelations = Object.keys(this.schema.relations).length > 0
		const relationEnforcer = hasRelations
			? new RelationEnforcer({
					schema: this.schema,
					adapter: this.adapter,
					clock: this.clock,
					nodeId: this.nodeId,
					getSequenceNumber: () => this.nextSequenceNumber(),
				})
			: undefined

		// Create collection instances
		for (const [name, definition] of Object.entries(this.schema.collections)) {
			const col = new Collection(
				name,
				definition,
				this.schema,
				this.adapter,
				this.clock,
				this.nodeId,
				() => this.nextSequenceNumber(),
				(collectionName, operation) => {
					this.subscriptionManager.notify(collectionName, operation)
					if (this.emitter) {
						this.emitter.emit({ type: 'operation:created', operation })
					}
				},
				relationEnforcer,
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
	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
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

		// Update the clock with the remote timestamp
		if (this.clock) {
			this.clock.receive(op.timestamp)
		}

		// Apply the operation to the data table
		await this.adapter.transaction(async (tx) => {
			if (op.type === 'insert' && op.data) {
				const serializedData = serializeRecord(op.data, definition.fields)
				const now = op.timestamp.wallTime
				const record: Record<string, unknown> = {
					id: op.recordId,
					...serializedData,
					_created_at: now,
					_updated_at: now,
				}
				const insertQuery = buildInsertQuery(collection, record)
				await tx.execute(insertQuery.sql, insertQuery.params)
			} else if (op.type === 'update' && op.data) {
				const serializedChanges = serializeRecord(op.data, definition.fields)
				const updateQuery = buildUpdateQuery(collection, op.recordId, {
					...serializedChanges,
					_updated_at: op.timestamp.wallTime,
				})
				await tx.execute(updateQuery.sql, updateQuery.params)
			} else if (op.type === 'delete') {
				const deleteQuery = buildSoftDeleteQuery(collection, op.recordId, op.timestamp.wallTime)
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
	 * Get the schema definition.
	 */
	getSchema(): SchemaDefinition {
		return this.schema
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
			getSequenceNumber: () => this.nextSequenceNumber(),
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
		try {
			await fn(tx)
			const { operations, affectedCollections } = await tx.commit()

			// Notify subscriptions and emit events after commit
			for (const op of operations) {
				this.subscriptionManager.notify(op.collection, op)
				if (this.emitter) {
					this.emitter.emit({ type: 'operation:created', operation: op })
				}
			}

			return operations
		} catch (error) {
			tx.rollback()
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
	async importBackup(
		data: Uint8Array,
		options?: RestoreOptions,
	): Promise<RestoreResult> {
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

	private nextSequenceNumber(): number {
		this.sequenceNumber++
		this.versionVector.set(this.nodeId, this.sequenceNumber)
		return this.sequenceNumber
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
			// Persist the configured node ID
			await this.adapter.execute(
				"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('node_id', ?)",
				[this.configNodeId],
			)
			return this.configNodeId
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
