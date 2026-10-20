/// <reference lib="dom" />
import { PersistenceError } from '../errors'

const IDB_DATABASE_NAME = 'kora-persistence'
const IDB_STORE_NAME = 'databases'
const IDB_VERSION = 1

/**
 * Legacy layout, written by every release before snapshot versions: the binary image at
 * `dbName` and the JSON dump at `dbName::dump`. A tab still running such a release writes
 * them unconditionally, so they are never trusted as the versioned snapshot. This release
 * keeps them as a mirror of its snapshot (stamped with its version, {@link LEGACY_DUMP_STAMP})
 * so an earlier release that restores from them gets the latest data.
 */
const DUMP_SUFFIX = '::dump'
/** Versioned layout: keys no earlier release reads or writes. */
const V2_DUMP_SUFFIX = '::v2::dump'
const V2_DATA_SUFFIX = '::v2::data'
const V2_VERSION_SUFFIX = '::v2::version'
/** A legacy copy kept aside because it diverged from the versioned snapshot. */
const PRESERVED_INFIX = '::v2::preserved::'
const EPOCH_SUFFIX = '::epoch'

/**
 * Property of the legacy-layout dump holding the version it mirrors. An earlier release
 * ignores it on restore and never writes it, so a legacy dump without it (or with another
 * version) was written by an earlier release after this one last mirrored its snapshot.
 */
export const LEGACY_DUMP_STAMP = 'koraSnapshotVersion'

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

/** How many ancestors a stored version keeps (older ones are dropped). */
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
 * `code` of the `store:persistence-error` reported when the legacy-layout copy (written by
 * a tab running an earlier release) and the versioned snapshot each hold operations the
 * other lacks. The versioned snapshot is restored; the legacy copy is kept aside, never
 * dropped ({@link loadPreservedSnapshotsFromIndexedDB}).
 */
export const SNAPSHOT_DIVERGED = 'SNAPSHOT_DIVERGED'

/**
 * Which stored copy a new lineage restores from, and why:
 * - `none`: nothing stored, or the legacy copy was deleted by an earlier release (its
 *   `deleteLocalDatabase`, or its move to OPFS) after this release mirrored to it;
 * - `v2`: the versioned snapshot. `legacy` says what the legacy copy was: `absent`, the
 *   `mirror` of this snapshot, `stale` (an earlier release wrote operations the snapshot
 *   already holds) or `diverged` (it held operations the snapshot lacks: kept aside);
 * - `legacy`: the legacy copy, either `migrated` (no versioned snapshot yet: the first open
 *   after the upgrade), `newer` (an earlier release wrote every operation of the versioned
 *   snapshot and more) or `recreated` (another database: an earlier release deleted this
 *   one and created it, so the versioned snapshot is of the deleted one and is kept aside).
 */
export type SnapshotReconciliation =
	| { source: 'none'; legacyDeleted: boolean }
	| { source: 'v2'; legacy: 'absent' | 'mirror' | 'stale' | 'diverged'; preservedKey?: string }
	| { source: 'legacy'; reason: 'migrated' | 'newer' | 'recreated'; preservedKey?: string }

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function asSnapshotVersion(value: unknown): SnapshotVersion | null {
	if (!isRecord(value)) return null
	if (
		typeof value.epoch !== 'number' ||
		!Number.isSafeInteger(value.epoch) ||
		typeof value.lineage !== 'string' ||
		typeof value.seq !== 'number' ||
		!Number.isSafeInteger(value.seq)
	) {
		return null
	}
	return { epoch: value.epoch, lineage: value.lineage, seq: value.seq }
}

function sameVersion(a: SnapshotVersion | null, b: SnapshotVersion | null): boolean {
	return (
		a !== null && b !== null && a.epoch === b.epoch && a.lineage === b.lineage && a.seq === b.seq
	)
}

function asAncestors(value: unknown): SnapshotAncestor[] {
	if (!isRecord(value)) return []
	const list = value.ancestors
	if (!Array.isArray(list)) return []
	const ancestors: SnapshotAncestor[] = []
	for (const entry of list) {
		if (!isRecord(entry)) continue
		if (typeof entry.lineage === 'string' && Number.isSafeInteger(entry.seq)) {
			ancestors.push({ lineage: entry.lineage, seq: entry.seq as number })
		}
	}
	return ancestors
}

