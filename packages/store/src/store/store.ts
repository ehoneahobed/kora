import { HybridLogicalClock, createVersionVector, generateUUIDv7 } from '@kora/core'
import type { Operation, OperationLog, SchemaDefinition, VersionVector } from '@kora/core'
import { Collection } from '../collection/collection'
import { StoreNotOpenError } from '../errors'
import { QueryBuilder } from '../query/query-builder'
import { buildInsertQuery, buildSoftDeleteQuery, buildUpdateQuery } from '../query/sql-builder'
import {
	deserializeOperationWithCollection,
	serializeOperation,
	serializeRecord,
} from '../serialization/serializer'
import { SubscriptionManager } from '../subscription/subscription-manager'
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

	private readonly schema: SchemaDefinition
	private readonly adapter: StorageAdapter
	private readonly configNodeId: string | undefined

	constructor(config: StoreConfig) {
		this.schema = config.schema
		this.adapter = config.adapter
		this.configNodeId = config.nodeId
	}

	/**
	 * Open the store: initialize the database, load or generate a node ID,
	 * restore the sequence number and version vector, and create Collection instances.
	 */
	async open(): Promise<void> {
		await this.adapter.open(this.schema)

		// Load or generate node ID
		this.nodeId = await this.loadOrGenerateNodeId()
		this.clock = new HybridLogicalClock(this.nodeId)

		// Load sequence number and version vector
		this.sequenceNumber = await this.loadSequenceNumber()
		this.versionVector = await this.loadVersionVector()

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
				},
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
				new QueryBuilder(name, definition, this.adapter, this.subscriptionManager, conditions),
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
	getRange(nodeId: string, fromSeq: number, toSeq: number): Operation[] {
		// This is synchronous per the OperationLog interface.
		// We can't use async here, so this must be called with data already loaded.
		// For now, this is a placeholder that the sync layer will call after awaiting.
		return []
	}

	/**
	 * Async version of getRange for use by the sync layer.
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

	private nextSequenceNumber(): number {
		this.sequenceNumber++
		this.versionVector.set(this.nodeId, this.sequenceNumber)
		return this.sequenceNumber
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
