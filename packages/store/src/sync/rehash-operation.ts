import { quoteIdent } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'
import { buildInsertQuery } from '../query/sql-builder'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import type { OperationRow, Transaction } from '../types'

/** Result of `Store.resequenceOperation` (RT-35 renumbering). */
export interface ResequenceResult {
	/** The renumbered operation (a version-2 one under a new id). */
	operation: Operation
	/** Never-sent dependents rewritten to name the new id (re-hashed), in sequence order. */
	dependents: Operation[]
	/** Old id -> new id, for the operation and every re-hashed dependent. */
	idMapping: Record<string, string>
}

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
	await replaceOperationRow(tx, collection, row.id, moved)
	return moved
}

async function replaceOperationRow(
	tx: Transaction,
	collection: string,
	oldId: string,
	next: Operation,
): Promise<void> {
	await tx.execute(`DELETE FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE id = ?`, [oldId])
	const insert = buildInsertQuery(
		`_kora_ops_${collection}`,
		serializeOperation(next) as unknown as Record<string, unknown>,
	)
	await tx.execute(insert.sql, insert.params)
}

/**
 * After operations were re-hashed under new ids (`idMapping`, old id -> new id), make
 * the local operations that name an old id in `causalDeps` name the new one, inside
 * `tx`. Only operations in `rewritable` are touched: those the server never stored
 * (never sent). Each rewritten operation covers its causalDeps in its id (version 2),
 * so it is re-hashed too and its own dependents follow, transitively, in sequence
 * order (sequence order is authoring order, so a dependency is always rewritten before
 * its dependents). A version-1 operation keeps its id (its hash does not cover
 * causalDeps) but still gets the new dep. `idMapping` is extended in place.
 *
 * An operation outside `rewritable` (already sent: the server may hold it under its
 * id) is never rewritten; its dep on an old id resolves through `_kora_seq_conflicts`
 * (`reemitted_as`) on this device.
 *
 * @returns The rewritten operations, in sequence order
 */
export async function rewriteDependentsInTx(
	tx: Transaction,
	collections: readonly string[],
	nodeId: string,
	idMapping: Record<string, string>,
	rewritable: ReadonlySet<string>,
): Promise<Operation[]> {
	if (rewritable.size === 0) return []
	const candidates: Array<{ collection: string; row: OperationRow; op: Operation }> = []
	for (const collection of collections) {
		const rows = await tx.query<OperationRow>(
			`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE node_id = ?`,
			[nodeId],
		)
		for (const row of rows) {
			if (!rewritable.has(row.id)) continue
			candidates.push({ collection, row, op: deserializeOperationWithCollection(row, collection) })
		}
	}
	candidates.sort((a, b) => a.op.sequenceNumber - b.op.sequenceNumber)
	const rewritten: Operation[] = []
	for (const { collection, row, op } of candidates) {
		if (!op.causalDeps.some((dep) => idMapping[dep] !== undefined)) continue
		const causalDeps = op.causalDeps.map((dep) => idMapping[dep] ?? dep)
		const updated: Operation = { ...op, causalDeps }
		const id = op.hashVersion === 2 ? await rehashOperation(updated) : op.id
		const next: Operation = { ...updated, id }
		await replaceOperationRow(tx, collection, row.id, next)
		if (id !== op.id) idMapping[op.id] = id
		rewritten.push(next)
	}
	return rewritten
}
