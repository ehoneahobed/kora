import type { WrappedKeyRecord } from './key-record'

/**
 * What a device keeps of an unlocked keyring: the last key record it accepted (also
 * the rollback pin), the passphrase KEK when known, and every data key it opened. Keys
 * are NON-EXTRACTABLE CryptoKeys: script on the page can use them while it runs, but
 * cannot read their bytes.
 */
export interface CachedKeyring {
	record: WrappedKeyRecord
	kek: CryptoKey | null
	keys: Array<{ keyVersion: number; keyId: string; key: CryptoKey }>
}

/** Where a device keeps unlocked keyrings between app starts. */
export interface KeyCache {
	/** Which kind of cache this is (for status and docs). */
	readonly kind: 'indexeddb' | 'memory' | 'none'
	load(id: string): Promise<CachedKeyring | null>
	save(id: string, entry: CachedKeyring): Promise<void>
	clear(id: string): Promise<void>
}

/** Keeps unlocked keyrings for the lifetime of the process only. */
export class MemoryKeyCache implements KeyCache {
	readonly kind = 'memory' as const
	private readonly entries = new Map<string, CachedKeyring>()

	async load(id: string): Promise<CachedKeyring | null> {
		return this.entries.get(id) ?? null
	}

	async save(id: string, entry: CachedKeyring): Promise<void> {
		this.entries.set(id, entry)
	}

	async clear(id: string): Promise<void> {
		this.entries.delete(id)
	}
}

/** Keeps nothing: the device asks for the passphrase on every start. */
export class NoKeyCache implements KeyCache {
	readonly kind = 'none' as const
	async load(): Promise<CachedKeyring | null> {
		return null
	}
	async save(): Promise<void> {}
	async clear(): Promise<void> {}
}

const IDB_STORE = 'keyrings'

/**
 * Keeps unlocked keyrings in IndexedDB (structured clone keeps a CryptoKey
 * non-extractable). Survives reloads, so a device unlocks once and then works offline.
 */
export class IndexedDbKeyCache implements KeyCache {
	readonly kind = 'indexeddb' as const
	private db: Promise<IDBDatabase> | null = null

	/** @param databaseName - IndexedDB database name (one per app database) */
	constructor(private readonly databaseName: string) {}

	async load(id: string): Promise<CachedKeyring | null> {
		const db = await this.open()
		return new Promise((resolve, reject) => {
			const request = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(id)
			request.onsuccess = () => resolve((request.result as CachedKeyring | undefined) ?? null)
			request.onerror = () => reject(request.error)
		})
	}

	async save(id: string, entry: CachedKeyring): Promise<void> {
		const db = await this.open()
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, 'readwrite')
			tx.objectStore(IDB_STORE).put(entry, id)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
			tx.onabort = () => reject(tx.error)
		})
	}

	async clear(id: string): Promise<void> {
		const db = await this.open()
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, 'readwrite')
			tx.objectStore(IDB_STORE).delete(id)
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
			tx.onabort = () => reject(tx.error)
		})
	}

	private open(): Promise<IDBDatabase> {
		if (!this.db) {
			this.db = new Promise((resolve, reject) => {
				const request = indexedDB.open(this.databaseName, 1)
				request.onupgradeneeded = () => {
					if (!request.result.objectStoreNames.contains(IDB_STORE)) {
						request.result.createObjectStore(IDB_STORE)
					}
				}
				request.onsuccess = () => resolve(request.result)
				request.onerror = () => reject(request.error)
			})
		}
		return this.db
	}
}

/**
 * The default cache: IndexedDB where it exists (browsers), memory otherwise (Node,
 * tests). See the encryption guide for what each means for offline unlock.
 *
 * @param mode - 'auto' (default), 'indexeddb', 'memory' or 'none'
 * @param databaseName - IndexedDB database name
 */
export function createKeyCache(
	mode: 'auto' | 'indexeddb' | 'memory' | 'none' = 'auto',
	databaseName = 'kora-keyring',
): KeyCache {
	if (mode === 'none') return new NoKeyCache()
	if (mode === 'memory') return new MemoryKeyCache()
	const hasIndexedDb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined'
	if (mode === 'indexeddb' || hasIndexedDb) {
		return hasIndexedDb ? new IndexedDbKeyCache(databaseName) : new MemoryKeyCache()
	}
	return new MemoryKeyCache()
}
