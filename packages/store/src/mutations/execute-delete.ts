import { createOperation } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { RecordNotFoundError } from '../errors'
import { serializeRowVersion } from '../lww/row-version'
import { buildInsertQuery, buildSoftDeleteQuery } from '../query/sql-builder'
import { serializeOperation } from '../serialization/serializer'
import { allocateNextSequenceInTransaction } from '../store/sequence-allocator'
import type { RawCollectionRow } from '../types'
import { resolveCausalDeps } from './resolve-causal-deps'
import type { LocalMutationContext } from './types'

export interface ExecuteDeleteOptions {
	/** When true, skip RelationEnforcer (caller already enforced referential integrity). */
	skipReferentialEnforcement?: boolean
	/** Pre-built delete operation (avoids duplicate sequence allocation). */
	operation?: Operation
}

/**
 * Soft-delete a record and persist the operation log entry atomically.
 * Returns the primary delete operation and any cascaded side-effect operations.
 */
export async function executeDelete(
	ctx: LocalMutationContext,
	id: string,
	options?: ExecuteDeleteOptions,
): Promise<Operation[]> {
	const currentRows = await ctx.adapter.query<RawCollectionRow>(
		`SELECT * FROM ${ctx.collection} WHERE id = ? AND _deleted = 0`,
		[id],
	)
	if (!currentRows[0]) {
		throw new RecordNotFoundError(ctx.collection, id)
	}

	const causalDeps = resolveCausalDeps(ctx)
	let operation = options?.operation
	const cascadedOps: Operation[] = []

	await ctx.adapter.transaction(async (tx) => {
		if (!operation) {
			const sequenceNumber = await allocateNextSequenceInTransaction(tx, ctx.nodeId)
			operation = await createOperation(
				{
					nodeId: ctx.nodeId,
					type: 'delete',
					collection: ctx.collection,
					recordId: id,
					data: null,
					previousData: null,
					sequenceNumber,
					causalDeps,
					schemaVersion: ctx.schema.version,
				},
				ctx.clock,
			)
			ctx.causalTracker?.afterOperation(ctx.collection, operation.id, ctx.inTransaction)
		}

		if (ctx.relationEnforcer && !options?.skipReferentialEnforcement) {
			const enforcementResult = await ctx.relationEnforcer.enforceDelete(ctx.collection, id, tx, [
				operation.id,
			])
			cascadedOps.push(...enforcementResult.operations)
		}

		const version = serializeRowVersion(operation.timestamp)
		const deleteQuery = buildSoftDeleteQuery(
			ctx.collection,
			id,
			operation.timestamp.wallTime,
			version,
		)
		const opInsert = buildInsertQuery(
			`_kora_ops_${ctx.collection}`,
			serializeOperation(operation) as unknown as Record<string, unknown>,
		)

		await tx.execute(deleteQuery.sql, deleteQuery.params)
		await tx.execute(opInsert.sql, opInsert.params)
	})

	if (!operation) {
		throw new Error('Delete operation was not created')
	}

	ctx.onMutation(ctx.collection, operation)
	for (const cascadedOp of cascadedOps) {
		ctx.onMutation(cascadedOp.collection, cascadedOp)
	}

	return [operation, ...cascadedOps]
}