/** The stored versioned-snapshot record: its version, ancestry and the version mirrored. */
interface VersionRecord {
	version: SnapshotVersion | null
	ancestors: SnapshotAncestor[]
	/** Version of the payload last mirrored to the legacy keys (that payload's version). */
	mirror: SnapshotVersion | null
}

function asVersionRecord(value: unknown): VersionRecord {
	return {
		version: asSnapshotVersion(value),
		ancestors: asAncestors(value),
		mirror: isRecord(value) ? asSnapshotVersion(value.mirror) : null,
	}
}

function versionRecord(
	version: SnapshotVersion,
	ancestors: SnapshotAncestor[],
	mirror: SnapshotVersion | null,
): Record<string, unknown> {
	return {
		epoch: version.epoch,
		lineage: version.lineage,
		seq: version.seq,
		ancestors,
		mirror,
	}
}

/** `stored` and its ancestors, as the ancestors of a lineage that restores from it. */
function descendFrom(
	stored: SnapshotVersion | null,
	ancestors: SnapshotAncestor[],
): SnapshotAncestor[] {
	if (!stored) return ancestors.slice(0, MAX_ANCESTORS)
	return [{ lineage: stored.lineage, seq: stored.seq }, ...ancestors].slice(0, MAX_ANCESTORS)
}

function toUint8Array(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value
	if (value) return new Uint8Array(value as ArrayBuffer)
	return null
}

/** The legacy-layout dump for `dump`, stamped as the mirror of `version`. */
function stampedDump(dump: unknown, version: SnapshotVersion): unknown {
	if (!isRecord(dump)) return dump
	return { ...dump, [LEGACY_DUMP_STAMP]: { ...version } }
}

/**
 * Every operation id in a dump's operation-log tables (`_kora_ops_<collection>`), or null
 * when the dump cannot be read as one. Records are a fold over these operations, so a copy
 * whose operations include another's holds every write of it.
 */
function operationIds(dump: unknown): Set<string> | null {
	if (!isRecord(dump) || !Array.isArray(dump.tables)) return null
	const ids = new Set<string>()
	for (const table of dump.tables) {
		if (!isRecord(table) || typeof table.name !== 'string') return null
		if (!table.name.startsWith('_kora_ops_')) continue
		if (!Array.isArray(table.rows)) return null
		for (const row of table.rows) {
			if (!isRecord(row) || typeof row.id !== 'string') return null
			ids.add(`${table.name}\u0000${row.id}`)
		}
	}
	return ids
}

/** The store's node id recorded in a dump (`_kora_meta`), or null. */
function nodeIdOf(dump: unknown): string | null {
	if (!isRecord(dump) || !Array.isArray(dump.tables)) return null
	for (const table of dump.tables) {
		if (!isRecord(table) || table.name !== '_kora_meta' || !Array.isArray(table.rows)) continue
		for (const row of table.rows) {
			if (isRecord(row) && row.key === 'node_id' && typeof row.value === 'string') return row.value
		}
	}
	return null
}

function isSubset(small: Set<string>, large: Set<string>): boolean {
	if (small.size > large.size) return false
	for (const id of small) if (!large.has(id)) return false
	return true
}

/** Everything stored for one database, read in one IndexedDB transaction. */
interface StoredCopies {
	record: VersionRecord
	v2Dump: unknown | null
	v2Data: Uint8Array | null
	legacyDump: unknown | null
	legacyData: Uint8Array | null
}

/**
 * Decide which stored copy holds the database ({@link SnapshotReconciliation}). Only what
 * can be proven decides: the legacy copy is the untouched mirror when it carries the
 * mirrored version, a legacy copy of another database (node id) was created after this one
 * was deleted, and otherwise the copies are compared by their operation ids. When neither
 * holds every operation of the other, the versioned snapshot is chosen (it is the copy
 * `ensureDurable()` vouched for) and the caller keeps the legacy copy aside.
 */
