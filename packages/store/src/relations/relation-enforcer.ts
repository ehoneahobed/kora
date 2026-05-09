import type { HybridLogicalClock, Operation, SchemaDefinition } from '@korajs/core'
import { KoraError, createOperation } from '@korajs/core'
import { buildInsertQuery, buildSoftDeleteQuery, buildUpdateQuery } from '../query/sql-builder'
import { serializeOperation, serializeRecord } from '../serialization/serializer'
import type { StorageAdapter, Transaction } from '../types'
import type { IncomingRelation } from './relation-lookup'
import { buildRelationLookup, getIncomingRelations } from './relation-lookup'

/**
 * Error thrown when a delete is refused due to a 'restrict' referential integrity policy.
 * The error includes context about which relation caused the restriction and
 * how many referencing records exist.
 */
export class ReferentialIntegrityError extends KoraError {
	constructor(
		collection: string,
		recordId: string,
		referencingCollection: string,
		relationName: string,
		referencingCount: number,
	) {
		super(
			`Cannot delete record "${recordId}" from "${collection}": ${referencingCount} record(s) in "${referencingCollection}" reference it via relation "${relationName}" with onDelete: 'restrict'. Delete or reassign the referencing records first.`,
			'REFERENTIAL_INTEGRITY',
			{
				collection,
				recordId,
				referencingCollection,
				relationName,
				referencingCount,
			},
		)
		this.name = 'ReferentialIntegrityError'
	}
}

/**
 * Configuration for the RelationEnforcer.
 */
export interface RelationEnforcerConfig {
	schema: SchemaDefinition
	adapter: StorageAdapter
	clock: HybridLogicalClock
	nodeId: string
	getSequenceNumber: () => number
}

/**
 * Result of enforcing referential integrity on a delete operation.
 * Contains all additional operations that were created as side effects
 * (cascaded deletes and set-null updates).
 */
export interface EnforcementResult {
	/** Additional operations created by cascading deletes and set-null updates */
	operations: Operation[]
}

/**
 * Enforces referential integrity constraints during local delete operations.
 *
 * When a record is deleted, this enforcer checks all relations that reference
 * the deleted record's collection and applies the appropriate onDelete policy:
 *
 * - **cascade**: Recursively deletes all referencing records
 * - **set-null**: Sets the foreign key to null on all referencing records
 * - **restrict**: Throws a ReferentialIntegrityError if any references exist
 * - **no-action**: Does nothing (the foreign key is left dangling)
 *
 * The enforcer operates within a provided transaction to ensure atomicity.
 * All generated operations (cascaded deletes, set-null updates) share a
 * causal dependency chain through the original delete operation.
 *
 * @example
 * ```typescript
 * const enforcer = new RelationEnforcer({
 *   schema, adapter, clock, nodeId,
 *   getSequenceNumber: () => ++seq,
 * })
 * const result = await enforcer.enforceDelete(
 *   'projects', 'proj-1', tx, ['delete-op-id']
 * )
 * // result.operations contains any cascaded delete/update ops
 * ```
 */
export class RelationEnforcer {
	private readonly lookup: Map<string, IncomingRelation[]>
	private readonly schema: SchemaDefinition
	private readonly adapter: StorageAdapter
	private readonly clock: HybridLogicalClock
	private readonly nodeId: string
	private readonly getSequenceNumber: () => number

	constructor(config: RelationEnforcerConfig) {
		this.schema = config.schema
		this.adapter = config.adapter
		this.clock = config.clock
		this.nodeId = config.nodeId
		this.getSequenceNumber = config.getSequenceNumber
		this.lookup = buildRelationLookup(config.schema)
	}

	/**
	 * Enforce referential integrity after deleting a record.
	 *
	 * Must be called within a transaction. The transaction handle is used
	 * for all cascaded writes to ensure atomicity.
	 *
	 * @param collection - The collection the deleted record belongs to
	 * @param recordId - The ID of the deleted record
	 * @param tx - The active transaction handle
	 * @param causalDeps - Causal dependencies for generated operations
	 * @returns All additional operations created as side effects
	 * @throws {ReferentialIntegrityError} If a 'restrict' policy is violated
	 */
	async enforceDelete(
		collection: string,
		recordId: string,
		tx: Transaction,
		causalDeps: string[],
	): Promise<EnforcementResult> {
		const incomingRelations = getIncomingRelations(this.lookup, collection)
		if (incomingRelations.length === 0) {
			return { operations: [] }
		}

		const allOperations: Operation[] = []

		// Process relations in a deterministic order (sorted by relation name)
		// to ensure identical results regardless of Map iteration order.
		const sortedRelations = [...incomingRelations].sort((a, b) =>
			a.relationName.localeCompare(b.relationName),
		)

		for (const incoming of sortedRelations) {
			const ops = await this.enforceRelation(incoming, recordId, tx, causalDeps)
			allOperations.push(...ops)
		}

		return { operations: allOperations }
	}

	/**
	 * Enforce a single relation's onDelete policy.
	 */
	private async enforceRelation(
		incoming: IncomingRelation,
		deletedRecordId: string,
		tx: Transaction,
		causalDeps: string[],
	): Promise<Operation[]> {
		switch (incoming.onDelete) {
			case 'cascade':
				return this.enforceCascade(incoming, deletedRecordId, tx, causalDeps)
			case 'set-null':
				return this.enforceSetNull(incoming, deletedRecordId, tx, causalDeps)
			case 'restrict':
				return this.enforceRestrict(incoming, deletedRecordId, tx)
			case 'no-action':
				return []
		}
	}

