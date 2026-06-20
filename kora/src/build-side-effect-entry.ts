import { createOperation } from '@korajs/core'
import type { SideEffectOp } from '@korajs/merge'
import type { TransactionBufferedEntry } from '@korajs/store'
import type { LocalMutationContext } from '@korajs/store/internal'
import {
	buildInsertQuery,
	buildSoftDeleteQuery,
	buildUpdateQuery,
	serializeOperation,
	serializeRecord,
	serializeRowVersion,
} from '@korajs/store/internal'

/**
 * Materialize a merge-package referential side effect as an operation log entry + SQL commands.
 */
export async function buildSideEffectEntry(
	ctx: LocalMutationContext,
	effect: SideEffectOp,
	parentOpId: string,
	transactionId?: string,
	mutationName?: string,
): Promise<TransactionBufferedEntry> {
	const causalDeps = [parentOpId]
	const baseInput = {
		nodeId: ctx.nodeId,
		collection: effect.collection,
		recordId: effect.recordId,
		sequenceNumber: await ctx.allocateSequenceNumber(),
		causalDeps,
		schemaVersion: ctx.schema.version,
		...(transactionId !== undefined ? { transactionId } : {}),
		...(mutationName !== undefined ? { mutationName } : {}),
	}

	if (effect.type === 'delete') {
		const operation = await createOperation(
			{
				...baseInput,
				type: 'delete',
				data: null,
				previousData: effect.previousData,
			},
			ctx.clock,
		)
		ctx.causalTracker?.afterOperation(effect.collection, operation.id, ctx.inTransaction)

		const version = serializeRowVersion(operation.timestamp)
		const deleteQuery = buildSoftDeleteQuery(
			effect.collection,
			effect.recordId,
			operation.timestamp.wallTime,
			version,
		)
		const opInsert = buildInsertQuery(
			`_kora_ops_${effect.collection}`,
			serializeOperation(operation) as unknown as Record<string, unknown>,
		)

		return {
			operation,
			collection: effect.collection,
			commands: [
				{ sql: deleteQuery.sql, params: deleteQuery.params },
				{ sql: opInsert.sql, params: opInsert.params },
				{
					sql: 'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
					params: [ctx.nodeId, operation.sequenceNumber],
				},
			],
		}
	}

	const operation = await createOperation(
		{
			...baseInput,
			type: 'update',
			data: effect.data,
			previousData: effect.previousData,
		},
		ctx.clock,
	)
	ctx.causalTracker?.afterOperation(effect.collection, operation.id, ctx.inTransaction)

	const definition = ctx.schema.collections[effect.collection]
	const serializedChanges =
		effect.data && definition
			? serializeRecord(effect.data, definition.fields)
			: (effect.data ?? {})
	const version = serializeRowVersion(operation.timestamp)
	const updateQuery = buildUpdateQuery(effect.collection, effect.recordId, {
		...serializedChanges,
		_updated_at: operation.timestamp.wallTime,
		_version: version,
	})
	const opInsert = buildInsertQuery(
		`_kora_ops_${effect.collection}`,
		serializeOperation(operation) as unknown as Record<string, unknown>,
	)

	return {
		operation,
		collection: effect.collection,
		commands: [
			{ sql: updateQuery.sql, params: updateQuery.params },
			{ sql: opInsert.sql, params: opInsert.params },
			{
				sql: 'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
				params: [ctx.nodeId, operation.sequenceNumber],
			},
		],
	}
}
