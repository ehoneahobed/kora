import { KoraError } from '@korajs/core'

// --- Encryption-specific errors ---

/**
 * Thrown when an encryption or decryption operation fails.
 * Includes context about what went wrong to aid debugging.
 */
export class EncryptionError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'ENCRYPTION_ERROR', context)
		this.name = 'EncryptionError'
	}
}

/**
 * Thrown when the Web Crypto API is not available in the current environment.
 * The encryption module requires `crypto.subtle` for AES-256-GCM operations.
 */
export class CryptoUnavailableError extends KoraError {
	constructor() {
		super(
			'Web Crypto API (crypto.subtle) is not available in this environment. ' +
				'Database encryption requires crypto.subtle, which is available in modern browsers and Node.js 20+. ' +
				'If running in SSR, ensure your runtime provides the Web Crypto API.',
			'CRYPTO_UNAVAILABLE',
		)
		this.name = 'CryptoUnavailableError'
	}
}

// --- Internal helpers ---

/** AES-GCM algorithm name, used throughout the module. */
const AES_GCM = 'AES-GCM' as const

/** AES-256 key length in bits. */
const AES_KEY_LENGTH = 256

/** GCM initialization vector length in bytes (96 bits / 12 bytes is the recommended size). */
const IV_LENGTH = 12

/**
 * Asserts that `crypto.subtle` is available, throwing a clear error if not.
 */
function assertCryptoAvailable(): void {
	if (
		typeof globalThis.crypto === 'undefined' ||
		typeof globalThis.crypto.subtle === 'undefined'
	) {
		throw new CryptoUnavailableError()
	}
}

// --- Public API ---

/**
 * Generates a random 256-bit AES-GCM encryption key.
 *
 * The key is extractable so it can be exported for persistence (e.g., encrypted
 * with a passphrase-derived key and stored locally). Use {@link exportKey} to
 * get the raw bytes.
 *
 * @returns A CryptoKey for AES-256-GCM encryption and decryption
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {EncryptionError} If key generation fails
 *
 * @example
 * ```typescript
 * const key = await generateEncryptionKey()
 * // key can be used with encryptData() and decryptData()
 * ```
 */
