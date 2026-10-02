import type { Operation, SchemaDefinition } from '@korajs/core'
import { KoraError, quoteIdent } from '@korajs/core'
import type { WriteEnv, WriteScope } from '../mutations/write-context'
import { writeDeleteInTx, writeUpdateInTx } from '../mutations/write-ops'
import type { Transaction } from '../types'
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
 * The enforcer runs inside the delete's write transaction and writes every side
 * effect through the single local write path (`writeDeleteInTx` /
 * `writeUpdateInTx`), so cascaded operations reserve their sequence numbers in
 * the same contiguous block as the parent and carry per-field version stamps
 * (STORE-2, STORE-3). Every generated operation depends causally on the delete
 * that caused it.
 *
 * @example
 * ```typescript
 * const enforcer = new RelationEnforcer({ schema })
 * // inside a write transaction, after building the parent delete operation:
 * const result = await enforcer.enforceDelete('projects', 'proj-1', scope, env, deleteOp.id)
 * // result.operations contains any cascaded delete/update ops
 * ```
 */
export class RelationEnforcer {
	private readonly lookup: Map<string, IncomingRelation[]>

	constructor(config: RelationEnforcerConfig) {
		this.lookup = buildRelationLookup(config.schema)
	}

	/**
	 * Enforce referential integrity for a record being deleted.
	 *
	 * @param collection - The collection the deleted record belongs to
	 * @param recordId - The ID of the deleted record
	 * @param scope - The active write scope (transaction + causal scope)
	 * @param env - The write environment of the delete
	 * @param parentOpId - Id of the delete operation; every side effect depends on it
	 * @returns All additional operations created as side effects
	 * @throws {ReferentialIntegrityError} If a 'restrict' policy is violated
	 */
	async enforceDelete(
		collection: string,
		recordId: string,
		scope: WriteScope,
		env: WriteEnv,
		parentOpId: string,
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
			const ops = await this.enforceRelation(incoming, recordId, scope, env, parentOpId)
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
		scope: WriteScope,
		env: WriteEnv,
		parentOpId: string,
	): Promise<Operation[]> {
		switch (incoming.onDelete) {
			case 'cascade':
				return this.enforceCascade(incoming, deletedRecordId, scope, env, parentOpId)
			case 'set-null':
				return this.enforceSetNull(incoming, deletedRecordId, scope, env, parentOpId)
			case 'restrict':
				return this.enforceRestrict(incoming, deletedRecordId, scope.tx)
			case 'no-action':
				return []
		}
	}

	/**
	 * Cascade: delete every live record that references the deleted record. Each
	 * cascaded delete runs the full delete path, so it recurses into its own
	 * referencing records.
	 */
	private async enforceCascade(
		incoming: IncomingRelation,
		deletedRecordId: string,
		scope: WriteScope,
		env: WriteEnv,
		parentOpId: string,
	): Promise<Operation[]> {
		const referencingIds = await this.findReferencing(incoming, deletedRecordId, scope.tx)
		const operations: Operation[] = []
		for (const id of referencingIds) {
			const result = await writeDeleteInTx(env, scope, incoming.sourceCollection, id, {
				extraCausalDeps: [parentOpId],
			})
			if (result.operation) operations.push(result.operation)
			operations.push(...result.sideEffects)
		}
		return operations
	}

	/**
	 * Set-null: set the foreign key to null on every live referencing record.
	 */
	private async enforceSetNull(
		incoming: IncomingRelation,
		deletedRecordId: string,
		scope: WriteScope,
		env: WriteEnv,
		parentOpId: string,
	): Promise<Operation[]> {
		const referencingIds = await this.findReferencing(incoming, deletedRecordId, scope.tx)
		const operations: Operation[] = []
		for (const id of referencingIds) {
			const result = await writeUpdateInTx(
				env,
				scope,
				incoming.sourceCollection,
				id,
				{ [incoming.foreignKeyField]: null },
				[parentOpId],
			)
			if (result.operation) operations.push(result.operation)
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
			`SELECT COUNT(*) as cnt FROM ${quoteIdent(sourceCollection)} WHERE ${quoteIdent(foreignKeyField)} = ? AND _deleted = 0`,
			[deletedRecordId],
		)
		const count = countRows[0]?.cnt ?? 0

		if (count > 0) {
			throw new ReferentialIntegrityError(
				incoming.relation.to,
				deletedRecordId,
				sourceCollection,
				relationName,
				count,
			)
		}

		return []
	}

	/** Ids of live records referencing `deletedRecordId`, in id order (deterministic). */
	private async findReferencing(
		incoming: IncomingRelation,
		deletedRecordId: string,
		tx: Transaction,
	): Promise<string[]> {
		const rows = await tx.query<{ id: string }>(
			`SELECT id FROM ${quoteIdent(incoming.sourceCollection)} WHERE ${quoteIdent(incoming.foreignKeyField)} = ? AND _deleted = 0 ORDER BY id`,
			[deletedRecordId],
		)
		return rows.map((row) => row.id)
	}

	/**
	 * Get the relation lookup map for external use (e.g., by the merge engine).
	 */
	getRelationLookup(): Map<string, IncomingRelation[]> {
		return this.lookup
	}
}
