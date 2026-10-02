import type { Operation } from '@korajs/core'
import type { StorageAdapter } from '@korajs/store'
import { deserializeOperation, serializeOperation } from '@korajs/store/internal'
import type { OperationRow } from '@korajs/store/internal'
import type { QueueStorage } from '@korajs/sync'

interface SyncQueueRow {
	id: string
	payload: string
}

type QueuePayload = OperationRow & { _collection: string; _sent?: 1 }

/**
 * Persists the outbound sync queue in `_kora_sync_queue` via the local StorageAdapter.
 */
export class StoreQueueStorage implements QueueStorage {
	constructor(private readonly adapter: StorageAdapter) {}

	async load(): Promise<Operation[]> {
		const rows = await this.adapter.query<SyncQueueRow>(
			'SELECT id, payload FROM _kora_sync_queue ORDER BY rowid ASC',
		)
		return rows.map((row) => operationFromQueuePayload(row.payload))
	}

	async enqueue(op: Operation): Promise<void> {
		const row = serializeOperation(op)
		const payload: QueuePayload = { ...row, _collection: op.collection }
		await this.adapter.execute(
			'INSERT OR REPLACE INTO _kora_sync_queue (id, payload) VALUES (?, ?)',
			[op.id, JSON.stringify(payload)],
		)
	}

	/**
	 * Flag queued operations as sent (W3 step 4: a sent op is never re-stamped by a clock
	 * rebase). An UPDATE, never an insert: an op acknowledged meanwhile stays dequeued.
	 */
	async markSent(ops: Operation[]): Promise<void> {
		for (const op of ops) {
			const payload: QueuePayload = {
				...serializeOperation(op),
				_collection: op.collection,
				_sent: 1,
			}
			await this.adapter.execute('UPDATE _kora_sync_queue SET payload = ? WHERE id = ?', [
				JSON.stringify(payload),
				op.id,
			])
		}
	}

	async loadSentIds(): Promise<string[]> {
		const rows = await this.adapter.query<SyncQueueRow>('SELECT id, payload FROM _kora_sync_queue')
		const ids: string[] = []
		for (const row of rows) {
			try {
				if ((JSON.parse(row.payload) as QueuePayload)._sent === 1) ids.push(row.id)
			} catch {
				// An unreadable row is not reported as sent; load() surfaces the error.
			}
		}
		return ids
	}

	async dequeue(ids: string[]): Promise<void> {
		if (ids.length === 0) return
		const placeholders = ids.map(() => '?').join(', ')
		await this.adapter.execute(`DELETE FROM _kora_sync_queue WHERE id IN (${placeholders})`, ids)
	}

	async count(): Promise<number> {
		const rows = await this.adapter.query<{ cnt: number }>(
			'SELECT COUNT(*) as cnt FROM _kora_sync_queue',
		)
		return rows[0]?.cnt ?? 0
	}
}

function operationFromQueuePayload(payload: string): Operation {
	const parsed = JSON.parse(payload) as QueuePayload
	const op = deserializeOperation(parsed)
	return {
		...op,
		collection: parsed._collection,
	}
}
