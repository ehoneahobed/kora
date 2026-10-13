import type { Operation } from '@korajs/core'
import type { ReferentialMergeContext } from '@korajs/merge'
import type { ServerStore } from '../store/server-store'

/**
 * Adapts {@link ServerStore} materialized tables for referential integrity checks.
 */
export function createServerReferentialContext(store: ServerStore): ReferentialMergeContext {
	return {
		async queryRecords(
			collection: string,
			where: Record<string, unknown>,
		): Promise<Record<string, unknown>[]> {
			const rows = await store.queryCollection(collection, { where })
			return rows.map((row) => ({ ...row }))
		},
		async recordExists(collection: string, recordId: string): Promise<boolean> {
			const row = await store.findRecord(collection, recordId)
			return row !== null && row._deleted !== 1
		},
	}
}

/**
 * `base` as it will read after `batch` commits (a transaction judged as a whole): rows
 * the batch deletes are gone, rows it updates carry the new values, rows it inserts are
 * there. So a transaction that removes or moves every child and then deletes their
 * parent under `restrict` is allowed, and one that points a child at a parent it deletes
 * is refused.
 */
export function stagedReferentialContext(
	base: ReferentialMergeContext,
	batch: readonly Operation[],
): ReferentialMergeContext {
	const staged = (collection: string): Map<string, Record<string, unknown> | null> => {
		const rows = new Map<string, Record<string, unknown> | null>()
		for (const op of batch) {
			if (op.collection !== collection) continue
			if (op.type === 'delete') rows.set(op.recordId, null)
			else {
				const previous = rows.get(op.recordId)
				rows.set(op.recordId, { ...(previous ?? {}), ...(op.data ?? {}), id: op.recordId })
			}
		}
		return rows
	}
	const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
		Object.entries(where).every(([field, value]) => Object.is(row[field], value))
	return {
		async queryRecords(collection, where) {
			const changes = staged(collection)
			const out: Record<string, unknown>[] = []
			for (const row of await base.queryRecords(collection, where)) {
				const id = String(row.id)
				if (!changes.has(id)) {
					out.push(row)
					continue
				}
				const change = changes.get(id)
				if (change) {
					const merged = { ...row, ...change }
					if (matches(merged, where)) out.push(merged)
				}
				changes.delete(id)
			}
			// Rows the batch writes that the base did not return (new, or moved here).
			for (const [id, change] of changes) {
				if (change === null) continue
				const current = (await base.queryRecords(collection, { id }))[0] ?? {}
				const merged = { ...current, ...change }
				if (matches(merged, where)) out.push(merged)
			}
			return out
		},
		async recordExists(collection, recordId) {
			const changes = staged(collection)
			if (changes.has(recordId)) return changes.get(recordId) !== null
			return base.recordExists(collection, recordId)
		},
	}
}