function reconcile(copies: StoredCopies): SnapshotReconciliation {
	const v2Has = copies.v2Dump !== null || copies.v2Data !== null
	const legacyHas = copies.legacyDump !== null || copies.legacyData !== null
	if (!legacyHas) {
		if (!v2Has) return { source: 'none', legacyDeleted: false }
		// Every save mirrors to the legacy keys, and only an earlier release deletes them
		// without the versioned ones: the database was deleted (or moved to OPFS) there.
		if (copies.record.mirror !== null) return { source: 'none', legacyDeleted: true }
		return { source: 'v2', legacy: 'absent' }
	}
	if (!v2Has) return { source: 'legacy', reason: 'migrated' }
	const stamp = isRecord(copies.legacyDump)
		? asSnapshotVersion(copies.legacyDump[LEGACY_DUMP_STAMP])
		: null
	if (sameVersion(stamp, copies.record.mirror)) return { source: 'v2', legacy: 'mirror' }
	// Different node ids: two databases, not two versions of one. Every save of this
	// release mirrors to the legacy keys and a restore of either copy keeps its node id, so
	// an unstamped legacy copy of another database was created by an earlier release after
	// it deleted this one (its delete removes only the legacy keys).
	const v2Node = nodeIdOf(copies.v2Dump)
	const legacyNode = nodeIdOf(copies.legacyDump)
	if (v2Node !== null && legacyNode !== null && v2Node !== legacyNode) {
		return { source: 'legacy', reason: 'recreated' }
	}
	const v2Ops = operationIds(copies.v2Dump)
	const legacyOps = operationIds(copies.legacyDump)
	if (v2Ops && legacyOps) {
		if (isSubset(legacyOps, v2Ops)) return { source: 'v2', legacy: 'stale' }
		if (isSubset(v2Ops, legacyOps)) return { source: 'legacy', reason: 'newer' }
	}
	return { source: 'v2', legacy: 'diverged' }
}

/** The payload a reconciliation restores: dump and binary image (null when none). */
function chosenPayload<TDump>(
	copies: StoredCopies,
	reconciliation: SnapshotReconciliation,
): { dump: TDump | null; data: Uint8Array | null } {
	if (reconciliation.source === 'v2') {
		return { dump: (copies.v2Dump as TDump | null) ?? null, data: copies.v2Data }
	}
	if (reconciliation.source === 'legacy') {
		// On the first open after the upgrade the image is preferred, as earlier releases
		// restore it. Otherwise only the dump was compared (an earlier release writes the image
		// in a separate transaction, so it may not match), and the dump restores fully.
		const dump = (copies.legacyDump as TDump | null) ?? null
		const useImage = reconciliation.reason === 'migrated' || dump === null
		return { dump, data: useImage ? copies.legacyData : null }
	}
	return { dump: null, data: null }
}

/** Issue the reads of every stored copy on `store`; values are read once `last` succeeds. */
function readCopies(
	store: IDBObjectStore,
	dbName: string,
): { last: IDBRequest; copies: () => StoredCopies } {
	const v2Dump = store.get(`${dbName}${V2_DUMP_SUFFIX}`)
	const v2Data = store.get(`${dbName}${V2_DATA_SUFFIX}`)
	const legacyDump = store.get(`${dbName}${DUMP_SUFFIX}`)
	const legacyData = store.get(dbName)
	// Requests on one store complete in order: the version is read last.
	const version = store.get(`${dbName}${V2_VERSION_SUFFIX}`)
	return {
		last: version,
		copies: () => ({
			record: asVersionRecord(version.result),
			v2Dump: v2Dump.result ?? null,
			v2Data: toUint8Array(v2Data.result),
			legacyDump: legacyDump.result ?? null,
			legacyData: toUint8Array(legacyData.result),
		}),
	}
}

/** Put the legacy-layout mirror of a payload (`data` null deletes a stale image). */
function putMirror(
	store: IDBObjectStore,
	dbName: string,
	dump: unknown,
	data: Uint8Array | null,
	version: SnapshotVersion,
): void {
	store.put(stampedDump(dump, version), `${dbName}${DUMP_SUFFIX}`)
	if (data) store.put(data, dbName)
	else store.delete(dbName)
}

