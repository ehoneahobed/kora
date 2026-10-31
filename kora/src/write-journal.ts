/**
 * The durable journal of writes made before the store opened (first-visit parity, S4a,
 * decision D7).
 *
 * `KoraProvider` renders before the database opens, so a user can press "add" while the
 * SQLite WASM is still downloading. The hook queues that write in memory and applies it
 * once the store is open; closing the tab in between would lose it. This journal closes
 * the window: the write is saved to IndexedDB (which needs none of Kora's runtime) before
 * the call does anything else, and the next session that opens the same database applies
 * what a closed tab left behind. The call's promise still resolves only after the write
 * reached the store, so "saved" keeps meaning what it always meant.
 *
 * It is deliberately small: one object store, append, list, remove. Nothing here knows
 * about the store, the schema or sync.
 */

/** The shapes of write a hook can queue. */
export type JournaledWriteKind = 'insert' | 'insertMany' | 'update' | 'delete'

/** One write waiting for the store to open. */
export interface JournalEntry {
	/** Ascending order of creation; assigned by IndexedDB. */
	seq?: number
	/** The page session that queued it (a live session applies its own entries). */
	session: string
	/** The user the app knew when the write was made, or null (signed out, or no auth). */
	owner: string | null
	/** Wall-clock milliseconds when it was queued (age, pruning; never used for ordering). */
	at: number
	collection: string
	kind: JournaledWriteKind
	/** The arguments of the collection method, in a structured-cloneable form. */
	args: unknown[]
	options?: { durable?: boolean }
	/** Set when applying it failed for good; kept for inspection, never retried. */
	failed?: string
}

/** The journal of one database. */
export interface WriteJournal {
	/** Save an entry; resolves with its sequence number once the transaction is durable. */
	append(entry: JournalEntry): Promise<number>
	/** Every entry, oldest first. */
	list(): Promise<JournalEntry[]>
	/** Forget an entry (it was applied, or it is dropped). */
	remove(seq: number): Promise<void>
	/** Keep an entry for inspection but never apply it again. */
	markFailed(seq: number, message: string): Promise<void>
	/** Release the connection. */
	close(): void
}

const STORE = 'entries'

/** The IndexedDB name of a database's write journal. */
export function writeJournalName(dbName: string): string {
	return `kora-write-journal:${dbName}`
}

/** Whether this environment can keep a journal at all (a browser with IndexedDB). */
export function writeJournalSupported(): boolean {
	return typeof indexedDB !== 'undefined' && indexedDB !== null
}

/**
 * Open the write journal of `dbName`, or null where there is no IndexedDB (a server
 * render, a Node script): those environments keep the queue in memory only.
 *
 * @param dbName - The local database name the queued writes belong to
 * @returns The journal, opened lazily on first use
 */
export function openWriteJournal(dbName: string): WriteJournal | null {
	if (!writeJournalSupported()) return null
	let connection: Promise<IDBDatabase> | null = null

	const connect = (): Promise<IDBDatabase> => {
		connection ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(writeJournalName(dbName), 1)
			request.onupgradeneeded = () => {
				request.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true })
			}
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
			request.onblocked = () => reject(new Error('IndexedDB open blocked'))
		})
		// A failed open is retried by the next call.
		connection.catch(() => {
			connection = null
		})
		return connection
	}

	const run = async <T>(
		mode: IDBTransactionMode,
		work: (store: IDBObjectStore) => IDBRequest<T>,
	): Promise<T> => {
		const db = await connect()
		return new Promise<T>((resolve, reject) => {
			// `strict` asks the browser to flush to disk before `complete`; engines that do not
			// know the option ignore it.
			const tx = db.transaction(STORE, mode, { durability: 'strict' } as IDBTransactionOptions)
			let result: T
			const request = work(tx.objectStore(STORE))
			request.onsuccess = () => {
				result = request.result
			}
			tx.oncomplete = () => resolve(result)
			tx.onerror = () => reject(tx.error ?? request.error ?? new Error('IndexedDB write failed'))
			tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
		})
	}

	return {
		async append(entry) {
			const key = await run('readwrite', (store) => store.add(entry))
			return Number(key)
		},
		async list() {
			const all = await run('readonly', (store) => store.getAll() as IDBRequest<JournalEntry[]>)
			return all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
		},
		async remove(seq) {
			await run('readwrite', (store) => store.delete(seq))
		},
		async markFailed(seq, message) {
			const db = await connect()
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(STORE, 'readwrite')
				const store = tx.objectStore(STORE)
				const read = store.get(seq)
				read.onsuccess = () => {
					const found = read.result as JournalEntry | undefined
					if (found) store.put({ ...found, failed: message })
				}
				tx.oncomplete = () => resolve()
				tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
				tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
			})
		},
		close() {
			const pending = connection
			connection = null
			void pending?.then((db) => db.close()).catch(() => {})
		},
	}
}
