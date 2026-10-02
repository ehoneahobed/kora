import { quoteIdent } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'
import { buildInsertQuery } from '../query/sql-builder'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import type { OperationRow, Transaction } from '../types'

/**
 * The content-addressed id of an operation whose stamp, node, sequence or causal deps
 * were rewritten locally before it was ever shared (clock rebase, node rotation,
 * SEQUENCE_CONFLICT renumbering). Uses the operation's own hash version: a version-2
 * operation (protocol v2) gets a version-2 id over all its semantic fields, and a
 * version-1 operation (written before beta.14) keeps the version-1 hash, so neither
 * fails id verification on its receivers.
 *
 * @param op - The operation with its new content (its `id` is ignored)
 * @returns The id matching that content under the operation's hash version
 */
export async function rehashOperation(op: Operation): Promise<string> {
	return computeOperationId(
		{
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data,
			previousData: op.previousData,
			timestamp: op.timestamp,
			sequenceNumber: op.sequenceNumber,
			causalDeps: op.causalDeps,
			schemaVersion: op.schemaVersion,
			...(op.atomicOps !== undefined ? { atomicOps: op.atomicOps } : {}),
		},
		op.hashVersion === 2 ? 2 : 1,
	)
}

/**
 * Give a logged operation row a new sequence number inside `tx` (SEQUENCE_CONFLICT
 * recovery, RT-35; legacy duplicate repair, W6). A version-1 operation keeps its id:
 * its hash never covered the sequence number. A version-2 operation's id does cover it
 * (CORE-1), so it is re-hashed and its row replaced under the new id; it was never
 * stored by the server (that is why it is renumbered), so no replica knows the old id.
 *
 * @returns The operation as it is now logged
 */
export async function renumberOperationRow(
	tx: Transaction,
	collection: string,
	row: OperationRow,
	sequenceNumber: number,
): Promise<Operation> {
	const table = quoteIdent(`_kora_ops_${collection}`)
	const current = deserializeOperationWithCollection(row, collection)
	const renumbered: Operation = { ...current, sequenceNumber }
	if (current.hashVersion !== 2) {
		await tx.execute(`UPDATE ${table} SET sequence_number = ? WHERE id = ?`, [
			sequenceNumber,
			row.id,
		])
		return renumbered
	}
	const id = await rehashOperation(renumbered)
	const moved: Operation = { ...renumbered, id }
	await tx.execute(`DELETE FROM ${table} WHERE id = ?`, [row.id])
	const insert = buildInsertQuery(
		`_kora_ops_${collection}`,
		serializeOperation(moved) as unknown as Record<string, unknown>,
	)
	await tx.execute(insert.sql, insert.params)
	return moved
}
