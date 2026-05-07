import { KoraError } from '@korajs/core'
import { encryptData, decryptData } from '../encryption/database-encryption'
import type { AuthTokens } from '../types'

// --- Errors ---

/**
 * Thrown when encrypted token storage operations fail.
 * Includes context about what went wrong to aid debugging without
 * exposing sensitive key or token material.
 */
export class EncryptedTokenStoreError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'ENCRYPTED_TOKEN_STORE_ERROR', context)
		this.name = 'EncryptedTokenStoreError'
	}
}

// --- Encoding helpers ---

/**
 * Encodes a Uint8Array as a base64url string (no padding).
 * Implemented locally to avoid coupling to the device-identity module.
 *
 * @param bytes - The binary data to encode
 * @returns A base64url-encoded string without padding characters
 */
function toBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decodes a base64url string (no padding) into a Uint8Array.
 *
 * @param str - A base64url-encoded string (with or without padding)
 * @returns The decoded binary data as a Uint8Array
 */
function fromBase64Url(str: string): Uint8Array {
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
	const paddingNeeded = (4 - (base64.length % 4)) % 4
	base64 += '='.repeat(paddingNeeded)

	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

// --- Storage helpers ---

/**
 * Minimal storage interface matching the subset of the Web Storage API
 * that EncryptedTokenStore needs. Allows both localStorage and in-memory
 * implementations to be used interchangeably.
 */
interface SimpleStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

/**
 * In-memory storage fallback used when localStorage is unavailable
 * (e.g., in Node.js, SSR environments, or when storage access is denied).
 */
class MemoryStorage implements SimpleStorage {
	private store = new Map<string, string>()

	getItem(key: string): string | null {
		return this.store.get(key) ?? null
	}

	setItem(key: string, value: string): void {
		this.store.set(key, value)
	}

	removeItem(key: string): void {
		this.store.delete(key)
	}
}

/**
 * Attempts to access localStorage. Returns null if unavailable.
 *
 * localStorage may be unavailable in several scenarios:
 * - Node.js / server-side rendering (no window object)
 * - Private browsing modes with restricted storage
 * - iframe sandboxing without storage access
 * - User has disabled cookies/storage in browser settings
 */
function tryGetLocalStorage(): SimpleStorage | null {
	try {
		if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
			const storage = globalThis.localStorage as SimpleStorage
			const testKey = '__kora_encrypted_storage_test__'
			storage.setItem(testKey, '1')
			storage.removeItem(testKey)
			return storage
		}
	} catch {
		// localStorage exists but access is denied
	}
	return null
}

// --- Types ---

/** Default storage key prefix for encrypted tokens. */
const DEFAULT_STORAGE_KEY = 'kora_auth_encrypted'

/**
 * The serialized format stored in localStorage.
 * Both `iv` and `data` are base64url-encoded strings.
 */
interface EncryptedPayload {
	/** Base64url-encoded initialization vector (12 bytes for AES-GCM) */
	iv: string
	/** Base64url-encoded AES-256-GCM ciphertext of the JSON-serialized AuthTokens */
	data: string
}

/**
 * Configuration for the encrypted token store.
 */
export interface EncryptedTokenStoreConfig {
	/**
	 * Storage key prefix. Defaults to 'kora_auth_encrypted'.
	 * Use different keys if your app runs multiple Kora instances with separate auth.
	 */
	storageKey?: string
	/**
	 * The AES-256-GCM CryptoKey used to encrypt and decrypt tokens.
	 *
	 * This can be:
	 * - A key derived from a user passphrase via {@link deriveEncryptionKey}
	 * - A device-derived key (e.g., from secure hardware or biometric unlock)
	 * - A randomly generated key from {@link generateEncryptionKey}
	 *
	 * The caller is responsible for obtaining the key before constructing the store.
	 */
	key: CryptoKey
}

// --- Implementation ---

/**
 * Encrypted token store that protects auth tokens at rest.
 *
 * Addresses the security vulnerability of storing tokens in plaintext localStorage,
 * which is accessible to any JavaScript running on the page (XSS attack surface).
 * Tokens are encrypted with AES-256-GCM before being written to storage.
 *
 * The stored format is a JSON string with two base64url-encoded fields:
 * - `iv`: the 12-byte initialization vector (unique per encryption)
 * - `data`: the AES-256-GCM ciphertext of the JSON-serialized tokens
 *
 * AES-GCM provides both confidentiality (tokens are unreadable without the key)
 * and integrity (tampered ciphertext is detected and rejected).
 *
 * @example
 * ```typescript
 * import { deriveEncryptionKey } from '@korajs/auth'
 *
 * // Derive a key from the user's passphrase
 * const { key } = await deriveEncryptionKey('user-passphrase', storedSalt)
 *
 * const store = new EncryptedTokenStore({ key })
 *
 * // After login: encrypt and persist tokens
 * await store.saveTokens({ accessToken: '...', refreshToken: '...' })
 *
 * // Before API calls: decrypt and retrieve
 * const accessToken = await store.getAccessToken()
 *
 * // On logout: remove encrypted data
 * store.clearTokens()
 * ```
 */
export class EncryptedTokenStore {
	private readonly storageKey: string
	private readonly key: CryptoKey
	private readonly storage: SimpleStorage

