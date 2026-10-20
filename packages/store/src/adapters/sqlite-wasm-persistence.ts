/// <reference lib="dom" />
import { PersistenceError } from '../errors'

const IDB_DATABASE_NAME = 'kora-persistence'
const IDB_STORE_NAME = 'databases'
const IDB_VERSION = 1

const DUMP_SUFFIX = '::dump'
const VERSION_SUFFIX = '::version'
const EPOCH_SUFFIX = '::epoch'

/**
 * Identifies the database state a snapshot was taken from. `lineage` is one in-memory
 * worker database (a fresh one is created on every restore from IndexedDB), `epoch`
 * grows by one with each such restore, and `seq` counts the write transactions committed
 * in that worker database. Within one lineage a higher `seq` contains every write of a
 * lower one, so snapshots can be ordered no matter which tab saves them.
 */
export interface SnapshotVersion {
	epoch: number
	lineage: string
	seq: number
}

/** A full snapshot: the JSON dump, the binary image when the worker can export one. */
export interface SnapshotRecord<TDump = unknown> {
	dump: TDump
	/** Binary SQLite image taken at the same `version`, or null (browser workers). */
	data: Uint8Array | null
	version: SnapshotVersion
}

/**
 * What saving a snapshot over `stored` must do:
 * - `write`: the snapshot is newer (or nothing versioned is stored: first save, or a
 *   snapshot written before versions were recorded);
 * - `covered`: the stored snapshot is from the same worker database and at least as new,
 *   so it already holds every write this one holds;
 * - `superseded`: the stored snapshot comes from a later (or another) worker database;
 *   this one must never replace it.
 */
export function compareSnapshotVersions(
	stored: SnapshotVersion | null,
	incoming: SnapshotVersion,
): 'write' | 'covered' | 'superseded' {
	if (stored === null) return 'write'
	if (incoming.epoch > stored.epoch) return 'write'
	if (incoming.epoch < stored.epoch || incoming.lineage !== stored.lineage) return 'superseded'
	return incoming.seq > stored.seq ? 'write' : 'covered'
}

function asSnapshotVersion(value: unknown): SnapshotVersion | null {
	if (typeof value !== 'object' || value === null) return null
	const candidate = value as Record<string, unknown>
	if (
		typeof candidate.epoch !== 'number' ||
		!Number.isSafeInteger(candidate.epoch) ||
		typeof candidate.lineage !== 'string' ||
		typeof candidate.seq !== 'number' ||
		!Number.isSafeInteger(candidate.seq)
	) {
		return null
	}
	return { epoch: candidate.epoch, lineage: candidate.lineage, seq: candidate.seq }
}

function toUint8Array(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value
	if (value) return new Uint8Array(value as ArrayBuffer)
	return null
}

/**
 * Returns true when an IndexedDB error indicates storage quota was exceeded.
 */
export function isIndexedDbQuotaError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === 'QuotaExceededError') {
		return true
	}
	if (error instanceof PersistenceError && error.context?.quotaExceeded === true) {
		return true
	}
	if (error instanceof Error && /quota/i.test(error.message)) {
		return true
	}
	return false
}

function rejectWithIdbError(
	reject: (reason: unknown) => void,
	message: string,
	context: Record<string, unknown>,
	event: Event,
): void {
	const domError = (event.target as IDBRequest | IDBTransaction | undefined)?.error
	if (domError && isIndexedDbQuotaError(domError)) {
		reject(
			new PersistenceError(message, {
				...context,
				quotaExceeded: true,
				cause: domError.message,
			}),
		)
		return
	}
	reject(new PersistenceError(message, context))
}

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
			tx.onerror = (event) =>
				rejectWithIdbError(
					reject,
					`Failed to save database "${dbName}" to IndexedDB`,
					{ dbName },
					event,
				)
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
			tx.onerror = (event) =>
				rejectWithIdbError(
					reject,
					`Failed to save dump for database "${dbName}"`,
					{ dbName },
					event,
				)
		})
	} finally {
		idb.close()
	}
}

/**
 * Save a snapshot with compare-and-put: in ONE IndexedDB `readwrite` transaction, read the
 * stored snapshot's version and, only when this snapshot is newer
 * ({@link compareSnapshotVersions}), write the JSON dump, the binary image (or delete a
 * stale one) and the version together. An older snapshot never replaces a newer one, and
 * the binary image and the dump can never come from different versions.
 *
 * @returns `written`, or `covered` when the stored snapshot already holds this one's writes
 * @throws PersistenceError when the stored snapshot comes from a later worker database
 */
