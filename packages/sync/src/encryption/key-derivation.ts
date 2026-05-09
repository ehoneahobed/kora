import { SyncError } from '@korajs/core'
import type { VersionedKey } from './types'

/**
 * Thrown when key derivation fails.
 */
export class KeyDerivationError extends SyncError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, errorType: 'KEY_DERIVATION_ERROR' })
		this.name = 'KeyDerivationError'
	}
}

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
	if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle === 'undefined') {
		throw new KeyDerivationError(
			'Web Crypto API (crypto.subtle) is not available in this environment. ' +
				'Sync encryption requires crypto.subtle, which is available in modern browsers and Node.js 20+.',
		)
	}
}

/**
 * Generates a cryptographically random salt for PBKDF2 key derivation.
 *
 * @returns A random 32-byte Uint8Array
 * @throws {KeyDerivationError} If crypto.getRandomValues is unavailable
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
 * to derive a 256-bit key. The derived key is deterministic: the same passphrase
 * and salt always produce the same key.
 *
 * @param passphrase - The user's passphrase (must be non-empty)
 * @param salt - Optional salt bytes. If omitted, a random 32-byte salt is generated.
 * @returns The derived CryptoKey and the salt used
 * @throws {KeyDerivationError} If the passphrase is empty, crypto is unavailable, or derivation fails
 *
 * @example
 * ```typescript
 * // First time: derive key with a new salt
 * const { key, salt } = await deriveKey('my-secure-passphrase')
 *
 * // Later: re-derive the same key using the stored salt
 * const { key: sameKey } = await deriveKey('my-secure-passphrase', salt)
 * ```
 */
export async function deriveKey(
	passphrase: string,
	salt?: Uint8Array,
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
	assertCryptoAvailable()

	if (passphrase.length === 0) {
		throw new KeyDerivationError(
			'Passphrase must not be empty. Provide a non-empty string for encryption key derivation.',
		)
	}

	const usedSalt = salt ?? generateSalt()

	try {
		// Import the passphrase as raw key material for PBKDF2
		const passphraseBytes = new TextEncoder().encode(passphrase)
		const baseKey = await globalThis.crypto.subtle.importKey(
			'raw',
			passphraseBytes,
			'PBKDF2',
			false,
			['deriveBits', 'deriveKey'],
		)

		// Derive an AES-256-GCM key using PBKDF2 with SHA-256
		const derivedKey = await globalThis.crypto.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt: usedSalt as unknown as ArrayBuffer,
				iterations: PBKDF2_ITERATIONS,
				hash: 'SHA-256',
			},
			baseKey,
			{ name: 'AES-GCM', length: DERIVED_KEY_LENGTH },
			// extractable: true so the derived key can be exported for testing/debugging
			true,
			['encrypt', 'decrypt'],
		)

		return { key: derivedKey, salt: usedSalt }
	} catch (cause) {
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

/**
 * Derives a versioned encryption key from a passphrase.
 *
 * Wraps {@link deriveKey} with a version number for key rotation support.
 * When the passphrase changes, create a new versioned key with a higher
 * version number.
 *
 * @param passphrase - The user's passphrase
 * @param version - Key version number (must be a positive integer)
 * @param salt - Optional salt bytes. If omitted, a random salt is generated.
 * @returns A {@link VersionedKey} containing the key, version, and salt
 * @throws {KeyDerivationError} If parameters are invalid or derivation fails
 */
export async function deriveVersionedKey(
	passphrase: string,
	version: number,
	salt?: Uint8Array,
): Promise<VersionedKey> {
	if (!Number.isInteger(version) || version < 1) {
		throw new KeyDerivationError(`Key version must be a positive integer, received: ${version}`, {
			version,
		})
	}

	const { key, salt: usedSalt } = await deriveKey(passphrase, salt)

	return { version, key, salt: usedSalt }
}
