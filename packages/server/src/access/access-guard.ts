import type { SchemaDefinition } from '@korajs/core'
import { SyncError } from '@korajs/core'
import type { ServerStore } from '../store/server-store'

/**
 * True when the store keeps the membership index access rules are judged against. The
 * built-in stores (memory, SQLite, Postgres) do; a custom store must implement
 * `getMembershipIntervals` and `getAccessIndexState`.
 */
export function storeIndexesAccess(store: ServerStore): boolean {
	return (
		typeof store.getMembershipIntervals === 'function' &&
		typeof store.getAccessIndexState === 'function'
	)
}

/**
 * A schema that declares access rules needs a store that indexes memberships. Without
 * the index every membership rule would see no members, so the server refuses to run
 * rather than serve those collections under rules it cannot judge.
 *
 * @throws {SyncError} `ACCESS_RULES_UNSUPPORTED_STORE` when the schema declares access
 *   rules and the store keeps no membership index
 */
export function assertAccessRulesSupported(
	schema: SchemaDefinition | null | undefined,
	store: ServerStore,
): void {
	if (!schema?.access || storeIndexesAccess(store)) return
	throw new SyncError(
		'This schema declares access rules, but the server store keeps no membership index. Use a built-in store (memory, SQLite or Postgres), or implement getMembershipIntervals and getAccessIndexState in your store.',
		{ code: 'ACCESS_RULES_UNSUPPORTED_STORE' },
	)
}
