import type {
	AtomicOp,
	CausalTracker,
	CollectionDefinition,
	HybridLogicalClock,
	Operation,
	SchemaDefinition,
} from '@korajs/core'
import {
	createOperation,
	generateUUIDv7,
	isAtomicOp,
	resolveAtomicOp,
	toAtomicOp,
	validateRecord,
} from '@korajs/core'
import { RecordNotFoundError } from '../errors'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery, buildSoftDeleteQuery, buildUpdateQuery } from '../query/sql-builder'
import type { RelationEnforcer } from '../relations/relation-enforcer'
import { deserializeRecord, serializeOperation, serializeRecord } from '../serialization/serializer'
import type {
	CollectionRecord,
	LocalMutationHandler,
	RawCollectionRow,
	StorageAdapter,
	Transaction,
} from '../types'

/**
 * A buffered SQL command to be executed during commit.
 */
interface BufferedCommand {
	sql: string
	params: unknown[]
}

/**
 * A buffered operation with its associated SQL commands.
 */
interface BufferedEntry {
	operation: Operation
	commands: BufferedCommand[]
	collection: string
}

/**
 * Internal configuration for creating a TransactionContext.
 * Passed from Store to avoid exposing Store internals publicly.
 */
export interface TransactionContextConfig {
	schema: SchemaDefinition
	adapter: StorageAdapter
	clock: HybridLogicalClock
	nodeId: string
	sequenceAllocator: import('./transaction-sequence').TransactionSequenceAllocator
	relationEnforcer: RelationEnforcer | null
	causalTracker: CausalTracker | null
	localMutationHandler: LocalMutationHandler | null
}

/**
 * A collection accessor within a transaction.
 * Operations are buffered and committed atomically when the transaction completes.
 */
export interface TransactionCollectionAccessor {
	insert(data: Record<string, unknown>): Promise<CollectionRecord>
	update(id: string, data: Record<string, unknown>): Promise<CollectionRecord>
	delete(id: string): Promise<void>
	findById(id: string): Promise<CollectionRecord | null>
}

/**
 * TransactionContext provides atomic multi-collection operations.
 *
 * All mutations are buffered and committed in a single StorageAdapter.transaction()
 * call. All operations share the same transactionId (UUID v7).
 *
 * Subscription notifications are deferred until after commit.
 *
 * @example
 * ```typescript
 * const { operations, affectedCollections } = await txContext.commit()
 * // Notify subscriptions after commit
 * for (const op of operations) {
 *   subscriptionManager.notify(op.collection, op)
 * }
 * ```
 */
export class TransactionContext {
	private readonly transactionId: string
	private mutationName: string | undefined
	private readonly buffer: BufferedEntry[] = []
	private committed = false
	private rolledBack = false
	private readonly config: TransactionContextConfig

	constructor(config: TransactionContextConfig) {
		this.config = config
		this.transactionId = generateUUIDv7()
	}

	/**
	 * Set a human-readable mutation name for this transaction.
	 * Propagated to all operations for DevTools display.
	 */
	setMutationName(name: string): void {
		this.mutationName = name
	}

	/**
	 * Get the mutation name, if set.
	 */
	getMutationName(): string | undefined {
		return this.mutationName
	}

	/**
	 * Get a collection accessor for buffered operations within this transaction.
	 */
	collection(name: string): TransactionCollectionAccessor {
		const definition = this.config.schema.collections[name]
		if (!definition) {
			throw new Error(
				`Unknown collection "${name}". Available: ${Object.keys(this.config.schema.collections).join(', ')}`,
			)
		}

		return {
			insert: (data: Record<string, unknown>) => this.insert(name, definition, data),
			update: (id: string, data: Record<string, unknown>) =>
				this.update(name, definition, id, data),
			delete: (id: string) => this.deleteRecord(name, definition, id),
			findById: (id: string) => this.findById(name, definition, id),
		}
	}

