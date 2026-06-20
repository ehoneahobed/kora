import type { ConstraintContext } from '@korajs/merge'
import type { ServerStore } from '../store/server-store'

/**
 * Adapts {@link ServerStore} materialized tables for Tier 2 constraint checks.
 */
export function createServerConstraintContext(store: ServerStore): ConstraintContext {
	return {
		async queryRecords(
			collection: string,
			where: Record<string, unknown>,
		): Promise<Record<string, unknown>[]> {
			const rows = await store.queryCollection(collection, { where })
			return rows.map((row) => ({ ...row }))
		},
		async countRecords(collection: string, where: Record<string, unknown>): Promise<number> {
			return store.countCollection(collection, where)
		},
	}
}