export async function saveSnapshotToIndexedDB(
	dbName: string,
	snapshot: SnapshotRecord,
): Promise<'written' | 'covered'> {
	const idb = await openIdb()
	try {
		return await new Promise<'written' | 'covered'>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			let outcome: 'written' | 'covered' = 'written'
			let refusal: PersistenceError | null = null
			const read = store.get(`${dbName}${VERSION_SUFFIX}`)
			read.onsuccess = () => {
				const stored = asSnapshotVersion(read.result)
				const decision = compareSnapshotVersions(stored, snapshot.version)
				if (decision === 'write') {
					store.put(snapshot.dump, `${dbName}${DUMP_SUFFIX}`)
					if (snapshot.data) {
						store.put(snapshot.data, dbName)
					} else {
						store.delete(dbName)
					}
					store.put(snapshot.version, `${dbName}${VERSION_SUFFIX}`)
					return
				}
				if (decision === 'covered') {
					outcome = 'covered'
					return
				}
				refusal = new PersistenceError(
					`Snapshot of database "${dbName}" was not saved: IndexedDB holds a snapshot of a newer copy of the database (another tab restored it), and an older snapshot must never replace it`,
					{ dbName, code: 'SNAPSHOT_SUPERSEDED', stored, attempted: snapshot.version },
				)
			}
			tx.oncomplete = () => {
				if (refusal) reject(refusal)
				else resolve(outcome)
			}
			tx.onerror = (event) =>
				rejectWithIdbError(
					reject,
					`Failed to save snapshot of database "${dbName}" to IndexedDB`,
					{ dbName },
					event,
				)
		})
	} finally {
		idb.close()
	}
}

/**
 * Claim the epoch of a new snapshot lineage (a worker database about to receive this
 * database's data). Epochs are handed out by one counter in IndexedDB, read and advanced in
 * one `readwrite` transaction, so every lineage gets a distinct epoch, higher than every
 * epoch claimed or stored before it: a lineage started later always outranks an earlier
 * one, even when the earlier one never saved a snapshot.
 */
export async function claimSnapshotEpoch(dbName: string): Promise<number> {
	const idb = await openIdb()
	try {
		return await new Promise<number>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			let claimed = 0
			const counter = store.get(`${dbName}${EPOCH_SUFFIX}`)
			const version = store.get(`${dbName}${VERSION_SUFFIX}`)
			version.onsuccess = () => {
				const last = typeof counter.result === 'number' ? counter.result : 0
				claimed = Math.max(last, asSnapshotVersion(version.result)?.epoch ?? 0) + 1
				store.put(claimed, `${dbName}${EPOCH_SUFFIX}`)
			}
			tx.oncomplete = () => resolve(claimed)
			tx.onerror = (event) =>
				rejectWithIdbError(
					reject,
					`Failed to claim a snapshot epoch for database "${dbName}"`,
					{ dbName },
					event,
				)
		})
	} finally {
		idb.close()
	}
}

/**
 * Load the stored snapshot (binary image, JSON dump and version) in one IndexedDB
 * transaction. `version` is null for snapshots written before versions were recorded.
 */
export async function loadSnapshotFromIndexedDB<TDump>(dbName: string): Promise<{
	data: Uint8Array | null
	dump: TDump | null
	version: SnapshotVersion | null
}> {
	const idb = await openIdb()
	try {
		return await new Promise((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readonly')
			const store = tx.objectStore(IDB_STORE_NAME)
			const data = store.get(dbName)
			const dump = store.get(`${dbName}${DUMP_SUFFIX}`)
			const version = store.get(`${dbName}${VERSION_SUFFIX}`)
			tx.oncomplete = () =>
				resolve({
					data: toUint8Array(data.result),
					dump: (dump.result as TDump | undefined) ?? null,
					version: asSnapshotVersion(version.result),
				})
			tx.onerror = () =>
				reject(
					new PersistenceError(`Failed to load snapshot of database "${dbName}" from IndexedDB`, {
						dbName,
					}),
				)
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
 * Delete only the binary SQLite database snapshot from IndexedDB.
 *
 * The logical dump is stored under a separate key and may be the authoritative
 * durable fallback when a browser worker cannot export a binary SQLite image.
 */
export async function deleteSnapshotFromIndexedDB(dbName: string): Promise<void> {
	const idb = await openIdb()
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			store.delete(dbName)
			tx.oncomplete = () => resolve()
			tx.onerror = () =>
				reject(
					new PersistenceError(`Failed to delete database snapshot "${dbName}" from IndexedDB`, {
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
			store.delete(`${dbName}${VERSION_SUFFIX}`)
			store.delete(`${dbName}${EPOCH_SUFFIX}`)
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