	/**
	 * Cascade: delete all records in the source collection that reference
	 * the deleted record, then recursively cascade those deletes.
	 */
	private async enforceCascade(
		incoming: IncomingRelation,
		deletedRecordId: string,
		tx: Transaction,
		causalDeps: string[],
	): Promise<Operation[]> {
		const { sourceCollection, foreignKeyField } = incoming

		// Find all non-deleted records that reference the deleted record
		const referencingRows = await tx.query<{ id: string }>(
			`SELECT id FROM ${sourceCollection} WHERE ${foreignKeyField} = ? AND _deleted = 0`,
			[deletedRecordId],
		)

		if (referencingRows.length === 0) {
			return []
		}

		const operations: Operation[] = []

		for (const row of referencingRows) {
			const now = Date.now()
			const sequenceNumber = this.getSequenceNumber()

			const operation = await createOperation(
				{
					nodeId: this.nodeId,
					type: 'delete',
					collection: sourceCollection,
					recordId: row.id,
					data: null,
					previousData: null,
					sequenceNumber,
					causalDeps: [...causalDeps],
					schemaVersion: this.schema.version,
				},
				this.clock,
			)

			// Soft-delete the record
			const deleteQuery = buildSoftDeleteQuery(sourceCollection, row.id, now)
			await tx.execute(deleteQuery.sql, deleteQuery.params)

			// Persist the operation
			const opRow = serializeOperation(operation)
			const opInsert = buildInsertQuery(
				`_kora_ops_${sourceCollection}`,
				opRow as unknown as Record<string, unknown>,
			)
			await tx.execute(opInsert.sql, opInsert.params)

			// Update version vector
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
				[this.nodeId, sequenceNumber],
			)

			operations.push(operation)

			// Recursively cascade: this deleted record might also be referenced
			const cascadeResult = await this.enforceDelete(sourceCollection, row.id, tx, [operation.id])
			operations.push(...cascadeResult.operations)
		}

		return operations
	}

	/**
	 * Set-null: update all referencing records to set the foreign key to null.
	 */
	private async enforceSetNull(
		incoming: IncomingRelation,
		deletedRecordId: string,
		tx: Transaction,
		causalDeps: string[],
	): Promise<Operation[]> {
		const { sourceCollection, foreignKeyField } = incoming
		const collectionDef = this.schema.collections[sourceCollection]
		if (!collectionDef) {
			return []
		}

		// Find all non-deleted records that reference the deleted record
		const referencingRows = await tx.query<{ id: string }>(
			`SELECT id FROM ${sourceCollection} WHERE ${foreignKeyField} = ? AND _deleted = 0`,
			[deletedRecordId],
		)

		if (referencingRows.length === 0) {
			return []
		}

		const operations: Operation[] = []

		for (const row of referencingRows) {
			const now = Date.now()
			const sequenceNumber = this.getSequenceNumber()

			const updateData: Record<string, unknown> = { [foreignKeyField]: null }
			const previousData: Record<string, unknown> = { [foreignKeyField]: deletedRecordId }

			const operation = await createOperation(
				{
					nodeId: this.nodeId,
					type: 'update',
					collection: sourceCollection,
					recordId: row.id,
					data: { ...updateData },
					previousData,
					sequenceNumber,
					causalDeps: [...causalDeps],
					schemaVersion: this.schema.version,
				},
				this.clock,
			)

			// Update the record's foreign key to null
			const serializedChanges = serializeRecord(updateData, collectionDef.fields)
			const updateQuery = buildUpdateQuery(sourceCollection, row.id, {
				...serializedChanges,
				_updated_at: now,
			})
			await tx.execute(updateQuery.sql, updateQuery.params)

			// Persist the operation
			const opRow = serializeOperation(operation)
			const opInsert = buildInsertQuery(
				`_kora_ops_${sourceCollection}`,
				opRow as unknown as Record<string, unknown>,
			)
			await tx.execute(opInsert.sql, opInsert.params)

			// Update version vector
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
				[this.nodeId, sequenceNumber],
			)

			operations.push(operation)
		}

		return operations
	}

	/**
	 * Restrict: refuse the delete if any referencing records exist.
	 */
	private async enforceRestrict(
		incoming: IncomingRelation,
		deletedRecordId: string,
		tx: Transaction,
	): Promise<Operation[]> {
		const { sourceCollection, foreignKeyField, relationName } = incoming

		const countRows = await tx.query<{ cnt: number }>(
			`SELECT COUNT(*) as cnt FROM ${sourceCollection} WHERE ${foreignKeyField} = ? AND _deleted = 0`,
			[deletedRecordId],
		)
		const count = countRows[0]?.cnt ?? 0

		if (count > 0) {
			// Determine the target collection from the relation lookup
			const targetCollection = incoming.relation.to
			throw new ReferentialIntegrityError(
				targetCollection,
				deletedRecordId,
				sourceCollection,
				relationName,
				count,
			)
		}

		return []
	}

	/**
	 * Get the relation lookup map for external use (e.g., by the merge engine).
	 */
	getRelationLookup(): Map<string, IncomingRelation[]> {
		return this.lookup
	}
}
