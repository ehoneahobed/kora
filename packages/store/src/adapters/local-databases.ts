/// <reference lib="dom" />
/**
 * Explicit management of the local databases on this origin (W8a, NEW-STORE-7).
 *
 * Kora never evicts a database on its own: a full pool is prevented by
 * per-database pools and capacity reservation, and removing data is always an
 * explicit call that refuses while the database is open or still holds
 * operations the server has not acknowledged.
 */

import { AdapterError, StorageInUseError, UnsyncedDataError } from '../errors'
import { type DatabaseDump, restoreDumpStatements } from './database-dump'
import { leaderLockName } from './opfs-names'
import type { WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'
import { deleteFromIndexedDB, loadDumpFromIndexedDB } from './sqlite-wasm-persistence'
import {
	type LocalDatabaseRecord,
	deleteManifestRecord,
	listManifestRecords,
	readManifestRecord,
} from './storage-manifest'

/** Read-only access to a database handed to the unsynced-data check. */
export interface LocalDatabaseReader {
	dbName: string
	query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

/** Options for {@link deleteLocalDatabase}. */
export interface DeleteLocalDatabaseOptions {
	/** URL of the Kora SQLite worker (the same one the app's store uses). */
	workerUrl: string | URL
	/**
	 * Decides whether the database still holds operations the server never
	 * acknowledged. Injected by the app layer, which knows its sync setup.
	 * When it returns true the delete is refused with {@link UnsyncedDataError}.
	 */
	hasUnsyncedOperations?: (db: LocalDatabaseReader) => Promise<boolean>
	/** Delete even when unsynced operations exist (they are lost). */
	force?: boolean
	/** Worker response timeout. Defaults to 30000ms. */
	workerResponseTimeoutMs?: number
}

/**
 * Databases Kora has recorded on this origin (created or opened since W8a).
 * A database still in the pre-W8a shared pool appears after its first open.
 */
export async function listLocalDatabases(): Promise<LocalDatabaseRecord[]> {
	return listManifestRecords()
}

/**
 * Hold a database's leader lock for the duration of `run`, so no tab can open
 * it meanwhile. Throws {@link StorageInUseError} when it is open somewhere.
 */
async function withExclusiveDatabase<T>(dbName: string, run: () => Promise<T>): Promise<T> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
	if (!locks || typeof locks.request !== 'function') {
		return run()
	}
	let ran = false
	let result: T | undefined
	await locks.request(
		leaderLockName(dbName),
		{ mode: 'exclusive', ifAvailable: true },
		async (lock) => {
			if (lock === null) return
			ran = true
			result = await run()
		},
	)
	if (!ran) {
		throw new StorageInUseError(dbName)
	}
	return result as T
}

/**
 * Permanently delete a local database and its OPFS pool or IndexedDB copy.
 *
 * Refuses with {@link StorageInUseError} while any tab has the database open,
 * and with {@link UnsyncedDataError} while `hasUnsyncedOperations` reports
 * unsynced operations (unless `force`). Never touches any other database.
 *
 * @returns true when something was deleted, false when the database did not exist
 */
export async function deleteLocalDatabase(
	dbName: string,
	options: DeleteLocalDatabaseOptions,
): Promise<boolean> {
	const record = await readManifestRecord(dbName)
	const backend = record?.backend ?? 'opfs'
	return withExclusiveDatabase(dbName, async () => {
		const { WebWorkerBridge } = await import('./sqlite-wasm-channel')
		const worker = new WebWorkerBridge(options.workerUrl, options.workerResponseTimeoutMs ?? 30_000)
		const send = async (request: WorkerRequest): Promise<WorkerResponse> => worker.send(request)
		const reader: LocalDatabaseReader = {
			dbName,
			query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
				const response = await send({ id: 0, type: 'query', sql, params })
				if (response.type === 'error') {
					throw new AdapterError(`Query failed: ${response.message}`, { dbName, sql })
				}
				return (response.data as T[]) ?? []
			},
		}
		try {
			let exists: boolean
			if (backend === 'opfs') {
				const opened = await worker.send(
					{ id: 0, type: 'open', ddlStatements: [], dbName, mustExist: true },
					undefined,
					{ timeoutMs: Number.POSITIVE_INFINITY },
				)
				if (opened.type === 'error' && opened.code !== 'NOT_FOUND') {
					throw new AdapterError(`Could not open "${dbName}" for deletion: ${opened.message}`, {
						dbName,
						code: opened.code,
					})
				}
				exists = opened.type === 'success'
			} else {
				const dump = await loadDumpFromIndexedDB<DatabaseDump>(dbName)
				exists = dump !== null
				if (dump) {
					await send({ id: 0, type: 'open', ddlStatements: [], dbName, storage: 'memory' })
					for (const statement of restoreDumpStatements(dump, true)) {
						await send({ id: 0, type: 'execute', sql: statement.sql, params: statement.params })
					}
				}
			}

			if (exists && !options.force && options.hasUnsyncedOperations) {
				if (await options.hasUnsyncedOperations(reader)) {
					throw new UnsyncedDataError(dbName)
				}
			}

			if (backend === 'opfs' && exists) {
				const destroyed = await send({ id: 0, type: 'destroy' })
				if (destroyed.type === 'error') {
					throw new AdapterError(`Could not delete "${dbName}": ${destroyed.message}`, { dbName })
				}
			}
			if (backend === 'indexeddb') {
				await deleteFromIndexedDB(dbName)
			}
			await deleteManifestRecord(dbName)
			return exists || record !== null
		} finally {
			worker.terminate()
		}
	})
}
