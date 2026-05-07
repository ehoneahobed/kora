import { KoraError } from '@korajs/core'

// --- Key derivation errors ---

/**
 * Thrown when a key derivation operation fails.
 */
export class KeyDerivationError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'KEY_DERIVATION_ERROR', context)
		this.name = 'KeyDerivationError'
	}
}

// --- Internal helpers ---

/** Salt length in bytes. 32 bytes (256 bits) provides sufficient randomness. */
const SALT_LENGTH = 32

/**
 * PBKDF2 iteration count. 600,000 iterations is the OWASP-recommended minimum
 * for SHA-256 as of 2024, providing strong resistance against brute-force attacks.
 */
const PBKDF2_ITERATIONS = 600_000

/** Derived key length in bits (AES-256). */
const DERIVED_KEY_LENGTH = 256

/**
 * Asserts that `crypto.subtle` is available, throwing a clear error if not.
 */
function assertCryptoAvailable(): void {
	if (
		typeof globalThis.crypto === 'undefined' ||
		typeof globalThis.crypto.subtle === 'undefined'
	) {
		throw new KeyDerivationError(
			'Web Crypto API (crypto.subtle) is not available in this environment. ' +
				'Key derivation requires crypto.subtle, which is available in modern browsers and Node.js 20+.',
		)
	}
}

// --- Public API ---

/**
 * Generates a cryptographically random 32-byte salt for key derivation.
 *
 * Each call returns a unique salt. The salt should be stored alongside the
 * encrypted data so that the same passphrase can reproduce the same key later.
 *
 * @returns A random 32-byte Uint8Array
 *
 * @example
 * ```typescript
 * const salt = generateSalt()
 * // salt.length === 32
 * ```
 */
export function generateSalt(): Uint8Array {
	if (typeof globalThis.crypto === 'undefined') {
		throw new KeyDerivationError(
			'Web Crypto API (crypto) is not available. Cannot generate random salt.',
		)
	}

	return globalThis.crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
}

/**
 * Derives an AES-256-GCM encryption key from a passphrase using PBKDF2.
 *
 * Uses PBKDF2 with SHA-256 and 600,000 iterations (OWASP-recommended minimum)
 * to derive a 256-bit key from the passphrase. The derived key can be used with
 * the database encryption functions ({@link encryptData}, {@link decryptData}).
 *
 * If no salt is provided, a random 32-byte salt is generated. The salt must be
 * persisted alongside the encrypted data so the key can be re-derived later.
 *
 * **Deterministic:** The same passphrase and salt always produce the same key.
 * This is essential for decryption: the user enters their passphrase, the stored
 * salt is used, and the identical key is re-derived to decrypt the data.
 *
 * @param passphrase - The user's passphrase (any non-empty string)
 * @param salt - Optional salt bytes. If omitted, a random 32-byte salt is generated.
 * @returns An object containing the derived CryptoKey and the salt used
 * @throws {KeyDerivationError} If the passphrase is empty, crypto is unavailable, or derivation fails
 *
 * @example
 * ```typescript
 * // First time: derive key with a new salt
 * const { key, salt } = await deriveEncryptionKey('my-secure-passphrase')
 * // Store the salt alongside the encrypted data
 *
 * // Later: re-derive the same key using the stored salt
 * const { key: sameKey } = await deriveEncryptionKey('my-secure-passphrase', salt)
 * ```
 */
export async function deriveEncryptionKey(
	passphrase: string,
	salt?: Uint8Array,
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
	assertCryptoAvailable()

	if (passphrase.length === 0) {
		throw new KeyDerivationError(
			'Passphrase must not be empty. Provide a non-empty string for key derivation.',
		)
	}

	const usedSalt = salt ?? generateSalt()

	try {
		// Step 1: Import the passphrase as raw key material for PBKDF2
		const passphraseBytes = new TextEncoder().encode(passphrase)
		const baseKey = await globalThis.crypto.subtle.importKey(
			'raw',
			passphraseBytes,
			'PBKDF2',
			false,
			['deriveBits', 'deriveKey'],
		)

		// Step 2: Derive an AES-256-GCM key using PBKDF2 with SHA-256
		const derivedKey = await globalThis.crypto.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt: usedSalt as unknown as ArrayBuffer,
				iterations: PBKDF2_ITERATIONS,
				hash: 'SHA-256',
			},
			baseKey,
			{ name: 'AES-GCM', length: DERIVED_KEY_LENGTH },
			// extractable: true so the derived key can be exported if needed
			true,
			['encrypt', 'decrypt'],
		)

		return { key: derivedKey, salt: usedSalt }
	} catch (cause) {
		// Re-throw KeyDerivationError as-is (e.g., from assertCryptoAvailable)
		if (cause instanceof KeyDerivationError) {
			throw cause
		}

		throw new KeyDerivationError(
			'Failed to derive encryption key from passphrase using PBKDF2. ' +
				'Ensure the runtime supports PBKDF2 with SHA-256.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}
