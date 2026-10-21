/// <reference lib="dom" />
import { PersistenceError } from '../errors'

/**
 * The version gate's open-order counter (section 3): a small IndexedDB database of its
 * own, `kora-gate`, one counter record per Kora database name. It lives apart from the
 * IndexedDB fallback's snapshot database because OPFS apps never open that one.
 */
const GATE_DATABASE = 'kora-gate'
const GATE_STORE = 'open-seq'

function openGateDatabase(): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(GATE_DATABASE, 1)
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(GATE_STORE)) {
				request.result.createObjectStore(GATE_STORE)
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () =>
			reject(
				new PersistenceError(
					`Could not open the version gate's IndexedDB database: ${request.error?.message ?? 'unknown error'}`,
					{ database: GATE_DATABASE },
				),
			)
	})
}

/**
 * Allocate this tab's `openSeq` for `dbName`: read `n`, write `n + 1`, take `n + 1`, in
 * ONE `readwrite` transaction. IndexedDB serializes `readwrite` transactions on a store
 * across tabs, so no two tabs get the same value and a later allocation always gets a
 * higher one, whatever the wall clock does (it can move backwards, and two tabs can open
 * in the same millisecond). The record is never reset.
 *
 * @throws PersistenceError when IndexedDB is unavailable or the transaction fails: the
 *   caller fails the open, never guesses an order
 */
export async function allocateOpenSeq(dbName: string): Promise<number> {
	if (typeof indexedDB === 'undefined') {
		throw new PersistenceError(
			`Could not order this tab among the tabs of database "${dbName}": IndexedDB is unavailable.`,
			{ dbName, code: 'OPEN_SEQ_UNAVAILABLE' },
		)
	}
	const db = await openGateDatabase()
	try {
		return await new Promise<number>((resolve, reject) => {
			const tx = db.transaction(GATE_STORE, 'readwrite')
			const store = tx.objectStore(GATE_STORE)
			let allocated = 0
			const read = store.get(dbName)
			read.onsuccess = () => {
				const current = typeof read.result === 'number' ? read.result : 0
				allocated = current + 1
				store.put(allocated, dbName)
			}
			tx.oncomplete = () => resolve(allocated)
			const fail = (): void =>
				reject(
					new PersistenceError(
						`Could not order this tab among the tabs of database "${dbName}": ${tx.error?.message ?? 'transaction aborted'}`,
						{ dbName, code: 'OPEN_SEQ_FAILED' },
					),
				)
			tx.onerror = fail
			tx.onabort = fail
		})
	} finally {
		db.close()
	}
}
