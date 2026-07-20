import { SyncError } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SerializedOperation } from '../protocol/messages'
import { deriveVersionedKey } from './key-derivation'
import type { EncryptedPayload, SyncEncryptionConfig, VersionedKey } from './types'

/**
 * Thrown when encryption of operation data fails.
 */
export class EncryptionError extends SyncError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, errorType: 'ENCRYPTION_ERROR' })
		this.name = 'EncryptionError'
	}
}

/**
 * Thrown when decryption of operation data fails.
 * This typically indicates a wrong key, tampered ciphertext, or corrupted data.
 */
export class DecryptionError extends SyncError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, errorType: 'DECRYPTION_ERROR' })
		this.name = 'DecryptionError'
	}
}

/** AES-GCM initialization vector length in bytes (96 bits). NIST recommended. */
const IV_LENGTH = 12

/** Marker field to identify encrypted payloads during deserialization. */
const ENCRYPTED_MARKER = '__kora_e2e_encrypted' as const

/**
 * Encrypts and decrypts operation `data` and `previousData` fields for
 * end-to-end encryption in the sync layer.
 *
 * **Design principles:**
 * - Only `data` and `previousData` are encrypted. Metadata (id, nodeId,
 *   collection, timestamps, causalDeps, etc.) stays in cleartext so the
 *   server can route, deduplicate, and order operations.
 * - Each field encryption uses a unique random IV (12 bytes for AES-GCM),
 *   ensuring that encrypting the same data twice produces different ciphertext.
 * - Key rotation is supported via versioned keys. The key version is embedded
 *   in the {@link EncryptedPayload} so the decryptor can select the correct key.
 * - Unencrypted fields pass through during decryption (backward compatibility).
 *
 * @example
 * ```typescript
 * const encryptor = await SyncEncryptor.create({
 *   enabled: true,
 *   key: 'user-passphrase'
 * })
 *
 * // Encrypt before sending
 * const encrypted = await encryptor.encryptOperation(operation)
 *
 * // Decrypt after receiving
 * const decrypted = await encryptor.decryptOperation(encrypted)
 * ```
 */
export class SyncEncryptor {
	/**
	 * Map of key version -> VersionedKey. The current (latest) version is used
	 * for encryption. All versions are available for decryption (key rotation).
	 */
	private readonly keys: Map<number, VersionedKey>
	/** The current key version used for encryption. */
	private currentVersion: number

	private constructor(keys: Map<number, VersionedKey>, currentVersion: number) {
		this.keys = keys
		this.currentVersion = currentVersion
	}

	/**
	 * Creates a SyncEncryptor from a {@link SyncEncryptionConfig}.
	 *
	 * Derives the encryption key from the passphrase using PBKDF2. The key
	 * derivation is async because it uses the Web Crypto API.
	 *
	 * @param config - Encryption configuration with passphrase
	 * @param salt - Optional salt for deterministic key derivation (mainly for testing).
	 *              If omitted, a random salt is generated.
	 * @param iterations - Optional PBKDF2 iteration count. Defaults to the
	 *              production-strength value. Lower it only in tests.
	 * @returns A configured SyncEncryptor instance
	 * @throws {EncryptionError} If configuration is invalid
	 * @throws {KeyDerivationError} If key derivation fails
	 */
	static async create(
		config: SyncEncryptionConfig,
		salt?: Uint8Array,
		iterations?: number,
	): Promise<SyncEncryptor> {
		if (!config.enabled) {
			throw new EncryptionError(
				'Cannot create SyncEncryptor with encryption disabled. ' +
					'Set enabled: true in the encryption config.',
			)
		}

		const passphrase = typeof config.key === 'function' ? await config.key() : config.key

		if (passphrase.length === 0) {
			throw new EncryptionError(
				'Encryption key/passphrase must not be empty. ' +
					'Provide a non-empty string or key provider function.',
			)
		}

		const versionedKey = await deriveVersionedKey(passphrase, 1, salt, iterations)
		const keys = new Map<number, VersionedKey>()
		keys.set(1, versionedKey)

		return new SyncEncryptor(keys, 1)
	}

	/**
	 * Creates a SyncEncryptor from pre-derived versioned keys.
	 *
	 * Use this when you need to support multiple key versions for key rotation,
	 * or when you have already derived the keys externally.
	 *
	 * @param versionedKeys - Array of versioned keys. The highest version is used for encryption.
	 * @returns A configured SyncEncryptor instance
	 * @throws {EncryptionError} If no keys are provided
	 */
	static fromKeys(versionedKeys: VersionedKey[]): SyncEncryptor {
		if (versionedKeys.length === 0) {
			throw new EncryptionError('At least one versioned key must be provided.')
		}

		const keys = new Map<number, VersionedKey>()
		let maxVersion = 0

		for (const vk of versionedKeys) {
			keys.set(vk.version, vk)
			if (vk.version > maxVersion) {
				maxVersion = vk.version
			}
		}

		return new SyncEncryptor(keys, maxVersion)
	}

