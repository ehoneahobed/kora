import type { Operation, SchemaDefinition, VersionVector } from '@korajs/core'
import { generateUUIDv7 } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import {
	deserializeFieldValue,
	replayOperationsForRecord,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import type { CollectionQueryOptions, MaterializedRecord, ServerStore } from './server-store'

/**
 * In-memory server store for testing and quick prototyping.
 * Not suitable for production — data does not survive process restart.
 *
 * When a schema is set via setSchema(), maintains materialized records
 * in-memory for efficient queries.
 */
export class MemoryServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly operations: Operation[] = []
	private readonly operationIndex = new Map<string, Operation>()
	private readonly versionVector: Map<string, number> = new Map()
	private schema: SchemaDefinition | null = null

	/** Materialized records: collection -> recordId -> record data */
	private readonly materializedRecords = new Map<string, Map<string, MaterializedRecord>>()

	private closed = false

	constructor(nodeId?: string) {
		this.nodeId = nodeId ?? generateUUIDv7()
	}

	getVersionVector(): VersionVector {
		return new Map(this.versionVector)
	}

	getNodeId(): string {
		return this.nodeId
	}

	getSchema(): SchemaDefinition | null {
		return this.schema
	}

	async setSchema(schema: SchemaDefinition): Promise<void> {
		this.assertOpen()
		this.schema = schema

		// Initialize collection maps
		for (const collectionName of Object.keys(schema.collections)) {
			if (!this.materializedRecords.has(collectionName)) {
				this.materializedRecords.set(collectionName, new Map())
			}
		}

		// Backfill from existing operations
		this.backfillAllCollections()
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		this.assertOpen()

		// Content-addressed dedup: same id = same content
		if (this.operationIndex.has(op.id)) {
			return 'duplicate'
		}

		this.operations.push(op)
		this.operationIndex.set(op.id, op)

		// Advance version vector
		const currentSeq = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentSeq) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		// Dual-write: update materialized records if schema is set
		if (this.schema?.collections[op.collection]) {
			this.rebuildMaterializedRecord(op.collection, op.recordId)
		}

		return 'applied'
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.assertOpen()

		return this.operations
			.filter(
				(op) => op.nodeId === nodeId && op.sequenceNumber >= fromSeq && op.sequenceNumber <= toSeq,
			)
			.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
	}

	async getOperationCount(): Promise<number> {
		this.assertOpen()
		return this.operations.length
	}

	async materializeCollection(collection: string): Promise<MaterializedRecord[]> {
		this.assertOpen()

		// Fast path: if schema is set, read from materialized records
		if (this.schema?.collections[collection]) {
			return this.queryCollection(collection)
		}

		// Fallback: replay operations
		return this.materializeFromOps(collection)
	}

	async queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]> {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)

		// Validate field names
		const schema = this.schema as SchemaDefinition
		if (options?.where) {
			for (const key of Object.keys(options.where)) {
				validateFieldName(collection, key, schema)
			}
		}
		if (options?.orderBy) {
			validateFieldName(collection, options.orderBy, schema)
		}

		const collectionMap = this.materializedRecords.get(collection)
		if (!collectionMap) return []

		// Get all non-deleted records
		let records = Array.from(collectionMap.values()).filter((r) => {
			if (!options?.includeDeleted && r._deleted === 1) return false
			return true
		})

		// Apply WHERE filters
		if (options?.where) {
			for (const [key, value] of Object.entries(options.where)) {
				records = records.filter((r) => r[key] === value)
			}
		}

		// Apply ORDER BY
		if (options?.orderBy) {
			const field = options.orderBy
			const dir = options.orderDirection === 'desc' ? -1 : 1
			records.sort((a, b) => {
				const aVal = a[field]
				const bVal = b[field]
				if (aVal === bVal) return 0
				if (aVal === null || aVal === undefined) return 1
				if (bVal === null || bVal === undefined) return -1
				return aVal < bVal ? -1 * dir : 1 * dir
			})
		}

		// Apply OFFSET
		if (options?.offset !== undefined) {
			records = records.slice(options.offset)
		}

		// Apply LIMIT
		if (options?.limit !== undefined) {
			records = records.slice(0, options.limit)
		}

		// Return clean copies without internal fields
		return records.map((r) => {
			const clean: MaterializedRecord = { id: r.id }
			const collectionDef = (this.schema as SchemaDefinition).collections[
				collection
			] as NonNullable<SchemaDefinition['collections'][string]>
			for (const fieldName of Object.keys(collectionDef.fields)) {
				if (fieldName in r) {
					clean[fieldName] = r[fieldName]
				}
			}
			if ('_created_at' in r) clean._created_at = r._created_at
			if ('_updated_at' in r) clean._updated_at = r._updated_at
			return clean
		})
	}

	async findRecord(collection: string, id: string): Promise<MaterializedRecord | null> {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)

		const collectionMap = this.materializedRecords.get(collection)
		if (!collectionMap) return null

		const record = collectionMap.get(id)
		if (!record || record._deleted === 1) return null

		// Return clean copy
		const clean: MaterializedRecord = { id: record.id }
		const collectionDef = (this.schema as SchemaDefinition).collections[collection] as NonNullable<
			SchemaDefinition['collections'][string]
		>
		for (const fieldName of Object.keys(collectionDef.fields)) {
			if (fieldName in record) {
				clean[fieldName] = record[fieldName]
			}
		}
		if ('_created_at' in record) clean._created_at = record._created_at
		if ('_updated_at' in record) clean._updated_at = record._updated_at
		return clean
	}

	async countCollection(collection: string, where?: Record<string, unknown>): Promise<number> {
		this.assertOpen()
		this.assertSchema()
		this.assertCollection(collection)

		const schema = this.schema as SchemaDefinition
		if (where) {
			for (const key of Object.keys(where)) {
				validateFieldName(collection, key, schema)
			}
		}

		const collectionMap = this.materializedRecords.get(collection)
		if (!collectionMap) return 0

		let count = 0
		for (const record of collectionMap.values()) {
			if (record._deleted === 1) continue
			if (where) {
				let matches = true
				for (const [key, value] of Object.entries(where)) {
					if (record[key] !== value) {
						matches = false
						break
					}
				}
				if (!matches) continue
			}
			count++
		}
		return count
	}

	async close(): Promise<void> {
		this.closed = true
	}

	/**
	 * Wipes all in-memory state. For tests and E2E isolation only.
	 */
	resetForTests(): void {
		this.assertOpen()
		this.operations.length = 0
		this.operationIndex.clear()
		this.versionVector.clear()
		this.materializedRecords.clear()
		this.schema = null
	}

	async exportBackup(): Promise<Uint8Array> {
		this.assertOpen()
		const { buildServerBackup } = await import('./server-backup')
		return buildServerBackup(this.nodeId, this.operations, this.versionVector)
	}

	async importBackup(
		data: Uint8Array,
		merge?: boolean,
	): Promise<{ operationsRestored: number; success: boolean }> {
		this.assertOpen()
		const { parseServerBackup } = await import('./server-backup')
		const { operations, versionVector } = parseServerBackup(data)

		if (merge) {
			let restored = 0
			for (const op of operations) {
				const result = await this.applyRemoteOperation(op)
				if (result === 'applied') restored++
			}
			return { operationsRestored: restored, success: true }
		}

		// Replace mode: clear and reload
		this.operations.length = 0
		this.operationIndex.clear()
		this.versionVector.clear()

		for (const [nid, seq] of versionVector) {
			this.versionVector.set(nid, seq)
		}

		for (const op of operations) {
			this.operations.push(op)
			this.operationIndex.set(op.id, op)

			// Update materialized records if schema is set
			if (this.schema?.collections[op.collection]) {
				this.rebuildMaterializedRecord(op.collection, op.recordId)
			}
		}

		return { operationsRestored: operations.length, success: true }
	}

	// --- Testing helpers (not on interface) ---

	/**
	 * Get all stored operations (for test assertions).
	 */
	getAllOperations(): Operation[] {
		return [...this.operations]
	}

	// ---------------------------------------------------------------------------
	// Materialization internals
	// ---------------------------------------------------------------------------

	private rebuildMaterializedRecord(collection: string, recordId: string): void {
		const collectionDef = this.schema?.collections[collection]
		if (!collectionDef) return

		// Get or create collection map
		let collectionMap = this.materializedRecords.get(collection)
		if (!collectionMap) {
			collectionMap = new Map()
			this.materializedRecords.set(collection, collectionMap)
		}

		// Get all ops for this record in HLC order
		const recordOps = this.operations
			.filter((op) => op.collection === collection && op.recordId === recordId)
			.sort((a, b) => {
				if (a.timestamp.wallTime !== b.timestamp.wallTime)
					return a.timestamp.wallTime - b.timestamp.wallTime
				if (a.timestamp.logical !== b.timestamp.logical)
					return a.timestamp.logical - b.timestamp.logical
				return a.sequenceNumber - b.sequenceNumber
			})

		const parsedOps = recordOps.map((op) => ({
			type: op.type,
			data: op.data,
		}))
		const recordData = replayOperationsForRecord(parsedOps)

		if (recordData) {
			const createdAt =
				recordOps.length > 0 ? (recordOps[0] as Operation).timestamp.wallTime : Date.now()
			const updatedAt =
				recordOps.length > 0
					? (recordOps[recordOps.length - 1] as Operation).timestamp.wallTime
					: Date.now()

			const materialized: MaterializedRecord = {
				id: recordId,
				...recordData,
				_created_at: createdAt,
				_updated_at: updatedAt,
				_deleted: 0,
			}
			collectionMap.set(recordId, materialized)
		} else {
			// Record was deleted
			const existing = collectionMap.get(recordId)
			if (existing) {
				existing._deleted = 1
				existing._updated_at = Date.now()
			} else {
				collectionMap.set(recordId, {
					id: recordId,
					_deleted: 1,
					_created_at: Date.now(),
					_updated_at: Date.now(),
				})
			}
		}
	}

	private backfillAllCollections(): void {
		if (!this.schema) return

		// Get all unique (collection, recordId) pairs
		const recordKeys = new Set<string>()
		for (const op of this.operations) {
			if (this.schema.collections[op.collection]) {
				recordKeys.add(`${op.collection}:::${op.recordId}`)
			}
		}

		for (const key of recordKeys) {
			const [collection, recordId] = key.split(':::') as [string, string]
			this.rebuildMaterializedRecord(collection, recordId)
		}
	}

	// ---------------------------------------------------------------------------
	// Fallback materialization (no schema)
	// ---------------------------------------------------------------------------

	private materializeFromOps(collection: string): MaterializedRecord[] {
		const collectionOps = this.operations
			.filter((op) => op.collection === collection)
			.sort((a, b) => {
				if (a.timestamp.wallTime !== b.timestamp.wallTime)
					return a.timestamp.wallTime - b.timestamp.wallTime
				if (a.timestamp.logical !== b.timestamp.logical)
					return a.timestamp.logical - b.timestamp.logical
				return a.sequenceNumber - b.sequenceNumber
			})

		const records = new Map<string, Record<string, unknown>>()
		const deleted = new Set<string>()

		for (const op of collectionOps) {
			switch (op.type) {
				case 'insert':
					if (op.data) {
						records.set(op.recordId, { id: op.recordId, ...op.data })
						deleted.delete(op.recordId)
					}
					break
				case 'update':
					if (op.data) {
						const existing = records.get(op.recordId) ?? { id: op.recordId }
						records.set(op.recordId, { ...existing, ...op.data })
						deleted.delete(op.recordId)
					}
					break
				case 'delete':
					deleted.add(op.recordId)
					break
			}
		}

		for (const id of deleted) {
			records.delete(id)
		}

		return Array.from(records.values()) as MaterializedRecord[]
	}

	// ---------------------------------------------------------------------------
	// Assertions
	// ---------------------------------------------------------------------------

	private assertOpen(): void {
		if (this.closed) {
			throw new Error('MemoryServerStore is closed')
		}
	}

	private assertSchema(): void {
		if (!this.schema) {
			throw new Error(
				'Schema not set. Call setSchema() before using queryCollection/findRecord/countCollection.',
			)
		}
	}

	private assertCollection(collection: string): void {
		const schema = this.schema as SchemaDefinition
		if (!schema.collections[collection]) {
			throw new Error(
				`Unknown collection "${collection}". Available: ${Object.keys(schema.collections).join(', ')}`,
			)
		}
	}
}
