/// <reference lib="dom" />
import { PersistenceError } from '../errors'

const IDB_DATABASE_NAME = 'kora-persistence'
const IDB_STORE_NAME = 'databases'
const IDB_VERSION = 1

const DUMP_SUFFIX = '::dump'
const VERSION_SUFFIX = '::version'
const EPOCH_SUFFIX = '::epoch'
const PINS_SUFFIX = '::pins'

/**
 * Identifies the database state a snapshot was taken from. `lineage` is one in-memory
 * worker database (a fresh one is created on every restore from IndexedDB), `epoch` is
 * claimed for it when it starts ({@link startSnapshotLineage}), and `seq` counts the write
 * transactions committed in that worker database. Within one lineage a higher `seq`
 * contains every write of a lower one, so snapshots can be ordered no matter which tab
 * saves them. A stored `seq` of -1 is a fence: the lineage started, nothing saved yet.
 */
export interface SnapshotVersion {
	epoch: number
	lineage: string
	seq: number
}

/**
 * A worker database a lineage descends from, and the commit count of the snapshot it
 * restored from (every write of that lineage up to `seq` is in the descendant). -1: that
 * lineage never saved a snapshot.
 */
export interface SnapshotAncestor {
	lineage: string
	seq: number
}

/**
 * How many of the most recent ancestors a stored version always keeps. An older ancestor
 * is kept only while it is pinned ({@link setSnapshotLineagePins}): a tab still holding
 * unsaved writes in it needs it to tell whether another tab saved them. Without the pin
 * it is dropped, since no tab can ask about it any more.
 */
const MAX_ANCESTORS = 32

/** The result of {@link saveSnapshotToIndexedDB}. */
export interface SnapshotSaveResult {
	/** `written`, or `covered` when the stored snapshot already held this one's writes. */
	outcome: 'written' | 'covered'
	/** Lineages the stored snapshot descends from (newest first). */
	ancestors: SnapshotAncestor[]
}

/** A full snapshot: the JSON dump, the binary image when the worker can export one. */
export interface SnapshotRecord<TDump = unknown> {
	dump: TDump
	/** Binary SQLite image taken at the same `version`, or null (browser workers). */
	data: Uint8Array | null
	version: SnapshotVersion
}

/** `context.code` of the {@link PersistenceError} a refused snapshot save rejects with. */
export const SNAPSHOT_SUPERSEDED = 'SNAPSHOT_SUPERSEDED'

/**
 * What saving a snapshot over `stored` must do:
 * - `write`: the snapshot is from the same worker database and newer, or from a database
 *   that started later (higher epoch);
 * - `covered`: the stored snapshot is from the same worker database and at least as new,
 *   so it already holds every write this one holds;
 * - `superseded`: the stored snapshot comes from a database that started later, or no
 *   version is stored at all. Every lineage writes a fence version before its first save
 *   ({@link startSnapshotLineage}), so a missing version means the database was deleted
 *   after this snapshot's lineage started: saving it would bring deleted data back.
 */
