import type { Operation } from '@korajs/core'
import type { ConstraintContext } from '@korajs/merge'
import type { ServerStore } from '../store/server-store'
import { stagedQuery } from './server-referential-context'

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

/**
 * `base` as it will read after `batch` commits: a transaction's mutations are checked
 * against each other (a parent and its child inserted together, two inserts that share
 * a unique value).
 */
export function stagedConstraintContext(
	base: ConstraintContext,
	batch: readonly Operation[],
): ConstraintContext {
	const query = stagedQuery((collection, where) => base.queryRecords(collection, where), batch)
	return {
		queryRecords: query,
		async countRecords(collection, where) {
			return (await query(collection, where)).length
		},
	}
}