	/**
	 * Commit all buffered operations atomically.
	 * Returns the list of operations and affected collections for subscription notification.
	 */
	async commit(): Promise<{ operations: Operation[]; affectedCollections: Set<string> }> {
		if (this.committed) {
			throw new Error('Transaction already committed.')
		}
		if (this.rolledBack) {
			throw new Error('Transaction was rolled back and cannot be committed.')
		}

		this.committed = true

		if (this.buffer.length === 0) {
			return { operations: [], affectedCollections: new Set() }
		}

		const handler = this.config.localMutationHandler
		if (handler?.commitTransaction) {
			return handler.commitTransaction({
				entries: this.buffer.map((entry) => ({
					operation: entry.operation,
					commands: entry.commands,
					collection: entry.collection,
				})),
				transactionId: this.transactionId,
				...(this.mutationName !== undefined ? { mutationName: this.mutationName } : {}),
			})
		}

		const operations: Operation[] = []
		const affectedCollections = new Set<string>()

		// Execute all buffered commands in a single adapter transaction
		await this.config.adapter.transaction(async (tx: Transaction) => {
			for (const entry of this.buffer) {
				if (entry.operation.type === 'delete' && this.config.relationEnforcer) {
					const cascadeResult = await this.config.relationEnforcer.enforceDelete(
						entry.collection,
						entry.operation.recordId,
						tx,
						[entry.operation.id],
					)
					for (const cascadedOp of cascadeResult.operations) {
						operations.push(cascadedOp)
						affectedCollections.add(cascadedOp.collection)
						this.config.causalTracker?.afterOperation(cascadedOp.collection, cascadedOp.id, true)
					}
				}

				for (const cmd of entry.commands) {
					await tx.execute(cmd.sql, cmd.params)
				}
				operations.push(entry.operation)
				affectedCollections.add(entry.collection)
			}

			const finalSeq = this.config.sequenceAllocator.getHighWaterMark()
			if (finalSeq > 0) {
				await tx.execute(
					'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
					[this.config.nodeId, finalSeq],
				)
			}
		})

		return { operations, affectedCollections }
	}

	/**
	 * Mark the transaction as rolled back. No operations will be committed.
	 */
	rollback(): void {
		this.rolledBack = true
		this.buffer.length = 0
	}

	/**
	 * Get the transaction ID shared by all operations in this transaction.
	 */
	getTransactionId(): string {
		return this.transactionId
	}

	private ensureActive(): void {
		if (this.committed) {
			throw new Error('Cannot perform operations on a committed transaction.')
		}
		if (this.rolledBack) {
			throw new Error('Cannot perform operations on a rolled-back transaction.')
		}
	}

	private async insert(
		collectionName: string,
		definition: CollectionDefinition,
		data: Record<string, unknown>,
	): Promise<CollectionRecord> {
		this.ensureActive()

		const validated = validateRecord(collectionName, definition, data, 'insert')
		const recordId = generateUUIDv7()
		const now = Date.now()

		// Set auto timestamp fields
		for (const [fieldName, descriptor] of Object.entries(definition.fields)) {
			if (descriptor.auto && descriptor.kind === 'timestamp') {
				validated[fieldName] = now
			}
		}

		const sequenceNumber = await this.config.sequenceAllocator.allocate()
		const causalDeps = this.config.causalTracker?.nextCausalDeps(collectionName, true) ?? []
		const operation = await createOperation(
			{
				nodeId: this.config.nodeId,
				type: 'insert',
				collection: collectionName,
				recordId,
				data: { ...validated },
				previousData: null,
				sequenceNumber,
				causalDeps,
				schemaVersion: this.config.schema.version,
				transactionId: this.transactionId,
				...(this.mutationName !== undefined ? { mutationName: this.mutationName } : {}),
			},
			this.config.clock,
		)
		this.config.causalTracker?.afterOperation(collectionName, operation.id, true)

		const serializedData = serializeRecord(validated, definition.fields)
		const version = serializeRowVersion(operation.timestamp)
		const record: Record<string, unknown> = {
			id: recordId,
			...serializedData,
			_created_at: operation.timestamp.wallTime,
			_updated_at: operation.timestamp.wallTime,
			_version: version,
		}

		const insertQuery = buildInsertQuery(collectionName, record)
		const opRow = serializeOperation(operation)
		const opInsert = buildInsertQuery(
			`_kora_ops_${collectionName}`,
			opRow as unknown as Record<string, unknown>,
		)

		this.buffer.push({
			operation,
			collection: collectionName,
			commands: [
				{ sql: insertQuery.sql, params: insertQuery.params },
				{ sql: opInsert.sql, params: opInsert.params },
			],
		})

		return {
			id: recordId,
			...validated,
			createdAt: now,
			updatedAt: now,
		}
	}

