import type { StorageAdapter } from '@korajs/store'
import type { RejectedOperation, RejectedOperationStorage } from '@korajs/sync'

interface RejectedRow {
	operation_id: string
	collection: string
	record_id: string
	code: string
	message: string
	retriable: number
	rejected_at: number
}

/**
 * Persists server-rejected operations in `_kora_sync_rejected` via the local
 * StorageAdapter, so a rejection survives a page refresh and stays explainable to
 * the app until it reconciles the optimistic local write.
 */
export class StoreRejectedOperationStorage implements RejectedOperationStorage {
	constructor(private readonly adapter: StorageAdapter) {}

	async record(rejected: RejectedOperation): Promise<void> {
		await this.adapter.execute(
			'INSERT OR REPLACE INTO _kora_sync_rejected (operation_id, collection, record_id, code, message, retriable, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			[
				rejected.operationId,
				rejected.collection,
				rejected.recordId,
				rejected.code,
				rejected.message,
				rejected.retriable ? 1 : 0,
				rejected.rejectedAt,
			],
		)
	}

	async list(): Promise<RejectedOperation[]> {
		const rows = await this.adapter.query<RejectedRow>(
			'SELECT operation_id, collection, record_id, code, message, retriable, rejected_at FROM _kora_sync_rejected ORDER BY rejected_at ASC',
		)
		return rows.map((row) => ({
			operationId: row.operation_id,
			collection: row.collection,
			recordId: row.record_id,
			code: row.code,
			message: row.message,
			retriable: row.retriable === 1,
			rejectedAt: row.rejected_at,
		}))
	}

	async remove(operationIds: string[]): Promise<void> {
		if (operationIds.length === 0) return
		const placeholders = operationIds.map(() => '?').join(', ')
		await this.adapter.execute(
			`DELETE FROM _kora_sync_rejected WHERE operation_id IN (${placeholders})`,
			operationIds,
		)
	}
}
