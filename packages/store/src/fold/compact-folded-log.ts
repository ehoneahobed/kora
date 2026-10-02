import {
	type FoldState,
	HybridLogicalClock,
	type Operation,
	type SchemaDefinition,
	type VersionVector,
	createFoldState,
	createVersionVector,
	mergeOp,
	quoteIdent,
} from '@korajs/core'
import { computeAckCompactionWatermark } from '../compaction/compact-operation-log'
import type { CompactionResult, CompactionStrategy } from '../compaction/types'
import { COMPACTION_BASELINE_META_KEY } from '../compaction/types'
import { deserializeOperationWithCollection } from '../serialization/serializer'
import { SEQ_CONFLICTS_TABLE } from '../store/sequence-repair'
import type { OperationRow, StorageAdapter, Transaction } from '../types'
import { COMPACTED_THROUGH_TABLE, type RecordFolder } from './record-folder'

/**
 * Whether compaction must keep this operation in the log. The fold state alone is
 * enough to merge later operations, but the plan keeps the operations whose effect
 * cannot be rebuilt from a row snapshot should a future fold-state version need to
 * re-fold from the log: deletes (the tombstone register), atomic intents and writes
 * to custom-resolver fields.
 */
function mustKeep(op: Operation, schema: SchemaDefinition): boolean {
	if (op.type === 'delete') return true
	if (op.atomicOps !== undefined && Object.keys(op.atomicOps).length > 0) return true
	const resolvers = schema.collections[op.collection]?.resolvers ?? {}
	return Object.keys(op.data ?? {}).some((field) => resolvers[field] !== undefined)
}

/**
 * Per node, the largest sequence k <= the server's acknowledged sequence such that
 * this database holds every operation 1..k (in some collection's log or the
 * retained sequence conflicts). Only such a prefix can be declared compacted:
 * an operation of that node at or below it is then known to be a duplicate.
 */
async function contiguousPrefixes(
	tx: Transaction,
	schema: SchemaDefinition,
	acked: VersionVector,
): Promise<VersionVector> {
	const out = createVersionVector()
	for (const [nodeId, ackedSeq] of acked) {
		if (ackedSeq <= 0) continue
		const seqs = new Set<number>()
		for (const collection of Object.keys(schema.collections)) {
			const rows = await tx.query<{ sequence_number: number }>(
				`SELECT sequence_number FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE node_id = ? AND sequence_number <= ?`,
				[nodeId, ackedSeq],
			)
			for (const row of rows) seqs.add(row.sequence_number)
		}
		const conflicts = await tx.query<{ sequence_number: number }>(
			`SELECT sequence_number FROM ${SEQ_CONFLICTS_TABLE} WHERE node_id = ? AND sequence_number <= ?`,
			[nodeId, ackedSeq],
		)
		for (const row of conflicts) seqs.add(row.sequence_number)
		const through = await tx.query<{ sequence_number: number }>(
			`SELECT sequence_number FROM ${COMPACTED_THROUGH_TABLE} WHERE node_id = ?`,
			[nodeId],
		)
		let k = through[0]?.sequence_number ?? 0
		while (k < ackedSeq && seqs.has(k + 1)) k += 1
		if (k > 0) out.set(nodeId, k)
	}
	return out
}

/**
 * Compaction under the W7 fold (STORE-14). For every node, operations within the
 * contiguous prefix the server acknowledged (and older than the age cutoff, for
 * `after-days`) are folded per record into the record's base state, then removed
 * from the log. The record's live fold state is unchanged (it already holds them):
 * `state = join(base, fold(log))` holds before and after.
 *
 * Operations the server terminally rejected are never folded into a base.
 */
export async function compactFoldedLog(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	folder: RecordFolder,
	strategy: CompactionStrategy,
	serverVector: VersionVector,
): Promise<CompactionResult> {
	const acked = computeAckCompactionWatermark(serverVector)
	if (acked.size === 0) return { deletedCount: 0, watermark: acked }
	const cutoff =
		strategy.mode === 'after-days'
			? HybridLogicalClock.serialize({
					wallTime: Date.now() - strategy.days * 24 * 60 * 60 * 1000,
					logical: 0,
					nodeId: '',
				}).slice(0, 15)
			: null

	let deletedCount = 0
	let watermark = createVersionVector()
	await adapter.transaction(async (tx) => {
		watermark = await contiguousPrefixes(tx, schema, acked)
		for (const collection of Object.keys(schema.collections)) {
			const table = quoteIdent(`_kora_ops_${collection}`)
			const byRecord = new Map<string, Operation[]>()
			for (const [nodeId, maxSeq] of watermark) {
				const rows = await tx.query<OperationRow>(
					`SELECT * FROM ${table} WHERE node_id = ? AND sequence_number <= ?${cutoff !== null ? ' AND SUBSTR(timestamp, 1, 15) < ?' : ''}`,
					cutoff !== null ? [nodeId, maxSeq, cutoff] : [nodeId, maxSeq],
				)
				for (const row of rows) {
					const op = deserializeOperationWithCollection(row, collection)
					if (mustKeep(op, schema)) continue
					const list = byRecord.get(op.recordId) ?? []
					list.push(op)
					byRecord.set(op.recordId, list)
				}
			}
			for (const [recordId, ops] of byRecord) {
				const rejected = await folder.loadTerminalRejections(
					tx,
					ops.map((op) => op.id),
				)
				let addition: FoldState = createFoldState(collection, recordId)
				let any = false
				for (const op of ops) {
					if (rejected.has(op.id)) continue
					addition = mergeOp(addition, op, schema, folder.options()).state
					any = true
				}
				if (any) await folder.joinIntoBase(tx, addition)
				for (let i = 0; i < ops.length; i += 500) {
					const chunk = ops.slice(i, i + 500)
					await tx.execute(
						`DELETE FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`,
						chunk.map((op) => op.id),
					)
				}
				deletedCount += ops.length
			}
		}
		for (const [nodeId, seq] of watermark) {
			await tx.execute(
				`INSERT INTO ${COMPACTED_THROUGH_TABLE} (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
				[nodeId, seq],
			)
		}
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			COMPACTION_BASELINE_META_KEY,
			String(Date.now()),
		])
	})
	return { deletedCount, watermark }
}