/**
 * After a reconciliation that restores the versioned snapshot over a legacy copy an earlier
 * release wrote (`stale` or `diverged`): keep a diverged copy aside, then mirror the
 * versioned snapshot to the legacy keys (stamped `mirror`), so a tab running an earlier
 * release restores it too, and the next reconciliation finds the mirror (a diverged copy is
 * kept aside once). Returns the reconciliation with the key it was kept under.
 */
function settleLegacyCopy(
	store: IDBObjectStore,
	dbName: string,
	copies: StoredCopies,
	reconciliation: SnapshotReconciliation,
	mirror: SnapshotVersion,
): SnapshotReconciliation {
	if (reconciliation.source === 'legacy' && reconciliation.reason === 'recreated') {
		// The deleted database's versioned copy is kept aside (never dropped silently) and
		// removed from the versioned keys, so the next reconciliation does not see it again.
		const preservedKey = preserveCopy(store, dbName, copies.v2Dump, copies.v2Data, copies)
		store.delete(`${dbName}${V2_DUMP_SUFFIX}`)
		store.delete(`${dbName}${V2_DATA_SUFFIX}`)
		return { ...reconciliation, preservedKey }
	}
	if (
		reconciliation.source !== 'v2' ||
		(reconciliation.legacy !== 'stale' && reconciliation.legacy !== 'diverged')
	) {
		return reconciliation
	}
	const settled =
		reconciliation.legacy === 'diverged'
			? {
					...reconciliation,
					preservedKey: preserveCopy(store, dbName, copies.legacyDump, copies.legacyData, copies),
				}
			: reconciliation
	putMirror(store, dbName, copies.v2Dump, copies.v2Data, mirror)
	return settled
}

/** Keep a copy aside under a key nothing else writes; returns that key. */
function preserveCopy(
	store: IDBObjectStore,
	dbName: string,
	dump: unknown,
	data: Uint8Array | null,
	copies: StoredCopies,
): string {
	const key = `${dbName}${PRESERVED_INFIX}${randomId()}`
	store.put({ dump, data, versionAtPreservation: copies.record.version }, key)
	return key
}

function randomId(): string {
	const bytes = new Uint8Array(8)
	globalThis.crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
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

/** Run `body` in one IndexedDB transaction on the persistence store. */
async function inIdbTransaction<T>(
	mode: IDBTransactionMode,
	message: string,
	context: Record<string, unknown>,
	body: (store: IDBObjectStore, settle: (result: () => T) => void) => void,
): Promise<T> {
	const idb = await openIdb()
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = idb.transaction(IDB_STORE_NAME, mode)
			let result: (() => T) | null = null
			settleTransaction(
				tx,
				() => {
					try {
						resolve((result as () => T)())
					} catch (error) {
						reject(error)
					}
				},
				reject,
				message,
				context,
			)
			body(tx.objectStore(IDB_STORE_NAME), (fn) => {
				result = fn
			})
		})
	} finally {
		idb.close()
	}
}

/**
 * Save a serialized SQLite database to IndexedDB, in the legacy layout (the key earlier
 * releases restore the binary image from).
 *
 * @param dbName - Key under which to store the data
 * @param data - Serialized database as Uint8Array
 */
export async function saveToIndexedDB(dbName: string, data: Uint8Array): Promise<void> {
	await inIdbTransaction<void>(
		'readwrite',
		`Failed to save database "${dbName}" to IndexedDB`,
		{ dbName },
		(store, settle) => {
			store.put(data, dbName)
			settle(() => undefined)
		},
	)
}

/**
 * Save a logical SQL dump payload to IndexedDB, in the legacy layout (the key earlier
 * releases restore the JSON dump from).
 */
export async function saveDumpToIndexedDB(dbName: string, dump: unknown): Promise<void> {
	await inIdbTransaction<void>(
		'readwrite',
		`Failed to save dump for database "${dbName}"`,
		{ dbName },
		(store, settle) => {
			store.put(dump, `${dbName}${DUMP_SUFFIX}`)
			settle(() => undefined)
		},
	)
}