	private async update(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
		data: Record<string, unknown>,
	): Promise<CollectionRecord> {
		this.ensureActive()

		// Check for buffered inserts/updates for this record to get current state
		const currentRecord = await this.getEffectiveRecord(collectionName, definition, id)
		if (!currentRecord) {
			throw new RecordNotFoundError(collectionName, id)
		}

		const validated = validateRecord(collectionName, definition, data, 'update')
		const now = Date.now()

		const previousData: Record<string, unknown> = {}
		const resolvedData: Record<string, unknown> = {}
		const atomicOps: Record<string, AtomicOp> = {}

		for (const key of Object.keys(validated)) {
			const value = validated[key]
			previousData[key] = currentRecord[key]

			if (isAtomicOp(value)) {
				resolvedData[key] = resolveAtomicOp(currentRecord[key], value)
				atomicOps[key] = toAtomicOp(value)
			} else {
				resolvedData[key] = value
			}
		}

		const hasAtomicOps = Object.keys(atomicOps).length > 0

		const sequenceNumber = await this.config.sequenceAllocator.allocate()
		const causalDeps = this.config.causalTracker?.nextCausalDeps(collectionName, true) ?? []
		const operation = await createOperation(
			{
				nodeId: this.config.nodeId,
				type: 'update',
				collection: collectionName,
				recordId: id,
				data: { ...resolvedData },
				previousData,
				sequenceNumber,
				causalDeps,
				schemaVersion: this.config.schema.version,
				transactionId: this.transactionId,
				...(this.mutationName !== undefined ? { mutationName: this.mutationName } : {}),
				...(hasAtomicOps ? { atomicOps } : {}),
			},
			this.config.clock,
		)
		this.config.causalTracker?.afterOperation(collectionName, operation.id, true)

		const serializedChanges = serializeRecord(resolvedData, definition.fields)
		const version = serializeRowVersion(operation.timestamp)
		const updateQuery = buildUpdateQuery(collectionName, id, {
			...serializedChanges,
			_updated_at: operation.timestamp.wallTime,
			_version: version,
		})
		const opRow = serializeOperation(operation)
		const opInsert = buildInsertQuery(
			`_kora_ops_${collectionName}`,
			opRow as unknown as Record<string, unknown>,
		)

		this.buffer.push({
			operation,
			collection: collectionName,
			commands: [
				{ sql: updateQuery.sql, params: updateQuery.params },
				{ sql: opInsert.sql, params: opInsert.params },
			],
		})

		// Merge current record with resolved changes for return value
		return {
			...currentRecord,
			...resolvedData,
			updatedAt: now,
		} as CollectionRecord
	}

	private async deleteRecord(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
	): Promise<void> {
		this.ensureActive()

		const currentRecord = await this.getEffectiveRecord(collectionName, definition, id)
		if (!currentRecord) {
			throw new RecordNotFoundError(collectionName, id)
		}

		const now = Date.now()
		const sequenceNumber = await this.config.sequenceAllocator.allocate()
		const causalDeps = this.config.causalTracker?.nextCausalDeps(collectionName, true) ?? []
		const operation = await createOperation(
			{
				nodeId: this.config.nodeId,
				type: 'delete',
				collection: collectionName,
				recordId: id,
				data: null,
				previousData: null,
				sequenceNumber,
				causalDeps,
				schemaVersion: this.config.schema.version,
				transactionId: this.transactionId,
				...(this.mutationName !== undefined ? { mutationName: this.mutationName } : {}),
			},
			this.config.clock,
		)
		this.config.causalTracker?.afterOperation(collectionName, operation.id, true)

		const deleteQuery = buildSoftDeleteQuery(collectionName, id, now)
		const opRow = serializeOperation(operation)
		const opInsert = buildInsertQuery(
			`_kora_ops_${collectionName}`,
			opRow as unknown as Record<string, unknown>,
		)

		this.buffer.push({
			operation,
			collection: collectionName,
			commands: [
				{ sql: deleteQuery.sql, params: deleteQuery.params },
				{ sql: opInsert.sql, params: opInsert.params },
			],
		})
	}

	private async findById(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
	): Promise<CollectionRecord | null> {
		return this.getEffectiveRecord(collectionName, definition, id)
	}

	/**
	 * Get the effective state of a record, considering both the database and buffered operations.
	 * Buffered inserts/updates take precedence over the database state.
	 */
	private async getEffectiveRecord(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
	): Promise<CollectionRecord | null> {
		// Check if there's a buffered delete for this record (scan from newest to oldest)
		for (let i = this.buffer.length - 1; i >= 0; i--) {
			const entry = this.buffer[i] as BufferedEntry
			if (entry.collection === collectionName && entry.operation.recordId === id) {
				if (entry.operation.type === 'delete') {
					return null
				}
				// For buffered inserts/updates, reconstruct the record from the database + buffered changes
				break
			}
		}

		// Read from database first
		const rows = await this.config.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${collectionName} WHERE id = ? AND _deleted = 0`,
			[id],
		)

		let record: CollectionRecord | null = rows[0]
			? deserializeRecord(rows[0], definition.fields)
			: null

		// Apply buffered operations on top
		for (const entry of this.buffer) {
			if (entry.collection !== collectionName || entry.operation.recordId !== id) {
				continue
			}

			if (entry.operation.type === 'insert' && entry.operation.data) {
				record = {
					id,
					...entry.operation.data,
					createdAt: entry.operation.timestamp.wallTime,
					updatedAt: entry.operation.timestamp.wallTime,
				}
			} else if (entry.operation.type === 'update' && entry.operation.data && record) {
				record = {
					...record,
					...entry.operation.data,
					updatedAt: entry.operation.timestamp.wallTime,
				}
			} else if (entry.operation.type === 'delete') {
				record = null
			}
		}

		return record
	}
}
