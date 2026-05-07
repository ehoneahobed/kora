import { randomBytes, pbkdf2, timingSafeEqual } from 'node:crypto'

/** Number of PBKDF2 iterations. 600,000 per OWASP 2023 recommendations for SHA-512. */
const PBKDF2_ITERATIONS = 600_000

/** Digest algorithm used by PBKDF2. */
const PBKDF2_DIGEST = 'sha512'

/** Length of the derived key in bytes. */
const KEY_LENGTH = 64

/** Length of the random salt in bytes. */
const SALT_LENGTH = 32

interface HashResult {
	/** Hex-encoded PBKDF2 derived key. */
	hash: string
	/** Hex-encoded random salt used during hashing. */
	salt: string
}

/**
 * Hashes a password using PBKDF2 with a cryptographically random salt.
 *
 * Uses SHA-512 with 600,000 iterations and a 32-byte random salt,
 * producing a 64-byte derived key. Both the hash and salt are returned
 * as hex-encoded strings for storage.
 *
 * @param password - The plaintext password to hash
 * @returns The hex-encoded hash and salt
 *
 * @example
 * ```typescript
 * const { hash, salt } = await hashPassword('my-secret-password')
 * // Store hash and salt in the database
 * ```
 */
export async function hashPassword(password: string): Promise<HashResult> {
	const salt = randomBytes(SALT_LENGTH)

	const derivedKey = await pbkdf2Async(
		password,
		salt,
		PBKDF2_ITERATIONS,
		KEY_LENGTH,
		PBKDF2_DIGEST,
	)

	return {
		hash: derivedKey.toString('hex'),
		salt: salt.toString('hex'),
	}
}

/**
 * Verifies a plaintext password against a stored hash and salt using
 * timing-safe comparison to prevent timing attacks.
 *
 * Re-derives the key from the password and salt using the same PBKDF2
 * parameters, then compares the result against the stored hash using
 * `crypto.timingSafeEqual` to avoid leaking information through
 * response timing.
 *
 * @param password - The plaintext password to verify
 * @param hash - The hex-encoded hash to compare against
 * @param salt - The hex-encoded salt that was used to produce the hash
 * @returns `true` if the password matches, `false` otherwise
 *
 * @example
 * ```typescript
 * const isValid = await verifyPassword('my-secret-password', storedHash, storedSalt)
 * if (isValid) {
 *   // Grant access
 * }
 * ```
 */
export async function verifyPassword(
	password: string,
	hash: string,
	salt: string,
): Promise<boolean> {
	const saltBuffer = Buffer.from(salt, 'hex')

	const derivedKey = await pbkdf2Async(
		password,
		saltBuffer,
		PBKDF2_ITERATIONS,
		KEY_LENGTH,
		PBKDF2_DIGEST,
	)

	const hashBuffer = Buffer.from(hash, 'hex')

	// Both buffers must be the same length for timingSafeEqual.
	// If the stored hash has an unexpected length, reject rather than throw.
	if (derivedKey.length !== hashBuffer.length) {
		return false
	}

	return timingSafeEqual(derivedKey, hashBuffer)
}

/**
 * Promisified wrapper around Node.js `crypto.pbkdf2`.
 * The callback-based API delegates hashing to libuv's thread pool,
 * avoiding blocking the event loop during the 600,000 iterations.
 */
function pbkdf2Async(
	password: string,
	salt: Buffer,
	iterations: number,
	keyLength: number,
	digest: string,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		pbkdf2(password, salt, iterations, keyLength, digest, (err, derivedKey) => {
			if (err) {
				reject(err)
			} else {
				resolve(derivedKey)
			}
		})
	})
}
