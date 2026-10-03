/**
 * Encryption types for the Kora.js sync layer.
 *
 * These types define the configuration and wire format for end-to-end
 * encryption of operation data during sync. Only `data` and `previousData`
 * fields are encrypted — metadata stays in cleartext for routing and ordering.
 */

/**
 * Supported encryption algorithms. Currently only AES-256-GCM is supported,
 * but the type is extensible for future algorithms.
 */
export type SyncEncryptionAlgorithm = 'aes-256-gcm'

/**
 * Configuration for sync-layer end-to-end encryption.
 *
 * Every user has a keyring of random 256-bit data keys. The sync server stores them
 * only wrapped by a key derived from the user's passphrase (PBKDF2-SHA256, 600,000
 * iterations, per-user random salt); it never sees the passphrase or a data key. A
 * device fetches and opens the record during the sync handshake, caches the opened
 * keys (non-extractable), and from then on works offline. Every device of the user
 * that opens the record holds the same keys, so it decrypts everything.
 *
 * @example
 * ```typescript
 * const app = createApp({
 *   schema,
 *   sync: {
 *     url: 'wss://my-server.com/kora',
 *     encryption: { enabled: true },   // locked until app.encryption.unlock(passphrase)
 *   }
 * })
 * ```
 */
export interface SyncEncryptionConfig {
	/** Whether encryption is enabled. When false, all other fields are ignored. */
	enabled: boolean
	/**
	 * The user's encryption passphrase, or an async provider of it. Optional: without
	 * it the keyring starts locked (sync paused, local data usable) until
	 * `app.encryption.unlock(passphrase)`. With it, the keyring is opened (or, on the
	 * user's first device, created) automatically at the first sync handshake.
	 */
	key?: string | (() => Promise<string>)
	/**
	 * Keyring name: one encryption scope of the signed-in user. Defaults to 'default'.
	 * Distinct keyrings have distinct keys and passphrases.
	 */
	keyring?: string
	/**
	 * Where unlocked keys are kept on the device: 'auto' (IndexedDB in browsers, memory
	 * elsewhere), 'indexeddb', 'memory' (until the app closes) or 'none' (ask for the
	 * passphrase at every start). Keys are stored non-extractable.
	 */
	keyCache?: 'auto' | 'indexeddb' | 'memory' | 'none'
	/**
	 * PBKDF2 iterations for new key records, and the minimum accepted from the server.
	 * Defaults to 600,000 (OWASP). Lower it only in tests; every device of a user must
	 * use the same value or a lower one.
	 */
	kdfIterations?: number
	/**
	 * Encryption algorithm. Defaults to 'aes-256-gcm'.
	 * Currently only AES-256-GCM is supported.
	 */
	algorithm?: SyncEncryptionAlgorithm
	/**
	 * Per collection, the data fields that travel in cleartext beside the encryption
	 * envelope, so the server can evaluate sync scopes on them (for example
	 * `{ todos: ['ownerId'] }`). Every other field, `previousData` and atomic ops are
	 * ciphertext. Values listed here are visible to the server: list only scope keys.
	 */
	cleartextFields?: Record<string, string[]>
	/**
	 * Accept inbound operations without an encryption envelope during a migration from
	 * plaintext sync. Off by default: with encryption enabled a plaintext operation is
	 * refused (quarantined), because anyone who can reach the sync server could have
	 * written it (ENC-3). Turn it on only for the migration window.
	 */
	allowPlaintextMigration?: boolean
}

/**
 * Encrypted payload structure embedded in operation `data` and `previousData`
 * fields when encryption is enabled.
 *
 * This structure replaces the original field values on the wire. The server
 * stores and relays these opaque payloads without being able to read the
 * plaintext contents.
 */
export interface EncryptedPayload {
	/** Encryption key version. Supports key rotation: older operations may use older key versions. */
	v: number
	/** Base64-encoded initialization vector (12 bytes for AES-GCM). Unique per operation field. */
	iv: string
	/** Base64-encoded ciphertext (AES-256-GCM output including authentication tag). */
	ct: string
	/** Encryption algorithm identifier. */
	alg: SyncEncryptionAlgorithm
}

/**
 * A versioned encryption key.
 *
 * Key versions enable rotation: operations encrypted with older key versions carry
 * their version number in the envelope, so the decryptor selects the correct key.
 */
export interface VersionedKey {
	/** Key version number (monotonically increasing, starting at 1). */
	version: number
	/** The CryptoKey for AES-256-GCM operations. */
	key: CryptoKey
	/**
	 * The id written into envelopes (`keyId`). Keyring keys carry a random id from the
	 * key record. When absent, the id is a fingerprint of `salt`.
	 */
	keyId?: string
	/** The salt a passphrase-derived key was derived with (names it when `keyId` is absent). */
	salt?: Uint8Array
}
