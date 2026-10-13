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

/** Reads of a collection as they will be after `batch` commits (see {@link stagedReferentialContext}). */
export type StagedQuery = (
	collection: string,
	where: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>

/**
 * `query` as it will read after `batch` commits: rows the batch deletes are gone, rows it
 * updates carry the new values (and are matched against `where` again), rows it inserts
 * or moves into the filter are there.
 */
export function stagedQuery(query: StagedQuery, batch: readonly Operation[]): StagedQuery {
	const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
		Object.entries(where).every(([field, value]) => Object.is(row[field], value))
	return async (collection, where) => {
		const changes = new Map<string, Record<string, unknown> | null>()
		for (const op of batch) {
			if (op.collection !== collection) continue
			if (op.type === 'delete') changes.set(op.recordId, null)
			else {
				const previous = changes.get(op.recordId)
				changes.set(op.recordId, { ...(previous ?? {}), ...(op.data ?? {}), id: op.recordId })
			}
		}
		const out: Record<string, unknown>[] = []
		for (const row of await query(collection, where)) {
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
		for (const [id, change] of changes) {
			if (change === null) continue
			const current = (await query(collection, { id }))[0] ?? {}
			const merged = { ...current, ...change }
			if (matches(merged, where)) out.push(merged)
		}
		return out
	}
}

/**
 * `base` as it will read after `batch` commits (a transaction judged as a whole): so a
 * transaction that removes or moves every child and then deletes their parent under
 * `restrict` is allowed, and one that points a child at a parent it deletes is refused.
 */
export function stagedReferentialContext(
	base: ReferentialMergeContext,
	batch: readonly Operation[],
): ReferentialMergeContext {
	const query = stagedQuery((collection, where) => base.queryRecords(collection, where), batch)
	return {
		queryRecords: query,
		async recordExists(collection, recordId) {
			for (let i = batch.length - 1; i >= 0; i--) {
				const op = batch[i]
				if (op && op.collection === collection && op.recordId === recordId) {
					return op.type !== 'delete'
				}
			}
			return base.recordExists(collection, recordId)
		},
	}
}