/**
 * Save a snapshot of a worker database that has no snapshot version (an earlier release
 * opened it and still leads) in the legacy layout only, in one transaction: the dump, and
 * the binary image or the deletion of a stale one, as that release does. It is unstamped,
 * so the next lineage to start compares it with the versioned snapshot by operations
 * ({@link startSnapshotLineage}).
 */
export async function saveLegacySnapshotToIndexedDB(
	dbName: string,
	dump: unknown,
	data: Uint8Array | null,
): Promise<{ stored: SnapshotVersion | null; ancestors: SnapshotAncestor[] }> {
	return inIdbTransaction<{ stored: SnapshotVersion | null; ancestors: SnapshotAncestor[] }>(
		'readwrite',
		`Failed to save snapshot of database "${dbName}" to IndexedDB`,
		{ dbName },
		(store, settle) => {
			store.put(dump, `${dbName}${DUMP_SUFFIX}`)
			if (data) store.put(data, dbName)
			else store.delete(dbName)
			const read = store.get(`${dbName}${V2_VERSION_SUFFIX}`)
			read.onsuccess = () => {
				const record = asVersionRecord(read.result)
				settle(() => ({ stored: record.version, ancestors: record.ancestors }))
			}
		},
	)
}

/**
 * Save a snapshot with compare-and-put: in ONE IndexedDB `readwrite` transaction, read the
 * stored snapshot's version and, only when this snapshot is newer
 * ({@link compareSnapshotVersions}), write the JSON dump, the binary image (or delete a
 * stale one) and the version together, under keys no earlier release writes. An older
 * snapshot never replaces a newer one, the binary image and the dump can never come from
 * different versions, and a save by a tab still running an earlier release (which writes
 * only the legacy keys) can never replace them. The same transaction mirrors the snapshot
 * to the legacy keys, stamped with its version, for a tab running an earlier release.
 *
 * @returns whether it was written or already covered, and the stored snapshot's ancestors
 * @throws PersistenceError when the stored snapshot comes from a later worker database
 */
export async function saveSnapshotToIndexedDB(
	dbName: string,
	snapshot: SnapshotRecord,
): Promise<SnapshotSaveResult> {
	return inIdbTransaction<SnapshotSaveResult>(
		'readwrite',
		`Failed to save snapshot of database "${dbName}" to IndexedDB`,
		{ dbName },
		(store, settle) => {
			const legacy = store.get(`${dbName}${DUMP_SUFFIX}`)
			const read = store.get(`${dbName}${V2_VERSION_SUFFIX}`)
			read.onsuccess = () => {
				const record = asVersionRecord(read.result)
				const { version: stored, ancestors: storedAncestors } = record
				let decision = compareSnapshotVersions(stored, snapshot.version)
				const legacyDump: unknown = legacy.result ?? null
				let deleted = stored === null
				if (decision === 'write' && legacyDump === null && record.mirror !== null) {
					// Every save mirrors to the legacy keys and only an earlier release deletes them
					// alone (its deleteLocalDatabase, or its move to OPFS): the database was deleted
					// after this lineage started. Finish the delete; never bring it back.
					store.delete(`${dbName}${V2_DUMP_SUFFIX}`)
					store.delete(`${dbName}${V2_DATA_SUFFIX}`)
					store.delete(`${dbName}${V2_VERSION_SUFFIX}`)
					decision = 'superseded'
					deleted = true
				}
				const ancestors =
					stored && stored.lineage !== snapshot.version.lineage
						? descendFrom(stored, storedAncestors)
						: storedAncestors
				if (decision === 'write') {
					store.put(snapshot.dump, `${dbName}${V2_DUMP_SUFFIX}`)
					if (snapshot.data) store.put(snapshot.data, `${dbName}${V2_DATA_SUFFIX}`)
					else store.delete(`${dbName}${V2_DATA_SUFFIX}`)
					// The legacy keys get this snapshot's mirror only when they hold nothing it
					// lacks: the previous mirror, or a copy an earlier release wrote whose operations
					// this snapshot holds. Otherwise they are left as they are (and stay unstamped),
					// so the next lineage to start compares the two copies and keeps both.
					const stamp = isRecord(legacyDump)
						? asSnapshotVersion(legacyDump[LEGACY_DUMP_STAMP])
						: null
					let mirror: SnapshotVersion | null = snapshot.version
					if (legacyDump !== null && !sameVersion(stamp, record.mirror)) {
						const legacyOps = operationIds(legacyDump)
						const ownOps = operationIds(snapshot.dump)
						if (!legacyOps || !ownOps || !isSubset(legacyOps, ownOps)) mirror = record.mirror
					}
					store.put(
						versionRecord(snapshot.version, ancestors, mirror),
						`${dbName}${V2_VERSION_SUFFIX}`,
					)
					if (mirror === snapshot.version) {
						putMirror(store, dbName, snapshot.dump, snapshot.data, snapshot.version)
					}
					settle(() => ({ outcome: 'written', ancestors }))
					return
				}
				if (decision === 'covered') {
					settle(() => ({ outcome: 'covered', ancestors }))
					return
				}
				const refusal = new PersistenceError(
					deleted
						? `Snapshot of database "${dbName}" was not saved: the database was deleted from IndexedDB after this copy of it was opened`
						: `Snapshot of database "${dbName}" was not saved: IndexedDB holds a newer copy of the database (another tab restored it), and an older copy must never replace it. Writes made only in this copy are lost.`,
					{
						dbName,
						code: SNAPSHOT_SUPERSEDED,
						stored: deleted ? null : stored,
						storedAncestors: deleted ? [] : storedAncestors,
						attempted: snapshot.version,
					},
				)
				settle(() => {
					throw refusal
				})
			}
		},
	)
}

