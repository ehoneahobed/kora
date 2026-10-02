import { KoraError, quoteIdent } from '@korajs/core'
import { hasUnsyncedOwnOperations } from '@korajs/store/internal'
import type { KoraConfig, LocalDatabaseInfo, StorageApi } from './types'

/** Read access to a database, as handed to the unsynced-data check. */
interface DatabaseReader {
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/**
 * Whether a local database still holds operations the server never
 * acknowledged. With sync configured that is the persisted outbound queue
 * (`_kora_sync_queue`) plus, authoritatively, every own operation of any local node
 * id above that node's contiguous acknowledged prefix that the server did not refuse
 * for good (RT-41): such operations are often not queued (the one-time upgrade
 * re-upload, an operation committed just before the tab died, a closed per-tab tab).
 * A local-only app never syncs, so any recorded operation counts as unsynced and
 * deleting the database would lose it.
 */
export async function hasUnsyncedOperations(
	db: DatabaseReader,
	syncConfigured: boolean,
): Promise<boolean> {
	const tables = await db.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table'",
	)
	const names = tables.map((table) => table.name)
	if (names.includes('_kora_sync_queue')) {
		const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_sync_queue')
		if ((rows[0]?.n ?? 0) > 0) return true
	}
	if (syncConfigured) {
		return hasUnsyncedOwnOperations(db)
	}
	for (const name of names) {
		if (!name.startsWith('_kora_ops_')) continue
		const rows = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)
		if ((rows[0]?.n ?? 0) > 0) return true
	}
	return false
}

/**
 * `app.storage`: explicit management of the local databases on this origin.
 * Kora never deletes a database on its own; these calls are the only way, and
 * deletion refuses while the database is open or has unsynced operations.
 */
export function createStorageApi(config: KoraConfig): StorageApi {
	return {
		async listDatabases(): Promise<LocalDatabaseInfo[]> {
			if (typeof indexedDB === 'undefined') return []
			const { listLocalDatabases } = await import('@korajs/store/sqlite-wasm')
			return listLocalDatabases()
		},
		async deleteDatabase(name: string, options: { force?: boolean } = {}): Promise<boolean> {
			const workerUrl = config.store?.workerUrl
			if (!workerUrl || typeof indexedDB === 'undefined') {
				throw new KoraError(
					'app.storage.deleteDatabase() manages browser storage and needs store.workerUrl. Server and Node stores are files you manage directly.',
					'STORAGE_UNSUPPORTED',
					{ name },
				)
			}
			const { deleteLocalDatabase } = await import('@korajs/store/sqlite-wasm')
			return deleteLocalDatabase(name, {
				workerUrl,
				force: options.force === true,
				workerResponseTimeoutMs: config.store?.workerResponseTimeoutMs,
				hasUnsyncedOperations: (db) => hasUnsyncedOperations(db, config.sync !== undefined),
			})
		},
	}
}
