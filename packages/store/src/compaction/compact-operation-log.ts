import type { SchemaDefinition, VersionVector } from '@korajs/core'
import { HybridLogicalClock, createVersionVector } from '@korajs/core'
import type { StorageAdapter, Transaction } from '../types'
import type { CompactionResult, CompactionStrategy } from './types'
import { COMPACTION_BASELINE_META_KEY } from './types'

/**
 * Compute per-node sequence watermarks safe to compact (server has acknowledged these ops).
 */
export function computeAckCompactionWatermark(serverVector: VersionVector): VersionVector {
	const watermark = createVersionVector()
	for (const [nodeId, seq] of serverVector) {
		if (seq > 0) {
			watermark.set(nodeId, seq)
		}
	}
	return watermark
}

/**
 * Remove acknowledged, materialized operation log entries from `_kora_ops_*` tables.
 * Does not modify collection rows — they are the compaction baseline snapshot.
 */
export async function compactOperationLog(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	strategy: CompactionStrategy,
	serverVector: VersionVector,
): Promise<CompactionResult> {
	if (strategy.mode === 'never') {
		return { deletedCount: 0, watermark: createVersionVector() }
	}

	const watermark = computeAckCompactionWatermark(serverVector)
	if (watermark.size === 0) {
		return { deletedCount: 0, watermark }
	}

	const ageCutoffWall =
		strategy.mode === 'after-days' ? Date.now() - strategy.days * 24 * 60 * 60 * 1000 : null
	const ageCutoffSerialized =
		ageCutoffWall !== null
			? HybridLogicalClock.serialize({
					wallTime: ageCutoffWall,
					logical: 0,
					nodeId: '',
				}).slice(0, 15)
			: null

	let deletedCount = 0
	const collectionNames = Object.keys(schema.collections)

	await adapter.transaction(async (tx: Transaction) => {
		for (const collectionName of collectionNames) {
			const table = `_kora_ops_${collectionName}`
			for (const [nodeId, maxSeq] of watermark) {
				if (maxSeq <= 0) continue

				const countSql = buildCountSql(table, ageCutoffSerialized !== null)
				const countParams =
					ageCutoffSerialized !== null ? [nodeId, maxSeq, ageCutoffSerialized] : [nodeId, maxSeq]
				const countRows = await tx.query<{ count: number }>(countSql, countParams)
				deletedCount += countRows[0]?.count ?? 0

				const deleteSql = buildDeleteSql(table, ageCutoffSerialized !== null)
				await tx.execute(deleteSql, countParams)
			}
		}

		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			COMPACTION_BASELINE_META_KEY,
			String(Date.now()),
		])
	})

	return { deletedCount, watermark }
}

function buildCountSql(table: string, withAge: boolean): string {
	if (withAge) {
		return `SELECT COUNT(*) as count FROM ${table} WHERE node_id = ? AND sequence_number <= ? AND SUBSTR(timestamp, 1, 15) < ?`
	}
	return `SELECT COUNT(*) as count FROM ${table} WHERE node_id = ? AND sequence_number <= ?`
}

function buildDeleteSql(table: string, withAge: boolean): string {
	if (withAge) {
		return `DELETE FROM ${table} WHERE node_id = ? AND sequence_number <= ? AND SUBSTR(timestamp, 1, 15) < ?`
	}
	return `DELETE FROM ${table} WHERE node_id = ? AND sequence_number <= ?`
}