	/**
	 * Creates a new EncryptedTokenStore instance.
	 *
	 * @param config - Configuration including the encryption key and optional storage key
	 */
	constructor(config: EncryptedTokenStoreConfig) {
		this.storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY
		this.key = config.key
		this.storage = tryGetLocalStorage() ?? new MemoryStorage()
	}

	/**
	 * Encrypt and save tokens to persistent storage.
	 *
	 * Serializes the tokens as JSON, encrypts with AES-256-GCM using a fresh
	 * random IV, then stores the result as a JSON object containing the
	 * base64url-encoded IV and ciphertext.
	 *
	 * Overwrites any previously stored tokens.
	 *
	 * @param tokens - The token set to encrypt and store
	 * @throws {EncryptedTokenStoreError} If encryption fails
	 */
	async saveTokens(tokens: AuthTokens): Promise<void> {
		// Build a clean token object with only the expected fields
		const serialized: AuthTokens = {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
		}
		if (tokens.deviceCredential !== undefined) {
			serialized.deviceCredential = tokens.deviceCredential
		}

		const plaintext = new TextEncoder().encode(JSON.stringify(serialized))

		try {
			const { ciphertext, iv } = await encryptData(this.key, plaintext)

			const payload: EncryptedPayload = {
				iv: toBase64Url(iv),
				data: toBase64Url(ciphertext),
			}

			this.storage.setItem(this.storageKey, JSON.stringify(payload))
		} catch (cause) {
			// Re-throw EncryptedTokenStoreError as-is
			if (cause instanceof EncryptedTokenStoreError) {
				throw cause
			}

			throw new EncryptedTokenStoreError(
				'Failed to encrypt and save auth tokens. ' +
					'Ensure the encryption key is a valid AES-256-GCM CryptoKey.',
				{ cause: cause instanceof Error ? cause.message : String(cause) },
			)
		}
	}

	/**
	 * Load and decrypt tokens from storage.
	 *
	 * Reads the encrypted payload from localStorage, decodes the base64url IV
	 * and ciphertext, decrypts with AES-256-GCM, and parses the resulting JSON.
	 *
	 * Returns null (without throwing) if:
	 * - No tokens have been saved
	 * - The stored data is corrupted or not valid JSON
	 * - Decryption fails (wrong key, tampered ciphertext, or wrong IV)
	 * - The decrypted data does not contain valid token fields
	 *
	 * This fail-silent design prevents decryption errors from crashing the
	 * application. The caller should treat null as "no valid tokens available"
	 * and initiate a re-authentication flow.
	 *
	 * @returns The decrypted {@link AuthTokens}, or null if unavailable or decryption fails
	 */
	async loadTokens(): Promise<AuthTokens | null> {
		const raw = this.storage.getItem(this.storageKey)
		if (raw === null) {
			return null
		}

		try {
			// Parse the stored encrypted payload
			const parsed: unknown = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return null
			}

			const record = parsed as Record<string, unknown>
			if (typeof record['iv'] !== 'string' || typeof record['data'] !== 'string') {
				return null
			}

			// Decode the base64url-encoded IV and ciphertext
			const iv = fromBase64Url(record['iv'])
			const ciphertext = fromBase64Url(record['data'])

			// Decrypt with AES-256-GCM
			const plaintextBytes = await decryptData(this.key, ciphertext, iv)
			const json = new TextDecoder().decode(plaintextBytes)

			// Parse the decrypted JSON and validate token structure
			const tokenData: unknown = JSON.parse(json)
			if (typeof tokenData !== 'object' || tokenData === null || Array.isArray(tokenData)) {
				return null
			}

			const tokenRecord = tokenData as Record<string, unknown>
			if (
				typeof tokenRecord['accessToken'] !== 'string'
				|| typeof tokenRecord['refreshToken'] !== 'string'
			) {
				return null
			}

			const tokens: AuthTokens = {
				accessToken: tokenRecord['accessToken'],
				refreshToken: tokenRecord['refreshToken'],
			}

			if (typeof tokenRecord['deviceCredential'] === 'string') {
				tokens.deviceCredential = tokenRecord['deviceCredential']
			}

			return tokens
		} catch {
			// Decryption failure, corrupted data, or JSON parse error.
			// Return null instead of throwing to allow graceful fallback
			// to re-authentication.
			return null
		}
	}

	/**
	 * Clear all stored encrypted tokens.
	 *
	 * Removes the encrypted payload from storage. This is a synchronous
	 * operation since it only removes the localStorage entry.
	 *
	 * Call this on logout to ensure no encrypted credential material
	 * remains in persistent storage.
	 */
	clearTokens(): void {
		this.storage.removeItem(this.storageKey)
	}

	/**
	 * Get the current access token by decrypting stored tokens.
	 *
	 * Returns the raw token string without validating expiration.
	 * The caller is responsible for checking whether the token is
	 * still valid and initiating a refresh if needed.
	 *
	 * @returns The decrypted access token string, or null if no valid tokens are stored
	 */
	async getAccessToken(): Promise<string | null> {
		const tokens = await this.loadTokens()
		return tokens?.accessToken ?? null
	}

	/**
	 * Get the current refresh token by decrypting stored tokens.
	 *
	 * @returns The decrypted refresh token string, or null if no valid tokens are stored
	 */
	async getRefreshToken(): Promise<string | null> {
		const tokens = await this.loadTokens()
		return tokens?.refreshToken ?? null
	}
}
