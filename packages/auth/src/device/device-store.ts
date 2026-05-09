import { KoraError } from '@korajs/core'

// --- Device key store errors ---

/**
 * Thrown when a device key store operation fails.
 * Provides context about the operation and the underlying cause.
 */
export class DeviceKeyStoreError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'DEVICE_KEY_STORE_ERROR', context)
		this.name = 'DeviceKeyStoreError'
	}
}

// --- Interface ---

/**
 * Persistent storage interface for ECDSA P-256 device key pairs.
 *
 * Device key pairs are used for proof-of-possession authentication:
 * the private key never leaves the device, and the public key is
 * registered with the server. This store persists key pairs across
 * page reloads and app restarts.
 *
 * In the browser, CryptoKey objects are structured-cloneable, so they
 * can be stored directly in IndexedDB without serialization. In Node.js
 * or test environments, an in-memory implementation is used instead.
 */
export interface DeviceKeyStore {
	/**
	 * Persist a key pair for the given device.
	 *
	 * Overwrites any previously stored key pair for the same device ID.
	 *
	 * @param deviceId - The unique device identifier (typically a UUID v7)
	 * @param keyPair - The ECDSA P-256 CryptoKeyPair to store
	 * @throws {DeviceKeyStoreError} If the storage operation fails
	 */
	saveKeyPair(deviceId: string, keyPair: CryptoKeyPair): Promise<void>

	/**
	 * Load a previously stored key pair for the given device.
	 *
	 * @param deviceId - The unique device identifier
	 * @returns The stored CryptoKeyPair, or null if no key pair exists for the device
	 * @throws {DeviceKeyStoreError} If the storage operation fails
	 */
	loadKeyPair(deviceId: string): Promise<CryptoKeyPair | null>

	/**
	 * Delete a stored key pair for the given device.
	 *
	 * No-op if no key pair exists for the device ID.
	 *
	 * @param deviceId - The unique device identifier
	 * @throws {DeviceKeyStoreError} If the storage operation fails
	 */
	deleteKeyPair(deviceId: string): Promise<void>

	/**
	 * Check whether a key pair exists for the given device.
	 *
	 * @param deviceId - The unique device identifier
	 * @returns True if a key pair is stored for the device, false otherwise
	 * @throws {DeviceKeyStoreError} If the storage operation fails
	 */
	hasKeyPair(deviceId: string): Promise<boolean>
}

// --- IndexedDB constants ---

/** IndexedDB database name for device key storage. */
const IDB_DATABASE_NAME = 'kora_device_keys'

/** IndexedDB object store name within the database. */
const IDB_STORE_NAME = 'keypairs'

/** Current database schema version. */
const IDB_VERSION = 1

// --- IndexedDB implementation ---

/**
 * Browser-based device key store backed by IndexedDB.
 *
 * CryptoKey objects are structured-cloneable, so they can be stored
 * directly in IndexedDB without needing to export/import them as JWK.
 * This preserves the non-extractable flag on private keys, ensuring
 * they cannot be read even from storage.
 *
 * The database uses a single object store (`keypairs`) with the device ID
 * as the key and the full CryptoKeyPair as the value.
 *
 * @example
 * ```typescript
 * const store = new IndexedDBDeviceKeyStore()
 * const keyPair = await generateDeviceKeyPair()
 * await store.saveKeyPair('device-123', keyPair)
 *
 * const loaded = await store.loadKeyPair('device-123')
 * // loaded.privateKey is still non-extractable
 * ```
 */
export class IndexedDBDeviceKeyStore implements DeviceKeyStore {
	private dbPromise: Promise<IDBDatabase> | null = null

	/**
	 * Opens (or creates) the IndexedDB database.
	 *
	 * The database connection is lazily initialized on first use and
	 * reused for subsequent operations. If the database does not exist,
	 * it is created with the `keypairs` object store.
	 */
	private openDatabase(): Promise<IDBDatabase> {
		// Reuse the database connection if already opened.
		// This avoids repeatedly opening the database on every operation.
		if (this.dbPromise !== null) {
			return this.dbPromise
		}

		this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
			let request: IDBOpenDBRequest

			try {
				request = globalThis.indexedDB.open(IDB_DATABASE_NAME, IDB_VERSION)
			} catch (cause) {
				this.dbPromise = null
				reject(
					new DeviceKeyStoreError(
						'Failed to open IndexedDB database for device key storage. ' +
							'IndexedDB may be unavailable or access may be denied.',
						{ cause: cause instanceof Error ? cause.message : String(cause) },
					),
				)
				return
			}

			request.onupgradeneeded = () => {
				const db = request.result
				if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
					db.createObjectStore(IDB_STORE_NAME)
				}
			}

			request.onsuccess = () => {
				resolve(request.result)
			}

			request.onerror = () => {
				this.dbPromise = null
				reject(
					new DeviceKeyStoreError('Failed to open IndexedDB database for device key storage.', {
						error: request.error?.message,
					}),
				)
			}

