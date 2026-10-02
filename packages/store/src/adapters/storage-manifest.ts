/// <reference lib="dom" />
/**
 * Kora-owned manifest of the local databases this origin created (W8a).
 *
 * One record per database name, kept in its own IndexedDB database so it is
 * readable from any tab without opening the OPFS pools. It records which backend
 * holds the database's data, which is how Kora keeps OPFS and IndexedDB from
 * ever holding two disjoint copies: a backend switch is a recorded, explicit
 * migration, never a silent fresh start (NEW-STORE-5, LMS-5c).
 *
 * The manifest is advisory for listing and authoritative for the backend
 * choice. Nothing is ever evicted automatically; deletion is the explicit
 * `deleteDatabase()` API.
 */

const MANIFEST_DB_NAME = 'kora-manifest'
const MANIFEST_STORE = 'databases'
const MANIFEST_VERSION = 1

/** Where a database's data lives. */
export type LocalDatabaseBackend = 'opfs' | 'indexeddb'

/** One manifest entry, as returned by `listDatabases()`. */
export interface LocalDatabaseRecord {
	/** The store name (`store.name`, plus the per-user suffix if namespaced). */
	dbName: string
	/** The backend that holds the authoritative copy. */
	backend: LocalDatabaseBackend
	/** OPFS pool holding the file (opfs backend only). */
	poolName?: string
	/** Wall-clock milliseconds; informational only, never used for ordering. */
	createdAt: number
	/** Wall-clock milliseconds of the last durable open; informational only. */
	lastOpenedAt: number
}

/** True when this runtime can keep a manifest (browsers; not Node tests). */
export function isManifestAvailable(): boolean {
	return typeof indexedDB !== 'undefined'
}

function openManifest(): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(MANIFEST_DB_NAME, MANIFEST_VERSION)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
				db.createObjectStore(MANIFEST_STORE, { keyPath: 'dbName' })
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () =>
			reject(request.error ?? new Error('Failed to open the Kora storage manifest'))
	})
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
	const db = await openManifest()
	try {
		return await new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(MANIFEST_STORE, mode)
			const request = run(tx.objectStore(MANIFEST_STORE))
			let result: T | undefined
			if (request) {
				request.onsuccess = () => {
					result = request.result
				}
			}
			tx.oncomplete = () => resolve(result)
			tx.onerror = () => reject(tx.error ?? new Error('Kora storage manifest transaction failed'))
			tx.onabort = () => reject(tx.error ?? new Error('Kora storage manifest transaction aborted'))
		})
	} finally {
		db.close()
	}
}

function isRecord(value: unknown): value is LocalDatabaseRecord {
	if (typeof value !== 'object' || value === null) return false
	const record = value as Partial<LocalDatabaseRecord>
	return (
		typeof record.dbName === 'string' &&
		(record.backend === 'opfs' || record.backend === 'indexeddb')
	)
}

/** Read the manifest entry for a database, or null when Kora never recorded it. */
export async function readManifestRecord(dbName: string): Promise<LocalDatabaseRecord | null> {
	if (!isManifestAvailable()) return null
	const value = await withStore<unknown>('readonly', (store) => store.get(dbName))
	return isRecord(value) ? value : null
}

/** Every database Kora recorded on this origin, sorted by name. */
export async function listManifestRecords(): Promise<LocalDatabaseRecord[]> {
	if (!isManifestAvailable()) return []
	const values = await withStore<unknown[]>('readonly', (store) => store.getAll())
	return (values ?? []).filter(isRecord).sort((a, b) => (a.dbName < b.dbName ? -1 : 1))
}

/**
 * Record (or refresh) which backend holds a database after a durable open,
 * keeping the original creation time.
 */
export async function recordDatabase(entry: {
	dbName: string
	backend: LocalDatabaseBackend
	poolName?: string
}): Promise<void> {
	if (!isManifestAvailable()) return
	const existing = await readManifestRecord(entry.dbName)
	const now = Date.now()
	const record: LocalDatabaseRecord = {
		dbName: entry.dbName,
		backend: entry.backend,
		...(entry.poolName ? { poolName: entry.poolName } : {}),
		createdAt: existing?.createdAt ?? now,
		lastOpenedAt: now,
	}
	await withStore('readwrite', (store) => store.put(record))
}

/** Remove a database's manifest entry (after its data was deleted). */
export async function deleteManifestRecord(dbName: string): Promise<void> {
	if (!isManifestAvailable()) return
	await withStore('readwrite', (store) => store.delete(dbName))
}