export function compareSnapshotVersions(
	stored: SnapshotVersion | null,
	incoming: SnapshotVersion,
): 'write' | 'covered' | 'superseded' {
	if (stored === null) return 'superseded'
	if (incoming.lineage === stored.lineage) {
		return incoming.seq > stored.seq ? 'write' : 'covered'
	}
	return incoming.epoch > stored.epoch ? 'write' : 'superseded'
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

function asAncestors(value: unknown): SnapshotAncestor[] {
	if (typeof value !== 'object' || value === null) return []
	const list = (value as Record<string, unknown>).ancestors
	if (!Array.isArray(list)) return []
	const ancestors: SnapshotAncestor[] = []
	for (const entry of list) {
		if (typeof entry !== 'object' || entry === null) continue
		const candidate = entry as Record<string, unknown>
		if (typeof candidate.lineage === 'string' && Number.isSafeInteger(candidate.seq)) {
			ancestors.push({ lineage: candidate.lineage, seq: candidate.seq as number })
		}
	}
	return ancestors
}

/**
 * `stored` and its ancestors, as the ancestors of a lineage that replaces it: the
 * {@link MAX_ANCESTORS} most recent, and every older one still `pinned`.
 */
function descendFrom(
	stored: SnapshotVersion | null,
	ancestors: SnapshotAncestor[],
	pinned: ReadonlySet<string>,
): SnapshotAncestor[] {
	const all = stored ? [{ lineage: stored.lineage, seq: stored.seq }, ...ancestors] : ancestors
	return all.filter((entry, index) => index < MAX_ANCESTORS || pinned.has(entry.lineage))
}

/**
 * Pins per holder (one adapter): the lineages it still has unsaved writes in, least
 * recently updated holder first.
 */
type LineagePins = Record<string, string[]>

/**
 * How many holders' pins are kept. A tab that crashed with unsaved writes never removes
 * its pins; beyond this many holders the least recently updated are dropped, so the
 * pinned ancestry stays bounded. A live holder re-pins on every change of its lineages.
 */
const MAX_PIN_HOLDERS = 64

function asPins(value: unknown): LineagePins {
	if (typeof value !== 'object' || value === null) return {}
	const pins: LineagePins = {}
	for (const [holder, lineages] of Object.entries(value as Record<string, unknown>)) {
		if (Array.isArray(lineages)) {
			pins[holder] = lineages.filter((lineage): lineage is string => typeof lineage === 'string')
		}
	}
	return pins
}

function pinnedLineages(value: unknown): Set<string> {
	return new Set(Object.values(asPins(value)).flat())
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

/**
 * Settle `tx`: resolve on `complete`, reject with a {@link PersistenceError} on `error`
 * or `abort`. A commit can fail with no request error (a quota failure while writing the
 * data to disk aborts the transaction and fires only `abort`); without the `abort`
 * handler the promise would never settle and every later flush would wait on it.
 */
function settleTransaction(
	tx: IDBTransaction,
	resolve: () => void,
	reject: (reason: unknown) => void,
	message: string,
	context: Record<string, unknown>,
): void {
	let settled = false
	const fail = (event: Event): void => {
		if (settled) return
		settled = true
		const error = (event.target as IDBRequest | IDBTransaction | undefined)?.error ?? tx.error
		if (error && isIndexedDbQuotaError(error)) {
			reject(
				new PersistenceError(message, { ...context, quotaExceeded: true, cause: error.message }),
			)
			return
		}
		reject(
			new PersistenceError(message, {
				...context,
				...(error ? { cause: error.message } : { cause: 'transaction aborted' }),
			}),
		)
	}
	tx.oncomplete = () => {
		if (settled) return
		settled = true
		resolve()
	}
	tx.onerror = fail
	tx.onabort = fail
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
			settleTransaction(tx, resolve, reject, `Failed to save database "${dbName}" to IndexedDB`, {
				dbName,
			})
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
			settleTransaction(tx, resolve, reject, `Failed to save dump for database "${dbName}"`, {
				dbName,
			})
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
 * @returns whether it was written or already covered, and the stored snapshot's ancestors
 * @throws PersistenceError when the stored snapshot comes from a later worker database
 */
export async function saveSnapshotToIndexedDB(
	dbName: string,
	snapshot: SnapshotRecord,
): Promise<SnapshotSaveResult> {
	const idb = await openIdb()
	try {
		return await new Promise<SnapshotSaveResult>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			let outcome: 'written' | 'covered' = 'written'
			let ancestors: SnapshotAncestor[] = []
			let refusal: PersistenceError | null = null
			settleTransaction(
				tx,
				() => {
					if (refusal) reject(refusal)
					else resolve({ outcome, ancestors })
				},
				reject,
				`Failed to save snapshot of database "${dbName}" to IndexedDB`,
				{ dbName },
			)
			const pins = store.get(`${dbName}${PINS_SUFFIX}`)
			const read = store.get(`${dbName}${VERSION_SUFFIX}`)
			read.onsuccess = () => {
				const stored = asSnapshotVersion(read.result)
				const storedAncestors = asAncestors(read.result)
				const decision = compareSnapshotVersions(stored, snapshot.version)
				ancestors =
					stored && stored.lineage !== snapshot.version.lineage
						? descendFrom(stored, storedAncestors, pinnedLineages(pins.result))
						: storedAncestors
				if (decision === 'write') {
					store.put(snapshot.dump, `${dbName}${DUMP_SUFFIX}`)
					if (snapshot.data) {
						store.put(snapshot.data, dbName)
					} else {
						store.delete(dbName)
					}
					store.put(
						{
							epoch: snapshot.version.epoch,
							lineage: snapshot.version.lineage,
							seq: snapshot.version.seq,
							ancestors,
						},
						`${dbName}${VERSION_SUFFIX}`,
					)
					return
				}
				if (decision === 'covered') {
					outcome = 'covered'
					return
				}
				refusal = new PersistenceError(
					stored === null
						? `Snapshot of database "${dbName}" was not saved: the database was deleted from IndexedDB after this copy of it was opened`
						: `Snapshot of database "${dbName}" was not saved: IndexedDB holds a newer copy of the database (another tab restored it), and an older copy must never replace it. Writes made only in this copy are lost.`,
					{
						dbName,
						code: SNAPSHOT_SUPERSEDED,
						stored,
						storedAncestors,
						attempted: snapshot.version,
					},
				)
			}
		})
	} finally {
		idb.close()
	}
}

/** The stored snapshot a new lineage starts from, and the epoch claimed for it. */
export interface StartedSnapshotLineage<TDump> {
	epoch: number
	data: Uint8Array | null
	dump: TDump | null
}

/**
 * Start a snapshot lineage (a worker database about to receive this database's data), in
 * ONE IndexedDB `readwrite` transaction: claim an epoch from the database's epoch counter
 * (higher than every epoch claimed or stored before, so a lineage started later always
 * outranks an earlier one), read the stored snapshot the lineage restores from, and store
 * the fence version `{ epoch, lineage, seq: -1 }`. From then on a save from any older
 * lineage is refused ({@link SNAPSHOT_SUPERSEDED}) instead of being accepted and later
 * overwritten by this lineage's first save, which never saw it.
 *
 * `replace` is for a lineage whose data comes from elsewhere (the OPFS copy carried over):
 * its fence claims no ancestor, since it holds none of the stored snapshot's writes.
 *
 * When the stored version already belongs to `lineage` (a lineage started for a worker
 * database another tab is starting at the same time), it is left as is: the fence never
 * lowers a saved `seq`. Opening writes only these two small records, never a copy of the
 * data.
 */
export async function startSnapshotLineage<TDump>(
	dbName: string,
	lineage: string,
	mode: 'restore' | 'replace' = 'restore',
): Promise<StartedSnapshotLineage<TDump>> {
	const idb = await openIdb()
	try {
		return await new Promise<StartedSnapshotLineage<TDump>>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			let epoch = 0
			const counter = store.get(`${dbName}${EPOCH_SUFFIX}`)
			const data = store.get(dbName)
			const dump = store.get(`${dbName}${DUMP_SUFFIX}`)
			const pins = store.get(`${dbName}${PINS_SUFFIX}`)
			const version = store.get(`${dbName}${VERSION_SUFFIX}`)
			version.onsuccess = () => {
				const stored = asSnapshotVersion(version.result)
				if (stored?.lineage === lineage) {
					epoch = stored.epoch
					return
				}
				const last = typeof counter.result === 'number' ? counter.result : 0
				epoch = Math.max(last, stored?.epoch ?? 0) + 1
				store.put(epoch, `${dbName}${EPOCH_SUFFIX}`)
				// The fence. It records what this lineage restores from, so a tab whose writes
				// were in an ancestor (saved there by another tab) can tell they survived.
				const ancestors =
					mode === 'replace'
						? []
						: descendFrom(stored, asAncestors(version.result), pinnedLineages(pins.result))
				store.put({ epoch, lineage, seq: -1, ancestors }, `${dbName}${VERSION_SUFFIX}`)
			}
			settleTransaction(
				tx,
				() =>
					resolve({
						epoch,
						data: toUint8Array(data.result),
						dump: (dump.result as TDump | undefined) ?? null,
					}),
				reject,
				`Failed to start a snapshot lineage for database "${dbName}"`,
				{ dbName },
			)
		})
	} finally {
		idb.close()
	}
}