	/**
	 * Add a new key version for key rotation.
	 *
	 * After adding, the new key becomes the current version used for encryption
	 * if its version number is higher than the current version. Previously-versioned
	 * keys remain available for decrypting older operations.
	 *
	 * @param key - The new versioned key to add
	 * @throws {EncryptionError} If the key version already exists
	 */
	addKey(key: VersionedKey): void {
		if (this.keys.has(key.version)) {
			throw new EncryptionError(
				`Key version ${key.version} already exists. Use a higher version number for rotation.`,
				{ existingVersion: key.version },
			)
		}

		this.keys.set(key.version, key)
		if (key.version > this.currentVersion) {
			this.currentVersion = key.version
		}
	}

	/**
	 * Get the current encryption key version number.
	 */
	getCurrentKeyVersion(): number {
		return this.currentVersion
	}

	/**
	 * Encrypt an operation's `data` and `previousData` fields.
	 *
	 * Returns a new Operation with encrypted field values. The original
	 * operation is not mutated (operations are immutable).
	 *
	 * Fields that are null (e.g., delete operations) remain null.
	 *
	 * @param operation - The operation to encrypt
	 * @returns A new operation with encrypted data fields
	 * @throws {EncryptionError} If encryption fails
	 */
	async encryptOperation(operation: Operation): Promise<Operation> {
		const [encryptedData, encryptedPreviousData] = await Promise.all([
			this.encryptField(operation.data, operation.id, 'data'),
			this.encryptField(operation.previousData, operation.id, 'previousData'),
		])

		return {
			...operation,
			data: encryptedData,
			previousData: encryptedPreviousData,
		}
	}

	/**
	 * Decrypt an operation's `data` and `previousData` fields.
	 *
	 * Returns a new Operation with the original field values restored.
	 * The original operation is not mutated.
	 *
	 * If a field is null or not encrypted (no marker), it passes through unchanged.
	 * This enables mixed plaintext/encrypted operations during migration.
	 *
	 * @param operation - The operation to decrypt
	 * @returns A new operation with decrypted data fields
	 * @throws {DecryptionError} If decryption fails (wrong key, tampered data, unsupported version)
	 */
	async decryptOperation(operation: Operation): Promise<Operation> {
		const [decryptedData, decryptedPreviousData] = await Promise.all([
			this.decryptField(operation.data, operation.id, 'data'),
			this.decryptField(operation.previousData, operation.id, 'previousData'),
		])

		return {
			...operation,
			data: decryptedData,
			previousData: decryptedPreviousData,
		}
	}

	/**
	 * Encrypt a serialized operation's `data` and `previousData` fields.
	 *
	 * Same as {@link encryptOperation} but works with the wire-format
	 * {@link SerializedOperation} type used by the serializer.
	 *
	 * @param serialized - The serialized operation to encrypt
	 * @returns A new serialized operation with encrypted data fields
	 * @throws {EncryptionError} If encryption fails
	 */
	async encryptSerializedOperation(serialized: SerializedOperation): Promise<SerializedOperation> {
		const [encryptedData, encryptedPreviousData] = await Promise.all([
			this.encryptField(serialized.data, serialized.id, 'data'),
			this.encryptField(serialized.previousData, serialized.id, 'previousData'),
		])

		return {
			...serialized,
			data: encryptedData,
			previousData: encryptedPreviousData,
		}
	}

	/**
	 * Decrypt a serialized operation's `data` and `previousData` fields.
	 *
	 * Same as {@link decryptOperation} but works with the wire-format
	 * {@link SerializedOperation} type used by the serializer.
	 *
	 * @param serialized - The serialized operation to decrypt
	 * @returns A new serialized operation with decrypted data fields
	 * @throws {DecryptionError} If decryption fails
	 */
	async decryptSerializedOperation(serialized: SerializedOperation): Promise<SerializedOperation> {
		const [decryptedData, decryptedPreviousData] = await Promise.all([
			this.decryptField(serialized.data, serialized.id, 'data'),
			this.decryptField(serialized.previousData, serialized.id, 'previousData'),
		])

		return {
			...serialized,
			data: decryptedData,
			previousData: decryptedPreviousData,
		}
	}

	/**
	 * Encrypt a batch of operations in parallel.
	 *
	 * @param operations - Operations to encrypt
	 * @returns New operations with encrypted data fields
	 */
	async encryptBatch(operations: Operation[]): Promise<Operation[]> {
		return Promise.all(operations.map((op) => this.encryptOperation(op)))
	}

	/**
	 * Decrypt a batch of operations in parallel.
	 *
	 * @param operations - Operations to decrypt
	 * @returns New operations with decrypted data fields
	 */
	async decryptBatch(operations: Operation[]): Promise<Operation[]> {
		return Promise.all(operations.map((op) => this.decryptOperation(op)))
	}

