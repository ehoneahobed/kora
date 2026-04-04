import type {
	CollectionDefinition,
	HLCTimestamp,
	HybridLogicalClock,
	Operation,
	SchemaDefinition,
} from '@kora/core'
import { createOperation, generateUUIDv7, validateRecord } from '@kora/core'
import { RecordNotFoundError } from '../errors'
import { buildInsertQuery, buildSoftDeleteQuery, buildUpdateQuery } from '../query/sql-builder'
import { deserializeRecord, serializeOperation, serializeRecord } from '../serialization/serializer'
import type { CollectionRecord, RawCollectionRow, StorageAdapter } from '../types'

/**
 * Callback invoked after a mutation so the Store can notify subscriptions.
 */
export type MutationCallback = (collection: string, operation: Operation) => void

/**
 * Collection provides CRUD operations on a single schema collection.
 * Each mutation creates an Operation and persists both the data and the operation atomically.
 */
export class Collection {
	constructor(
		private readonly name: string,
		private readonly definition: CollectionDefinition,
		private readonly schema: SchemaDefinition,
		private readonly adapter: StorageAdapter,
		private readonly clock: HybridLogicalClock,
		private readonly nodeId: string,
		private readonly getSequenceNumber: () => number,
		private readonly onMutation: MutationCallback,
	) {}

	/**
	 * Insert a new record into the collection.
	 * Generates a UUID v7 for the id, validates data, and persists atomically.
	 *
	 * @param data - The record data (auto fields and defaults are applied automatically)
	 * @returns The inserted record with id, createdAt, updatedAt
	 */
	async insert(data: Record<string, unknown>): Promise<CollectionRecord> {
		const validated = validateRecord(this.name, this.definition, data, 'insert')
		const recordId = generateUUIDv7()
		const now = Date.now()

		// Set auto timestamp fields
		for (const [fieldName, descriptor] of Object.entries(this.definition.fields)) {
			if (descriptor.auto && descriptor.kind === 'timestamp') {
				validated[fieldName] = now
			}
		}

		const sequenceNumber = this.getSequenceNumber()
		const operation = await createOperation(
			{
				nodeId: this.nodeId,
				type: 'insert',
				collection: this.name,
				recordId,
				data: { ...validated },
				previousData: null,
				sequenceNumber,
				causalDeps: [],
				schemaVersion: this.schema.version,
			},
			this.clock,
		)

		const serializedData = serializeRecord(validated, this.definition.fields)
		const record: Record<string, unknown> = {
			id: recordId,
			...serializedData,
			_created_at: now,
			_updated_at: now,
		}

		const insertQuery = buildInsertQuery(this.name, record)
		const opRow = serializeOperation(operation)
		const opInsert = buildInsertQuery(
			`_kora_ops_${this.name}`,
			opRow as unknown as Record<string, unknown>,
		)

		await this.adapter.transaction(async (tx) => {
			await tx.execute(insertQuery.sql, insertQuery.params)
			await tx.execute(opInsert.sql, opInsert.params)
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
				[this.nodeId, sequenceNumber],
			)
		})

		this.onMutation(this.name, operation)

		return {
			id: recordId,
			...validated,
			createdAt: now,
			updatedAt: now,
		}
	}

	/**
	 * Find a record by its ID. Returns null if not found or soft-deleted.
	 */
	async findById(id: string): Promise<CollectionRecord | null> {
		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${this.name} WHERE id = ? AND _deleted = 0`,
			[id],
		)

		const row = rows[0]
		if (!row) return null
		return deserializeRecord(row, this.definition.fields)
	}

	/**
	 * Update an existing record. Only the provided fields are changed.
	 *
	 * @param id - The record ID to update
	 * @param data - Partial data with only the fields to change
	 * @returns The updated record
	 * @throws {RecordNotFoundError} If the record doesn't exist or is deleted
	 */
	async update(id: string, data: Record<string, unknown>): Promise<CollectionRecord> {
		const currentRows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${this.name} WHERE id = ? AND _deleted = 0`,
			[id],
		)
		const currentRow = currentRows[0]
		if (!currentRow) {
			throw new RecordNotFoundError(this.name, id)
		}

		const validated = validateRecord(this.name, this.definition, data, 'update')
		const now = Date.now()

		// Build previousData from current row for the changed fields
		const previousData: Record<string, unknown> = {}
		const currentRecord = deserializeRecord(currentRow, this.definition.fields)
		for (const key of Object.keys(validated)) {
			previousData[key] = currentRecord[key]
		}

		const sequenceNumber = this.getSequenceNumber()
		const operation = await createOperation(
			{
				nodeId: this.nodeId,
				type: 'update',
				collection: this.name,
				recordId: id,
				data: { ...validated },
				previousData,
				sequenceNumber,
				causalDeps: [],
				schemaVersion: this.schema.version,
			},
			this.clock,
		)

		const serializedChanges = serializeRecord(validated, this.definition.fields)
		const updateQuery = buildUpdateQuery(this.name, id, {
			...serializedChanges,
			_updated_at: now,
		})
		const opRow = serializeOperation(operation)
		const opInsert = buildInsertQuery(
			`_kora_ops_${this.name}`,
			opRow as unknown as Record<string, unknown>,
		)

		await this.adapter.transaction(async (tx) => {
			await tx.execute(updateQuery.sql, updateQuery.params)
			await tx.execute(opInsert.sql, opInsert.params)
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
				[this.nodeId, sequenceNumber],
			)
		})

		this.onMutation(this.name, operation)

		// Return the full updated record
		const updatedRow = await this.findById(id)
		if (!updatedRow) {
			throw new RecordNotFoundError(this.name, id)
		}
		return updatedRow
	}

	/**
	 * Soft-delete a record by its ID.
	 *
	 * @param id - The record ID to delete
	 * @throws {RecordNotFoundError} If the record doesn't exist or is already deleted
	 */
	async delete(id: string): Promise<void> {
		const currentRows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${this.name} WHERE id = ? AND _deleted = 0`,
			[id],
		)
		if (!currentRows[0]) {
			throw new RecordNotFoundError(this.name, id)
		}

		const now = Date.now()
		const sequenceNumber = this.getSequenceNumber()
		const operation = await createOperation(
			{
				nodeId: this.nodeId,
				type: 'delete',
				collection: this.name,
				recordId: id,
				data: null,
				previousData: null,
				sequenceNumber,
				causalDeps: [],
				schemaVersion: this.schema.version,
			},
			this.clock,
		)

		const deleteQuery = buildSoftDeleteQuery(this.name, id, now)
		const opRow = serializeOperation(operation)
		const opInsert = buildInsertQuery(
			`_kora_ops_${this.name}`,
			opRow as unknown as Record<string, unknown>,
		)

		await this.adapter.transaction(async (tx) => {
			await tx.execute(deleteQuery.sql, deleteQuery.params)
			await tx.execute(opInsert.sql, opInsert.params)
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
				[this.nodeId, sequenceNumber],
			)
		})

		this.onMutation(this.name, operation)
	}

	/** Get the collection name */
	getName(): string {
		return this.name
	}

	/** Get the collection definition */
	getDefinition(): CollectionDefinition {
		return this.definition
	}
}