/**
 * Record the lineages `holder` (one adapter) still has unsaved writes in, replacing what it
 * recorded before (an empty list removes the holder). A pinned lineage stays in the
 * ancestry of every later lineage however many leader changes follow, so the holder can
 * still learn whether another tab saved its writes there before it was replaced.
 */
export async function setSnapshotLineagePins(
	dbName: string,
	holder: string,
	lineages: string[],
): Promise<void> {
	const idb = await openIdb()
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, 'readwrite')
			const store = tx.objectStore(IDB_STORE_NAME)
			const read = store.get(`${dbName}${PINS_SUFFIX}`)
			read.onsuccess = () => {
				const pins = asPins(read.result)
				// Re-inserted last: the most recently updated holder is dropped last.
				delete pins[holder]
				if (lineages.length > 0) pins[holder] = [...lineages]
				const holders = Object.keys(pins)
				for (const stale of holders.slice(0, Math.max(0, holders.length - MAX_PIN_HOLDERS))) {
					delete pins[stale]
				}
				if (Object.keys(pins).length > 0) store.put(pins, `${dbName}${PINS_SUFFIX}`)
				else store.delete(`${dbName}${PINS_SUFFIX}`)
			}
			settleTransaction(
				tx,
				resolve,
				reject,
				`Failed to record the unsaved snapshot lineages of database "${dbName}"`,
				{ dbName },
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
			settleTransaction(
				tx,
				() =>
					resolve({
						data: toUint8Array(data.result),
						dump: (dump.result as TDump | undefined) ?? null,
						version: asSnapshotVersion(version.result),
					}),
				reject,
				`Failed to load snapshot of database "${dbName}" from IndexedDB`,
				{ dbName },
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
			settleTransaction(
				tx,
				resolve,
				reject,
				`Failed to delete database snapshot "${dbName}" from IndexedDB`,
				{ dbName },
			)
		})
	} finally {
		idb.close()
	}
}

/**
 * Delete a serialized SQLite database from IndexedDB.
 *
 * The epoch counter is kept: a lineage started before the delete (a suspended tab that
 * resumes) must never outrank a database created after it, and with no stored version
 * its saves are refused ({@link compareSnapshotVersions}).
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
			store.delete(`${dbName}${PINS_SUFFIX}`)
			settleTransaction(
				tx,
				resolve,
				reject,
				`Failed to delete database "${dbName}" from IndexedDB`,
				{ dbName },
			)
		})
	} finally {
		idb.close()
	}
}