			request.onblocked = () => {
				this.dbPromise = null
				reject(
					new DeviceKeyStoreError(
						'IndexedDB database open was blocked. ' +
							'Another tab may have an older version of the database open. ' +
							'Close other tabs and try again.',
					),
				)
			}
		})

		return this.dbPromise
	}

	/** @inheritdoc */
	async saveKeyPair(deviceId: string, keyPair: CryptoKeyPair): Promise<void> {
		const db = await this.openDatabase()

		return new Promise<void>((resolve, reject) => {
			try {
				const tx = db.transaction(IDB_STORE_NAME, 'readwrite')
				const store = tx.objectStore(IDB_STORE_NAME)

				// Store the CryptoKeyPair as a structured clone with the deviceId as the key.
				// IndexedDB handles structured cloning of CryptoKey objects natively.
				store.put(keyPair, deviceId)

				tx.oncomplete = () => {
					resolve()
				}

				tx.onerror = () => {
					reject(
						new DeviceKeyStoreError(`Failed to save key pair for device "${deviceId}".`, {
							deviceId,
							error: tx.error?.message,
						}),
					)
				}
			} catch (cause) {
				reject(
					new DeviceKeyStoreError(`Failed to save key pair for device "${deviceId}".`, {
						deviceId,
						cause: cause instanceof Error ? cause.message : String(cause),
					}),
				)
			}
		})
	}

	/** @inheritdoc */
	async loadKeyPair(deviceId: string): Promise<CryptoKeyPair | null> {
		const db = await this.openDatabase()

		return new Promise<CryptoKeyPair | null>((resolve, reject) => {
			try {
				const tx = db.transaction(IDB_STORE_NAME, 'readonly')
				const store = tx.objectStore(IDB_STORE_NAME)
				const request = store.get(deviceId)

				request.onsuccess = () => {
					const result = request.result as CryptoKeyPair | undefined
					resolve(result ?? null)
				}

				request.onerror = () => {
					reject(
						new DeviceKeyStoreError(`Failed to load key pair for device "${deviceId}".`, {
							deviceId,
							error: request.error?.message,
						}),
					)
				}
			} catch (cause) {
				reject(
					new DeviceKeyStoreError(`Failed to load key pair for device "${deviceId}".`, {
						deviceId,
						cause: cause instanceof Error ? cause.message : String(cause),
					}),
				)
			}
		})
	}

	/** @inheritdoc */
	async deleteKeyPair(deviceId: string): Promise<void> {
		const db = await this.openDatabase()

		return new Promise<void>((resolve, reject) => {
			try {
				const tx = db.transaction(IDB_STORE_NAME, 'readwrite')
				const store = tx.objectStore(IDB_STORE_NAME)
				store.delete(deviceId)

				tx.oncomplete = () => {
					resolve()
				}

				tx.onerror = () => {
					reject(
						new DeviceKeyStoreError(`Failed to delete key pair for device "${deviceId}".`, {
							deviceId,
							error: tx.error?.message,
						}),
					)
				}
			} catch (cause) {
				reject(
					new DeviceKeyStoreError(`Failed to delete key pair for device "${deviceId}".`, {
						deviceId,
						cause: cause instanceof Error ? cause.message : String(cause),
					}),
				)
			}
		})
	}

	/** @inheritdoc */
	async hasKeyPair(deviceId: string): Promise<boolean> {
		const db = await this.openDatabase()

		return new Promise<boolean>((resolve, reject) => {
			try {
				const tx = db.transaction(IDB_STORE_NAME, 'readonly')
				const store = tx.objectStore(IDB_STORE_NAME)

				// Use count() with the key to check existence without loading the value.
				// This is more efficient than get() for large CryptoKeyPair objects.
				const request = store.count(deviceId)

				request.onsuccess = () => {
					resolve(request.result > 0)
				}

				request.onerror = () => {
					reject(
						new DeviceKeyStoreError(
							`Failed to check if key pair exists for device "${deviceId}".`,
							{ deviceId, error: request.error?.message },
						),
					)
				}
			} catch (cause) {
				reject(
					new DeviceKeyStoreError(`Failed to check if key pair exists for device "${deviceId}".`, {
						deviceId,
						cause: cause instanceof Error ? cause.message : String(cause),
					}),
				)
			}
		})
	}
}

// --- In-memory implementation ---

/**
 * In-memory device key store for Node.js and testing environments.
 *
 * Key pairs are stored in a plain Map and do not survive process restarts.
 * This is suitable for server-side rendering, Node.js scripts, and unit tests
 * where IndexedDB is not available.
 *
 * @example
 * ```typescript
 * const store = new InMemoryDeviceKeyStore()
 * const keyPair = await generateDeviceKeyPair()
 * await store.saveKeyPair('device-123', keyPair)
 *
 * const loaded = await store.loadKeyPair('device-123')
 * ```
 */
export class InMemoryDeviceKeyStore implements DeviceKeyStore {
	private readonly store = new Map<string, CryptoKeyPair>()

	/** @inheritdoc */
	async saveKeyPair(deviceId: string, keyPair: CryptoKeyPair): Promise<void> {
		this.store.set(deviceId, keyPair)
	}

	/** @inheritdoc */
	async loadKeyPair(deviceId: string): Promise<CryptoKeyPair | null> {
		return this.store.get(deviceId) ?? null
	}

	/** @inheritdoc */
	async deleteKeyPair(deviceId: string): Promise<void> {
		this.store.delete(deviceId)
	}

	/** @inheritdoc */
	async hasKeyPair(deviceId: string): Promise<boolean> {
		return this.store.has(deviceId)
	}
}

// --- Factory ---

/**
 * Creates a DeviceKeyStore appropriate for the current environment.
 *
 * In browsers where IndexedDB is available, returns an {@link IndexedDBDeviceKeyStore}
 * that persists CryptoKeyPair objects as structured clones. In Node.js, SSR,
 * or environments without IndexedDB, returns an {@link InMemoryDeviceKeyStore}.
 *
 * @returns A DeviceKeyStore instance for the current environment
 *
 * @example
 * ```typescript
 * const store = createDeviceKeyStore()
 * const keyPair = await generateDeviceKeyPair()
 * await store.saveKeyPair(deviceId, keyPair)
 * ```
 */
export function createDeviceKeyStore(): DeviceKeyStore {
	if (typeof globalThis.indexedDB !== 'undefined') {
		return new IndexedDBDeviceKeyStore()
	}
	return new InMemoryDeviceKeyStore()
}
