import { KoraError } from '@korajs/core'
import type { InvokeFn } from './tauri-sqlite-adapter'

/**
 * Local database files of a Tauri app, for `app.storage.deleteDatabase()`: Kora's own
 * erase-this-device call, which works offline and never writes a synced delete.
 * `korajs` combines these with its unsynced-data check; apps call `app.storage`.
 */

const PLUGIN_PREFIX = 'plugin:kora-sqlite|'

/** What the plugin reports about a database file. */
export interface TauriDatabaseFileState {
	/** This app has the database open. */
	open: boolean
	/** The database file exists in the app's data directory. */
	exists: boolean
}

/** Thrown by {@link deleteTauriDatabase} while the database is open in this app. */
export class TauriDatabaseInUseError extends KoraError {
	constructor(readonly path: string) {
		super(
			`Database "${path}" is open; close the app's store before deleting it.`,
			'TAURI_DATABASE_IN_USE',
			{ path },
		)
		this.name = 'TauriDatabaseInUseError'
	}
}

async function resolveInvoke(invoke?: InvokeFn): Promise<InvokeFn> {
	if (invoke) return invoke
	const core = await import('@tauri-apps/api/core')
	return core.invoke as InvokeFn
}

/**
 * Whether a database (a path relative to the app's data directory, such as `kora-db.db`)
 * is open in this app, and whether its file exists.
 */
export async function inspectTauriDatabase(
	path: string,
	invoke?: InvokeFn,
): Promise<TauriDatabaseFileState> {
	const call = await resolveInvoke(invoke)
	return call<TauriDatabaseFileState>(`${PLUGIN_PREFIX}inspect`, { path })
}

/**
 * Read a closed database: opens it without running any schema statements, hands `read` a
 * query function, and closes it again whatever `read` does. Only for a database that
 * exists and is not open (check with {@link inspectTauriDatabase}).
 */
export async function readTauriDatabase<T>(
	path: string,
	read: (db: { query<R>(sql: string, params?: unknown[]): Promise<R[]> }) => Promise<T>,
	invoke?: InvokeFn,
): Promise<T> {
	const call = await resolveInvoke(invoke)
	await call(`${PLUGIN_PREFIX}open`, { path, statements: [] })
	try {
		return await read({
			query: <R>(sql: string, params: unknown[] = []) =>
				call<R[]>(`${PLUGIN_PREFIX}query`, { path, sql, params }),
		})
	} finally {
		await call(`${PLUGIN_PREFIX}close`, { path })
	}
}

/**
 * Permanently delete a closed database and SQLite's companion files. Refuses with
 * {@link TauriDatabaseInUseError} while the app has it open. No unsynced-data check: use
 * `app.storage.deleteDatabase()`, which has one.
 *
 * @returns true when a database file existed
 */
export async function deleteTauriDatabase(path: string, invoke?: InvokeFn): Promise<boolean> {
	const call = await resolveInvoke(invoke)
	try {
		return await call<boolean>(`${PLUGIN_PREFIX}delete`, { path })
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.startsWith('STORAGE_IN_USE:')) throw new TauriDatabaseInUseError(path)
		throw error
	}
}
