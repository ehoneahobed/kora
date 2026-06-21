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
