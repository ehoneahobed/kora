import type { HLCTimestamp, Operation, SchemaDefinition, VersionVector } from '@korajs/core'
import { HybridLogicalClock, generateUUIDv7 } from '@korajs/core'
import type { ApplyResult } from '@korajs/sync'
import { UplinkAuthorizationError } from '../scopes/server-scope-filter'
import {
	deserializeFieldValue,
	replayOperationsForRecord,
	serializeFieldValue,
	validateFieldName,
} from './materialization'
import { replayScopeSnapshots, scopeSnapshotFingerprint, scopeValuesOf } from './scope-snapshot'
import type {
	ApplyRemoteOptions,
	CollectionQueryOptions,
	DeliveredOperation,
	MaterializedRecord,
	OperationScopeSnapshot,
	ServerStore,
} from './server-store'
import { RELEASED_NODE_OWNER } from './server-store'

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
	/**
	 * Server-assigned delivery sequence per operation id. Single-process, so a plain
	 * counter incremented at insert time gives commit-order delivery sequence with no
	 * gaps. `operations` is kept in insertion (== delivery) order, so a delivery scan
	 * is a forward walk.
	 */
	private readonly deliverySeqByOpId = new Map<string, number>()
	private deliverySeqCounter = 0
	private schema: SchemaDefinition | null = null

	/** Node id -> the authenticated principal that claimed it (see claimNode). */
	private readonly nodeOwners = new Map<string, string>()
	/** Operation id -> scope snapshot captured at apply time (RT-14). */
	private readonly scopeSnapshots = new Map<string, OperationScopeSnapshot>()
	/** Fields the current snapshots were captured with (RT-20). */
	private snapshotFingerprint: string | null = null
	/** Blob content hash -> owners that pushed or first claimed it (RT-11). */
	private readonly blobOwners = new Map<string, Set<string>>()

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
		// A change in the fields snapshots capture invalidates every snapshot (RT-20).
		const fingerprint = scopeSnapshotFingerprint(schema)
		if (fingerprint !== this.snapshotFingerprint) {
			this.scopeSnapshots.clear()
			this.snapshotFingerprint = fingerprint
		}
		this.backfillScopeSnapshots()
	}

	async applyRemoteOperation(op: Operation, options?: ApplyRemoteOptions): Promise<ApplyResult> {
		this.assertOpen()

		// Content-addressed dedup: same id = same content
		if (this.operationIndex.has(op.id)) {
			return 'duplicate'
		}

		// Authorization re-check against the row as stored right now. Everything from
		// here to the write is synchronous, so no other writer can interleave.
		if (options?.authorize) {
			const decision = options.authorize(this.readStoredRow(op.collection, op.recordId))
			if (!decision.allowed) {
				throw new UplinkAuthorizationError(decision.code, decision.message, {
					operationId: op.id,
					collection: op.collection,
					recordId: op.recordId,
				})
			}
		}

		const materialized = this.schema?.collections[op.collection] !== undefined
		const pre = materialized ? this.scopeValuesBefore(op.collection, op.recordId) : null

		this.operations.push(op)
		this.operationIndex.set(op.id, op)

		// Assign the next delivery sequence in commit order (single-process: no race).
		this.deliverySeqCounter += 1
		this.deliverySeqByOpId.set(op.id, this.deliverySeqCounter)

		// Advance version vector
		const currentSeq = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentSeq) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		// Dual-write: update materialized records if schema is set
		if (materialized) {
			this.rebuildMaterializedRecord(op.collection, op.recordId)
			// The record's scope values around this write, from the store's own rows.
			const row = this.materializedRecords.get(op.collection)?.get(op.recordId) ?? null
			this.scopeSnapshots.set(op.id, {
				pre,
				post: scopeValuesOf(this.schema, op.collection, op.recordId, row),
			})
		}

		return 'applied'
	}

	async getOperationScopeSnapshots(
		operationIds: string[],
	): Promise<Map<string, OperationScopeSnapshot>> {
		this.assertOpen()
		const result = new Map<string, OperationScopeSnapshot>()
		for (const id of operationIds) {
			const snapshot = this.scopeSnapshots.get(id)
			if (snapshot) result.set(id, snapshot)
		}
		return result
	}

	async getRecordLatestTimestamp(
		collection: string,
		recordId: string,
	): Promise<HLCTimestamp | null> {
		this.assertOpen()
		let latest: HLCTimestamp | null = null
		for (const op of this.operations) {
			if (op.collection !== collection || op.recordId !== recordId) continue
			if (latest === null || HybridLogicalClock.compare(op.timestamp, latest) > 0) {
				latest = op.timestamp
			}
		}
		return latest
	}

	async recordBlobOwner(hash: string, owner: string): Promise<void> {
		this.assertOpen()
		let owners = this.blobOwners.get(hash)
		if (!owners) {
			owners = new Set()
			this.blobOwners.set(hash, owners)
		}
		owners.add(owner)
	}

	async getBlobOwners(hashes: string[]): Promise<Map<string, string[]>> {
		this.assertOpen()
		return new Map(hashes.map((hash) => [hash, [...(this.blobOwners.get(hash) ?? [])]]))
	}

	async claimBlobIfUnowned(hash: string, owner: string): Promise<boolean> {
		this.assertOpen()
		const owners = this.blobOwners.get(hash)
		if (owners && owners.size > 0) return owners.has(owner)
		this.blobOwners.set(hash, new Set([owner]))
		return true
	}

	/** Scope values of a live record before a write; null when absent or deleted. */
	private scopeValuesBefore(collection: string, recordId: string): Record<string, unknown> | null {
		const row = this.materializedRecords.get(collection)?.get(recordId)
		if (!row || row._deleted === 1) return null
		return scopeValuesOf(this.schema, collection, recordId, row)
	}

	/**
	 * Rebuild missing scope snapshots from the log (migration from a store without
	 * them, or a replace-mode backup import), replaying each record in commit order.
	 */
	private backfillScopeSnapshots(): void {
		const schema = this.schema
		if (!schema) return
		const byRecord = new Map<string, Operation[]>()
		for (const op of this.operations) {
			if (!schema.collections[op.collection]) continue
			const key = `${op.collection}:::${op.recordId}`
			let list = byRecord.get(key)
			if (!list) {
				list = []
				byRecord.set(key, list)
			}
			list.push(op)
		}
		for (const ops of byRecord.values()) {
			if (ops.every((op) => this.scopeSnapshots.has(op.id))) continue
			const first = ops[0] as Operation
			const replayed = replayScopeSnapshots(
				schema,
				first.collection,
				first.recordId,
				ops.map((op) => ({
					id: op.id,
					type: op.type,
					data: op.data,
					atomicOps: op.atomicOps ?? null,
					timestamp: op.timestamp,
				})),
			)
			for (const [id, snapshot] of replayed) {
				if (!this.scopeSnapshots.has(id)) this.scopeSnapshots.set(id, snapshot)
			}
		}
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

	async getMaxDeliverySequence(): Promise<number> {
		this.assertOpen()
		return this.deliverySeqCounter
	}

	async getOperationsAfterDelivery(
		afterDeliverySequence: number,
		limit: number,
	): Promise<DeliveredOperation[]> {
		this.assertOpen()
		const result: DeliveredOperation[] = []
		if (limit <= 0) return result
		// operations is in delivery order, so once entries exceed the cursor they all do;
		// the guard on each entry keeps this correct even if that invariant ever weakens.
		for (const op of this.operations) {
			const deliverySequence = this.deliverySeqByOpId.get(op.id) ?? 0
			if (deliverySequence > afterDeliverySequence) {
				result.push({
					operation: op,
					deliverySequence,
					scopeSnapshot: this.scopeSnapshots.get(op.id) ?? null,
				})
				if (result.length >= limit) break
			}
		}
		return result
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

	async claimNode(nodeId: string, userId: string): Promise<boolean> {
		this.assertOpen()
		if (userId === RELEASED_NODE_OWNER) return false
		const owner = this.nodeOwners.get(nodeId)
		if (owner === undefined) {
			// History without a claim predates node claims: its writer is unknown, so
			// nobody adopts it until an admin releases it (RT-5).
			if ((this.versionVector.get(nodeId) ?? 0) > 0) return false
			this.nodeOwners.set(nodeId, userId)
			return true
		}
		if (owner === RELEASED_NODE_OWNER) {
			this.nodeOwners.set(nodeId, userId)
			return true
		}
		return owner === userId
	}

	async getNodeClaimOwner(nodeId: string): Promise<string | null> {
		this.assertOpen()
		return this.nodeOwners.get(nodeId) ?? null
	}

	async replaceNodeClaim(
		nodeId: string,
		expectedOwner: string,
		newOwner: string,
	): Promise<boolean> {
		this.assertOpen()
		if (this.nodeOwners.get(nodeId) !== expectedOwner) return false
		this.nodeOwners.set(nodeId, newOwner)
		return true
	}

	async releaseNodeClaim(nodeId: string): Promise<boolean> {
		this.assertOpen()
		const known = this.nodeOwners.has(nodeId) || (this.versionVector.get(nodeId) ?? 0) > 0
		if (!known) return false
		this.nodeOwners.set(nodeId, RELEASED_NODE_OWNER)
		return true
	}

	/**
	 * The record as currently stored, including a soft-deleted one (whose last field
	 * values are kept), or null when it was never written. Without a materialized
	 * table, the last known values are replayed from the operation log.
	 */
	private readStoredRow(collection: string, recordId: string): MaterializedRecord | null {
		if (this.schema?.collections[collection]) {
			const record = this.materializedRecords.get(collection)?.get(recordId)
			if (!record) return null
			const stored: MaterializedRecord = { ...record, id: recordId }
			stored._deleted = undefined
			return stored
		}
		const recordOps = this.operations
			.filter((o) => o.collection === collection && o.recordId === recordId)
			.sort((a, b) => compareTimestamps(a, b))
		if (recordOps.length === 0) return null
		const lastKnown = replayOperationsForRecord(
			recordOps
				.filter((o) => o.type !== 'delete')
				.map((o) => ({ type: o.type, data: o.data, atomicOps: o.atomicOps ?? null })),
		)
		return { ...(lastKnown ?? {}), id: recordId }
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
		this.nodeOwners.clear()
		this.scopeSnapshots.clear()
		this.blobOwners.clear()
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
		this.deliverySeqByOpId.clear()
		this.deliverySeqCounter = 0
		this.scopeSnapshots.clear()

		for (const [nid, seq] of versionVector) {
			this.versionVector.set(nid, seq)
		}

		for (const op of operations) {
			this.operations.push(op)
			this.operationIndex.set(op.id, op)
			// Re-assign delivery sequence in backup order (the order ops were shipped).
			this.deliverySeqCounter += 1
			this.deliverySeqByOpId.set(op.id, this.deliverySeqCounter)

			// Update materialized records if schema is set
			if (this.schema?.collections[op.collection]) {
				this.rebuildMaterializedRecord(op.collection, op.recordId)
			}
		}
		this.backfillScopeSnapshots()

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

		// Get all ops for this record in HLC total order (wallTime, logical, nodeId)
		// so atomic composition and LWW converge like the merge engine.
		const recordOps = this.operations
			.filter((op) => op.collection === collection && op.recordId === recordId)
			.sort((a, b) => {
				if (a.timestamp.wallTime !== b.timestamp.wallTime)
					return a.timestamp.wallTime - b.timestamp.wallTime
				if (a.timestamp.logical !== b.timestamp.logical)
					return a.timestamp.logical - b.timestamp.logical
				return a.timestamp.nodeId < b.timestamp.nodeId
					? -1
					: a.timestamp.nodeId > b.timestamp.nodeId
						? 1
						: 0
			})

		const parsedOps = recordOps.map((op) => ({
			type: op.type,
			data: op.data,
			atomicOps: op.atomicOps ?? null,
			previousData: op.previousData ?? null,
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

function compareTimestamps(a: Operation, b: Operation): number {
	if (a.timestamp.wallTime !== b.timestamp.wallTime)
		return a.timestamp.wallTime - b.timestamp.wallTime
	if (a.timestamp.logical !== b.timestamp.logical) return a.timestamp.logical - b.timestamp.logical
	return a.timestamp.nodeId < b.timestamp.nodeId
		? -1
		: a.timestamp.nodeId > b.timestamp.nodeId
			? 1
			: 0
}