export async function generateEncryptionKey(): Promise<CryptoKey> {
	assertCryptoAvailable()

	try {
		const key = await globalThis.crypto.subtle.generateKey(
			{ name: AES_GCM, length: AES_KEY_LENGTH },
			// extractable: true so the key can be exported and persisted
			true,
			['encrypt', 'decrypt'],
		)
		return key
	} catch (cause) {
		throw new EncryptionError(
			'Failed to generate AES-256-GCM encryption key. ' +
				'Ensure the runtime supports the AES-GCM algorithm.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Encrypts data using AES-256-GCM with a randomly generated IV.
 *
 * Each call generates a fresh 12-byte IV, ensuring that encrypting the same
 * plaintext twice produces different ciphertext. The IV must be stored alongside
 * the ciphertext for decryption.
 *
 * AES-GCM provides both confidentiality and integrity: the ciphertext includes
 * an authentication tag that detects tampering.
 *
 * @param key - An AES-256-GCM CryptoKey (from {@link generateEncryptionKey} or {@link importKey})
 * @param plaintext - The data to encrypt
 * @returns An object containing the ciphertext and the IV used for encryption
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {EncryptionError} If encryption fails
 *
 * @example
 * ```typescript
 * const key = await generateEncryptionKey()
 * const data = new TextEncoder().encode('sensitive data')
 * const { ciphertext, iv } = await encryptData(key, data)
 * // Store ciphertext and iv together; both are needed for decryption
 * ```
 */
export async function encryptData(
	key: CryptoKey,
	plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
	assertCryptoAvailable()

	// Generate a fresh random IV for each encryption operation.
	// AES-GCM with a 96-bit IV is the recommended configuration per NIST SP 800-38D.
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH))

	try {
		const ciphertextBuffer = await globalThis.crypto.subtle.encrypt(
			{ name: AES_GCM, iv: iv as unknown as ArrayBuffer },
			key,
			plaintext as unknown as ArrayBuffer,
		)
		return {
			ciphertext: new Uint8Array(ciphertextBuffer),
			iv,
		}
	} catch (cause) {
		throw new EncryptionError(
			'Failed to encrypt data with AES-256-GCM. ' +
				'Ensure the key is a valid AES-GCM CryptoKey with "encrypt" usage.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Decrypts AES-256-GCM encrypted data.
 *
 * The IV must be the same one that was used during encryption. AES-GCM
 * authenticates the ciphertext, so any tampering will cause decryption to fail.
 *
 * @param key - The AES-256-GCM CryptoKey used for encryption
 * @param ciphertext - The encrypted data (from {@link encryptData})
 * @param iv - The initialization vector used during encryption (from {@link encryptData})
 * @returns The decrypted plaintext
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {EncryptionError} If decryption fails (wrong key, tampered ciphertext, or wrong IV)
 *
 * @example
 * ```typescript
 * const decrypted = await decryptData(key, ciphertext, iv)
 * const text = new TextDecoder().decode(decrypted)
 * ```
 */
export async function decryptData(
	key: CryptoKey,
	ciphertext: Uint8Array,
	iv: Uint8Array,
): Promise<Uint8Array> {
	assertCryptoAvailable()

	try {
		const plaintextBuffer = await globalThis.crypto.subtle.decrypt(
			{ name: AES_GCM, iv: iv as unknown as ArrayBuffer },
			key,
			ciphertext as unknown as ArrayBuffer,
		)
		return new Uint8Array(plaintextBuffer)
	} catch (cause) {
		throw new EncryptionError(
			'Failed to decrypt data with AES-256-GCM. ' +
				'This may indicate a wrong key, tampered ciphertext, or incorrect IV.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Exports an AES-256-GCM CryptoKey to its raw byte representation.
 *
 * The raw key is 32 bytes (256 bits). This is useful for persisting the key
 * (e.g., encrypting it with a passphrase-derived key before storing to disk).
 *
 * **Security warning:** Raw key bytes are sensitive material. Never log them,
 * store them in plaintext, or transmit them over the network without encryption.
 *
 * @param key - An extractable AES-256-GCM CryptoKey
 * @returns The raw key bytes (32 bytes for AES-256)
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {EncryptionError} If the key export fails (e.g., key is not extractable)
 *
 * @example
 * ```typescript
 * const key = await generateEncryptionKey()
 * const rawBytes = await exportKey(key)
 * // rawBytes.length === 32
 * ```
 */
export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
	assertCryptoAvailable()

	try {
		const rawBuffer = await globalThis.crypto.subtle.exportKey('raw', key)
		return new Uint8Array(rawBuffer)
	} catch (cause) {
		throw new EncryptionError(
			'Failed to export AES-256-GCM key. ' +
				'The key may not be extractable. Only keys generated with extractable=true can be exported.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Imports raw key bytes into an AES-256-GCM CryptoKey.
 *
 * The input must be exactly 32 bytes (256 bits). The imported key is extractable
 * and supports both encrypt and decrypt operations.
 *
 * @param rawKey - Raw key bytes (must be exactly 32 bytes for AES-256)
 * @returns A CryptoKey for AES-256-GCM operations
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {EncryptionError} If the raw key is invalid or import fails
 *
 * @example
 * ```typescript
 * const rawBytes = new Uint8Array(32) // previously exported key bytes
 * const key = await importKey(rawBytes)
 * // key can now be used with encryptData() and decryptData()
 * ```
 */
export async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
	assertCryptoAvailable()

	if (rawKey.length !== 32) {
		throw new EncryptionError(
			`Invalid key length: expected 32 bytes (256 bits) for AES-256, but received ${rawKey.length} bytes.`,
			{ actualLength: rawKey.length, expectedLength: 32 },
		)
	}

	try {
		const key = await globalThis.crypto.subtle.importKey(
			'raw',
			rawKey as unknown as ArrayBuffer,
			{ name: AES_GCM, length: AES_KEY_LENGTH },
			true,
			['encrypt', 'decrypt'],
		)
		return key
	} catch (cause) {
		throw new EncryptionError(
			'Failed to import raw key bytes as AES-256-GCM key. ' +
				'Ensure the key material is valid.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}
