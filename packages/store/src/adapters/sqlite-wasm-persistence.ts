/// <reference lib="dom" />
import { PersistenceError } from '../errors'

const IDB_DATABASE_NAME = 'kora-persistence'
const IDB_STORE_NAME = 'databases'
const IDB_VERSION = 1

const DUMP_SUFFIX = '::dump'

/**
 * Open the IndexedDB database used for SQLite persistence.
 * Creates the object store on first access.
 */
function openIdb(): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(IDB_DATABASE_NAME, IDB_VERSION)
		request.onupgradeneeded = () => {
			const db = request.result
			if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
				db.createObjectStore(IDB_STORE_NAME)
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () =>
			reject(
				new PersistenceError(
					`Failed to open IndexedDB: ${request.error?.message ?? 'unknown error'}`,
					{ database: IDB_DATABASE_NAME },
				),
			)
	})
}

/**
 * Save a serialized SQLite database to IndexedDB.
 *
 * @param dbName - Key under which to store the data
 * @param data - Serialized database as Uint8Array
 */
export async function saveToIndexedDB(dbName: string, data: Uint8Array): Promise<void> {
	const idb = await openIdb()
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			store.put(data, dbName)
			tx.oncomplete = () => resolve()
			tx.onerror = () =>
				reject(new PersistenceError(`Failed to save database "${dbName}" to IndexedDB`, { dbName }))
		})
	} finally {
		idb.close()
	}
}

/**
 * Save a logical SQL dump payload to IndexedDB for import-fallback restore.
 */
export async function saveDumpToIndexedDB(dbName: string, dump: unknown): Promise<void> {
	const idb = await openIdb()
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			store.put(dump, `${dbName}${DUMP_SUFFIX}`)
			tx.oncomplete = () => resolve()
			tx.onerror = () =>
				reject(new PersistenceError(`Failed to save dump for database "${dbName}"`, { dbName }))
		})
	} finally {
		idb.close()
	}
}

/**
 * Load a serialized SQLite database from IndexedDB.
 *
 * @param dbName - Key under which the data was stored
 * @returns The serialized database, or null if not found
 */
export async function loadFromIndexedDB(dbName: string): Promise<Uint8Array | null> {
	const idb = await openIdb()
	try {
		return await new Promise<Uint8Array | null>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readonly')
			const store = tx.objectStore(IDB_STORE_NAME)
			const request = store.get(dbName)
			request.onsuccess = () => {
				const result = request.result
				if (result instanceof Uint8Array) {
					resolve(result)
				} else if (result) {
					// Handle ArrayBuffer or other typed array forms
					resolve(new Uint8Array(result as ArrayBuffer))
				} else {
					resolve(null)
				}
			}
			request.onerror = () =>
				reject(
					new PersistenceError(`Failed to load database "${dbName}" from IndexedDB`, { dbName }),
				)
		})
	} finally {
		idb.close()
	}
}

/**
 * Load a logical SQL dump payload from IndexedDB.
 */
export async function loadDumpFromIndexedDB<T>(dbName: string): Promise<T | null> {
	const idb = await openIdb()
	try {
		return await new Promise<T | null>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readonly')
			const store = tx.objectStore(IDB_STORE_NAME)
			const request = store.get(`${dbName}${DUMP_SUFFIX}`)
			request.onsuccess = () => {
				resolve((request.result as T | undefined) ?? null)
			}
			request.onerror = () =>
				reject(
					new PersistenceError(`Failed to load dump for database "${dbName}" from IndexedDB`, {
						dbName,
					}),
				)
		})
	} finally {
		idb.close()
	}
}

/**
 * Delete a serialized SQLite database from IndexedDB.
 *
 * @param dbName - Key to delete
 */
export async function deleteFromIndexedDB(dbName: string): Promise<void> {
	const idb = await openIdb()
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			store.delete(dbName)
			store.delete(`${dbName}${DUMP_SUFFIX}`)
			tx.oncomplete = () => resolve()
			tx.onerror = () =>
				reject(
					new PersistenceError(`Failed to delete database "${dbName}" from IndexedDB`, { dbName }),
				)
		})
	} finally {
		idb.close()
	}
}
