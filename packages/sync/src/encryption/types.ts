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
 * Configuration for sync-layer encryption.
 *
 * When enabled, the sync engine encrypts `data` and `previousData` fields
 * of every operation before sending over the wire. The server never sees
 * plaintext user data.
 *
 * @example
 * ```typescript
 * const app = createApp({
 *   schema,
 *   sync: {
 *     url: 'wss://my-server.com/kora',
 *     encryption: {
 *       enabled: true,
 *       key: 'my-secure-passphrase'
 *     }
 *   }
 * })
 * ```
 */
export interface SyncEncryptionConfig {
	/** Whether encryption is enabled. When false, all other fields are ignored. */
	enabled: boolean
	/**
	 * Passphrase or async key provider function.
	 *
	 * - If a string, used as a passphrase for PBKDF2 key derivation.
	 * - If a function, called to retrieve the passphrase (e.g., from a vault or user prompt).
	 */
	key: string | (() => Promise<string>)
	/**
	 * Encryption algorithm. Defaults to 'aes-256-gcm'.
	 * Currently only AES-256-GCM is supported.
	 */
	algorithm?: SyncEncryptionAlgorithm
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
 * A versioned encryption key with its associated salt for key derivation.
 *
 * Key versions enable rotation: when the passphrase changes, a new key version
 * is created. Operations encrypted with older key versions include their version
 * number in the {@link EncryptedPayload}, allowing the decryptor to select the
 * correct key.
 */
export interface VersionedKey {
	/** Key version number (monotonically increasing, starting at 1). */
	version: number
	/** The derived CryptoKey for AES-256-GCM operations. */
	key: CryptoKey
	/** The salt used during PBKDF2 key derivation. Required to re-derive the same key. */
	salt: Uint8Array
}