	/**
	 * Check if a field value contains an encrypted payload.
	 *
	 * @param field - An operation's `data` or `previousData` field
	 * @returns true if the field contains an encrypted payload
	 */
	static isEncryptedPayload(field: Record<string, unknown> | null): boolean {
		return isEncryptedPayload(field)
	}

	// --- Private helpers ---

	private async encryptField(
		field: Record<string, unknown> | null,
		operationId: string,
		fieldName: string,
	): Promise<Record<string, unknown> | null> {
		if (field === null) {
			return null
		}

		const currentKey = this.keys.get(this.currentVersion)
		if (!currentKey) {
			throw new EncryptionError(
				`Current encryption key version ${this.currentVersion} not found.`,
				{ operationId, fieldName },
			)
		}

		try {
			const plaintext = new TextEncoder().encode(JSON.stringify(field))

			// Generate a fresh random IV for each field encryption.
			// AES-GCM with a 96-bit IV is the recommended configuration per NIST SP 800-38D.
			const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH))

			const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
				currentKey.key,
				plaintext as unknown as ArrayBuffer,
			)

			const payload: EncryptedPayload = {
				v: this.currentVersion,
				iv: toBase64(iv),
				ct: toBase64(new Uint8Array(ciphertextBuffer)),
				alg: 'aes-256-gcm',
			}

			// Wrap in an object with the encrypted marker so we can detect it later
			return {
				[ENCRYPTED_MARKER]: true,
				...payload,
			}
		} catch (cause) {
			if (cause instanceof EncryptionError) {
				throw cause
			}
			throw new EncryptionError(
				`Failed to encrypt operation ${fieldName} field. Ensure the encryption key is valid and crypto.subtle is available.`,
				{
					operationId,
					fieldName,
					cause: cause instanceof Error ? cause.message : String(cause),
				},
			)
		}
	}

	private async decryptField(
		field: Record<string, unknown> | null,
		operationId: string,
		fieldName: string,
	): Promise<Record<string, unknown> | null> {
		if (field === null) {
			return null
		}

		// Pass through unencrypted fields (backward compatibility / mixed mode)
		if (!isEncryptedPayload(field)) {
			return field
		}

		const payload = field as unknown as EncryptedPayload & { [ENCRYPTED_MARKER]: true }

		const keyVersion = payload.v
		const key = this.keys.get(keyVersion)

		if (!key) {
			throw new DecryptionError(
				`No encryption key available for version ${keyVersion}. This operation was encrypted with a key that is not registered. If you rotated keys, ensure all previous key versions are provided.`,
				{ operationId, fieldName, keyVersion, availableVersions: [...this.keys.keys()] },
			)
		}

		if (payload.alg !== 'aes-256-gcm') {
			throw new DecryptionError(
				`Unsupported encryption algorithm: "${payload.alg}". Only "aes-256-gcm" is supported. Update your @korajs/sync package.`,
				{ operationId, fieldName, algorithm: payload.alg },
			)
		}

		try {
			const iv = fromBase64(payload.iv)
			const ciphertext = fromBase64(payload.ct)

			const plaintextBuffer = await globalThis.crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
				key.key,
				ciphertext as unknown as ArrayBuffer,
			)

			const json = new TextDecoder().decode(plaintextBuffer)
			const parsed: unknown = JSON.parse(json)

			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new DecryptionError(`Decrypted ${fieldName} is not a valid record object.`, {
					operationId,
					fieldName,
				})
			}

			return parsed as Record<string, unknown>
		} catch (cause) {
			if (cause instanceof DecryptionError) {
				throw cause
			}
			throw new DecryptionError(
				`Failed to decrypt operation ${fieldName} field. This may indicate a wrong encryption key, tampered ciphertext, or corrupted data.`,
				{
					operationId,
					fieldName,
					keyVersion,
					cause: cause instanceof Error ? cause.message : String(cause),
				},
			)
		}
	}
}

// --- Utility functions ---

/**
 * Check if a field value contains an encrypted payload.
 *
 * @param field - An operation's `data` or `previousData` field
 * @returns true if the field contains an encrypted payload
 */
export function isEncryptedPayload(field: Record<string, unknown> | null): boolean {
	if (field === null || typeof field !== 'object') {
		return false
	}
	return (
		field[ENCRYPTED_MARKER] === true &&
		typeof field.v === 'number' &&
		typeof field.iv === 'string' &&
		typeof field.ct === 'string' &&
		typeof field.alg === 'string'
	)
}

// --- Base64 helpers ---

/**
 * Encode a Uint8Array to a base64 string.
 * Uses standard base64 (not URL-safe) for compatibility with JSON serialization.
 */
function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary)
}

/**
 * Decode a base64 string to a Uint8Array.
 */
function fromBase64(str: string): Uint8Array {
	const binary = atob(str)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}
