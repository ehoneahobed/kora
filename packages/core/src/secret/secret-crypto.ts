/**
 * Field-level cryptography for `secret` fields.
 *
 * Two protection modes, matching the two ways secrets are used:
 * - `encrypted`: reversible AES-256-GCM (tokens, API keys — decrypt to use).
 * - `hashed`: one-way PBKDF2-SHA-256 with a random salt (passwords — verify only).
 *
 * These primitives use only the standard WebCrypto API so they live in
 * `@korajs/core` with no dependency on `@korajs/auth`; a `secret` field is
 * therefore self-contained. Higher-level key management composes on top.
 */

const PBKDF2_ITERATIONS = 210_000
const SALT_BYTES = 16
const IV_BYTES = 12
const HASH_BYTES = 32

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
		throw new Error('Invalid hex string')
	}
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}

function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n)
	globalThis.crypto.getRandomValues(out)
	return out
}

/** Constant-time comparison of two equal-length byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false
	}
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] as number) ^ (b[i] as number)
	}
	return diff === 0
}

async function deriveAesKey(secretKey: string, salt: Uint8Array): Promise<CryptoKey> {
	const baseKey = await globalThis.crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secretKey),
		'PBKDF2',
		false,
		['deriveKey'],
	)
	return globalThis.crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	)
}

/**
 * Encrypt a secret's plaintext with AES-256-GCM under a key derived from
 * `secretKey`. The returned string bundles the salt, IV, and ciphertext (all hex,
 * dot-separated) so it is self-describing and safe to store and sync.
 *
 * @param plaintext - The secret value to protect
 * @param secretKey - The key material (from a key provider), never stored
 * @returns An opaque `v1.salt.iv.ciphertext` string
 */
export async function encryptSecret(plaintext: string, secretKey: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES)
	const iv = randomBytes(IV_BYTES)
	const key = await deriveAesKey(secretKey, salt)
	const ciphertext = await globalThis.crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as BufferSource },
		key,
		new TextEncoder().encode(plaintext),
	)
	return `v1.${toHex(salt)}.${toHex(iv)}.${toHex(new Uint8Array(ciphertext))}`
}

/**
 * Decrypt a value produced by {@link encryptSecret} with the same key.
 *
 * @param encrypted - The `v1.salt.iv.ciphertext` string
 * @param secretKey - The key material used to encrypt
 * @returns The original plaintext
 * @throws If the format is invalid or the key is wrong (GCM auth failure)
 */
export async function decryptSecret(encrypted: string, secretKey: string): Promise<string> {
	const parts = encrypted.split('.')
	if (parts.length !== 4 || parts[0] !== 'v1') {
		throw new Error('Invalid encrypted secret format')
	}
	const salt = fromHex(parts[1] as string)
	const iv = fromHex(parts[2] as string)
	const ciphertext = fromHex(parts[3] as string)
	const key = await deriveAesKey(secretKey, salt)
	const plaintext = await globalThis.crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: iv as BufferSource },
		key,
		ciphertext as BufferSource,
	)
	return new TextDecoder().decode(plaintext)
}

/**
 * One-way hash a secret (a password) with PBKDF2-SHA-256 and a random salt.
 * The result bundles the salt and hash so {@link verifySecret} needs nothing
 * else. There is no way to recover the plaintext from the result.
 *
 * @param plaintext - The secret value to hash
 * @returns An opaque `v1.salt.hash` string
 */
export async function hashSecret(plaintext: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES)
	const hash = await pbkdf2(plaintext, salt)
	return `v1.${toHex(salt)}.${toHex(hash)}`
}

/**
 * Verify a plaintext against a value produced by {@link hashSecret}, in constant
 * time with respect to the stored hash.
 *
 * @param plaintext - The candidate secret
 * @param stored - The `v1.salt.hash` string
 * @returns Whether the plaintext matches
 */
export async function verifySecret(plaintext: string, stored: string): Promise<boolean> {
	const parts = stored.split('.')
	if (parts.length !== 3 || parts[0] !== 'v1') {
		return false
	}
	let salt: Uint8Array
	let expected: Uint8Array
	try {
		salt = fromHex(parts[1] as string)
		expected = fromHex(parts[2] as string)
	} catch {
		return false
	}
	const actual = await pbkdf2(plaintext, salt)
	return timingSafeEqual(actual, expected)
}

async function pbkdf2(plaintext: string, salt: Uint8Array): Promise<Uint8Array> {
	const baseKey = await globalThis.crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(plaintext),
		'PBKDF2',
		false,
		['deriveBits'],
	)
	const bits = await globalThis.crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		baseKey,
		HASH_BYTES * 8,
	)
	return new Uint8Array(bits)
}