/** The stored snapshot a new lineage starts from, and the epoch claimed for it. */
export interface StartedSnapshotLineage<TDump> {
	epoch: number
	data: Uint8Array | null
	dump: TDump | null
	/** Which stored copy `data`/`dump` come from (`replace` lineages: `none`). */
	reconciliation: SnapshotReconciliation
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
 * `restore` (the default) reconciles the versioned snapshot with the legacy-layout copy
 * ({@link SnapshotReconciliation}) and returns the payload to restore; the fence records
 * the versioned snapshot as an ancestor only when that payload holds it. `replace` is for
 * a lineage whose data comes from elsewhere (the OPFS copy): nothing is read or restored,
 * and it claims no ancestor, since it holds none of the stored snapshot's writes.
 *
 * When the stored version already belongs to `lineage`, it is left as is: the fence never
 * lowers a saved `seq`.
 */
export async function startSnapshotLineage<TDump>(
	dbName: string,
	lineage: string,
	mode: 'restore' | 'replace' = 'restore',
): Promise<StartedSnapshotLineage<TDump>> {
	return inIdbTransaction<StartedSnapshotLineage<TDump>>(
		'readwrite',
		`Failed to start a snapshot lineage for database "${dbName}"`,
		{ dbName },
		(store, settle) => {
			const counter = store.get(`${dbName}${EPOCH_SUFFIX}`)
			const reads =
				mode === 'restore'
					? readCopies(store, dbName)
					: (() => {
							const version = store.get(`${dbName}${V2_VERSION_SUFFIX}`)
							return {
								last: version,
								copies: (): StoredCopies => ({
									record: asVersionRecord(version.result),
									v2Dump: null,
									v2Data: null,
									legacyDump: null,
									legacyData: null,
								}),
							}
						})()
			reads.last.onsuccess = () => {
				const copies = reads.copies()
				const { record } = copies
				let reconciliation: SnapshotReconciliation =
					mode === 'restore' ? reconcile(copies) : { source: 'none', legacyDeleted: false }
				const payload = chosenPayload<TDump>(copies, reconciliation)
				if (record.version?.lineage === lineage) {
					const epoch = record.version.epoch
					settle(() => ({ epoch, ...payload, reconciliation }))
					return
				}
				const last = typeof counter.result === 'number' ? counter.result : 0
				const epoch = Math.max(last, record.version?.epoch ?? 0) + 1
				store.put(epoch, `${dbName}${EPOCH_SUFFIX}`)
				const fence: SnapshotVersion = { epoch, lineage, seq: -1 }
				let mirror = record.mirror
				// The fence records what this lineage restores from, so a tab whose writes were in
				// an ancestor (saved there by another tab) can tell they survived. Only a payload
				// that holds the versioned snapshot's writes makes it an ancestor.
				const holdsStored =
					reconciliation.source === 'v2' ||
					(reconciliation.source === 'legacy' && reconciliation.reason === 'newer')
				const ancestors = holdsStored ? descendFrom(record.version, record.ancestors) : []
				if (reconciliation.source === 'none' && reconciliation.legacyDeleted) {
					// Deleted by an earlier release: never bring it back.
					store.delete(`${dbName}${V2_DUMP_SUFFIX}`)
					store.delete(`${dbName}${V2_DATA_SUFFIX}`)
					mirror = null
				}
				const settled = settleLegacyCopy(store, dbName, copies, reconciliation, fence)
				if (settled !== reconciliation && settled.source === 'v2') mirror = fence
				reconciliation = settled
				store.put(versionRecord(fence, ancestors, mirror), `${dbName}${V2_VERSION_SUFFIX}`)
				const result = reconciliation
				settle(() => ({ epoch, ...payload, reconciliation: result }))
			}
		},
	)
}

/** The stored snapshot as a reload would restore it, and where it comes from. */
export interface LoadedSnapshot<TDump> {
	data: Uint8Array | null
	dump: TDump | null
	/** The versioned snapshot's version (null: none stored, or only a legacy copy). */
	version: SnapshotVersion | null
	reconciliation: SnapshotReconciliation
}

/**
 * Load the stored snapshot (binary image, JSON dump and version) in one IndexedDB
 * transaction, reconciled with the legacy-layout copy as {@link startSnapshotLineage}
 * would, without changing anything.
 */
export async function loadSnapshotFromIndexedDB<TDump>(
	dbName: string,
): Promise<LoadedSnapshot<TDump>> {
	return inIdbTransaction<LoadedSnapshot<TDump>>(
		'readonly',
		`Failed to load snapshot of database "${dbName}" from IndexedDB`,
		{ dbName },
		(store, settle) => {
			const reads = readCopies(store, dbName)
			reads.last.onsuccess = () => {
				const copies = reads.copies()
				const reconciliation = reconcile(copies)
				const payload = chosenPayload<TDump>(copies, reconciliation)
				settle(() => ({ ...payload, version: copies.record.version, reconciliation }))
			}
		},
	)
}

/**
 * The JSON dump that holds this database now (the reconciled copy, as a restore would
 * pick it), for moving it to another backend or inspecting it. A legacy-layout copy that
 * diverged from it is kept aside first (once: the legacy keys then hold the mirror), so
 * deleting the IndexedDB copy afterwards ({@link deleteFromIndexedDB}) never drops it.
 */
export async function loadCurrentDumpFromIndexedDB<T>(dbName: string): Promise<T | null> {
	return inIdbTransaction<T | null>(
		'readwrite',
		`Failed to load dump for database "${dbName}" from IndexedDB`,
		{ dbName },
		(store, settle) => {
			const reads = readCopies(store, dbName)
			reads.last.onsuccess = () => {
				const copies = reads.copies()
				const reconciliation = reconcile(copies)
				const { version } = copies.record
				if (version) {
					const settled = settleLegacyCopy(store, dbName, copies, reconciliation, version)
					if (settled !== reconciliation && settled.source === 'v2') {
						store.put(
							versionRecord(version, copies.record.ancestors, version),
							`${dbName}${V2_VERSION_SUFFIX}`,
						)
					}
				}
				const { dump } = chosenPayload<T>(copies, reconciliation)
				settle(() => dump)
			}
		},
	)
}

/** A legacy-layout copy kept aside because it diverged from the versioned snapshot. */
export interface PreservedSnapshot<TDump = unknown> {
	key: string
	dump: TDump | null
	data: Uint8Array | null
}

/** Every legacy-layout copy kept aside for `dbName` ({@link SNAPSHOT_DIVERGED}). */
export async function loadPreservedSnapshotsFromIndexedDB<TDump>(
	dbName: string,
): Promise<Array<PreservedSnapshot<TDump>>> {
	return inIdbTransaction<Array<PreservedSnapshot<TDump>>>(
		'readonly',
		`Failed to load preserved snapshots of database "${dbName}"`,
		{ dbName },
		(store, settle) => {
			const prefix = `${dbName}${PRESERVED_INFIX}`
			const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
			const keys = store.getAllKeys(range)
			const values = store.getAll(range)
			values.onsuccess = () => {
				settle(() =>
					values.result.map((value: unknown, index: number) => ({
						key: String(keys.result[index]),
						dump: isRecord(value) ? ((value.dump as TDump | undefined) ?? null) : null,
						data: isRecord(value) ? toUint8Array(value.data) : null,
					})),
				)
			}
		},
	)
}

/**
 * Load a serialized SQLite database from the legacy-layout key (what an earlier release
 * restores; this release keeps it as a mirror of its snapshot).
 *
 * @param dbName - Key under which the data was stored
 * @returns The serialized database, or null if not found
 */
export async function loadFromIndexedDB(dbName: string): Promise<Uint8Array | null> {
	return inIdbTransaction<Uint8Array | null>(
		'readonly',
		`Failed to load database "${dbName}" from IndexedDB`,
		{ dbName },
		(store, settle) => {
			const request = store.get(dbName)
			request.onsuccess = () => settle(() => toUint8Array(request.result))
		},
	)
}

/**
 * Load the JSON dump from the legacy-layout key (what an earlier release restores; this
 * release keeps it as a stamped mirror of its snapshot). To read the copy that holds the
 * database, use {@link loadCurrentDumpFromIndexedDB}.
 */
export async function loadDumpFromIndexedDB<T>(dbName: string): Promise<T | null> {
	return inIdbTransaction<T | null>(
		'readonly',
		`Failed to load dump for database "${dbName}" from IndexedDB`,
		{ dbName },
		(store, settle) => {
			const request = store.get(`${dbName}${DUMP_SUFFIX}`)
			request.onsuccess = () => settle(() => (request.result as T | undefined) ?? null)
		},
	)
}

/**
 * Delete only the binary SQLite database snapshot (legacy-layout key) from IndexedDB.
 *
 * The logical dump is stored under a separate key and may be the authoritative
 * durable fallback when a browser worker cannot export a binary SQLite image.
 */
export async function deleteSnapshotFromIndexedDB(dbName: string): Promise<void> {
	await inIdbTransaction<void>(
		'readwrite',
		`Failed to delete database snapshot "${dbName}" from IndexedDB`,
		{ dbName },
		(store, settle) => {
			store.delete(dbName)
			settle(() => undefined)
		},
	)
}

/** Options for {@link deleteFromIndexedDB}. */
export interface DeleteFromIndexedDbOptions {
	/**
	 * Also delete the legacy copies kept aside after they diverged ({@link SNAPSHOT_DIVERGED}).
	 * Nothing in Kora passes it (an unsynced-data check never saw those copies, so they are
	 * kept even when the database is deleted); tests use it to clean up.
	 */
	includePreserved?: boolean
}

/**
 * Delete a serialized SQLite database from IndexedDB: the versioned snapshot and the
 * legacy-layout copy.
 *
 * The epoch counter is kept: a lineage started before the delete (a suspended tab that
 * resumes) must never outrank a database created after it, and with no stored version
 * its saves are refused ({@link compareSnapshotVersions}).
 *
 * @param dbName - Key to delete
 */
export async function deleteFromIndexedDB(
	dbName: string,
	options: DeleteFromIndexedDbOptions = {},
): Promise<void> {
	await inIdbTransaction<void>(
		'readwrite',
		`Failed to delete database "${dbName}" from IndexedDB`,
		{ dbName },
		(store, settle) => {
			store.delete(dbName)
			store.delete(`${dbName}${DUMP_SUFFIX}`)
			store.delete(`${dbName}${V2_DUMP_SUFFIX}`)
			store.delete(`${dbName}${V2_DATA_SUFFIX}`)
			store.delete(`${dbName}${V2_VERSION_SUFFIX}`)
			if (options.includePreserved) {
				const prefix = `${dbName}${PRESERVED_INFIX}`
				store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`))
			}
			settle(() => undefined)
		},
	)
}
