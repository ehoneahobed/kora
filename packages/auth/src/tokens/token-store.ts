import type { AuthTokens } from '../types'

/** Default key used for localStorage persistence. */
const DEFAULT_STORAGE_KEY = 'kora_auth_tokens'

/**
 * Minimal storage interface matching the subset of the Web Storage API
 * that TokenStore needs. This allows both localStorage and in-memory
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
			// Probe that read/write actually works (some browsers throw on access)
			const testKey = '__kora_storage_test__'
			storage.setItem(testKey, '1')
			storage.removeItem(testKey)
			return storage
		}
	} catch {
		// localStorage exists but access is denied (e.g., private mode in some browsers)
	}
	return null
}

/**
 * Client-side token storage for Kora auth tokens.
 *
 * Persists tokens to localStorage when available, falling back to in-memory
 * storage in environments where localStorage is unavailable (Node.js, SSR,
 * restricted browser contexts). Encrypted storage is planned for Phase 2.
 *
 * All operations are synchronous since both localStorage and in-memory
 * storage are synchronous.
 *
 * @example
 * ```typescript
 * const store = new TokenStore()
 *
 * // After login
 * store.saveTokens({ accessToken: '...', refreshToken: '...' })
 *
 * // Before API calls
 * const token = store.getAccessToken()
 *
 * // On logout
 * store.clearTokens()
 * ```
 */
export class TokenStore {
	private readonly storageKey: string
	private readonly storage: SimpleStorage

	/**
	 * Creates a new TokenStore instance.
	 *
	 * @param storageKey - The key under which tokens are stored. Defaults to 'kora_auth_tokens'.
	 *   Use different keys if your app runs multiple Kora instances with separate auth.
	 */
	constructor(storageKey?: string) {
		this.storageKey = storageKey ?? DEFAULT_STORAGE_KEY
		this.storage = tryGetLocalStorage() ?? new MemoryStorage()
	}

	/**
	 * Save tokens to persistent storage.
	 *
	 * Overwrites any previously stored tokens. The tokens are serialized
	 * as JSON. Only the `accessToken`, `refreshToken`, and optional
	 * `deviceCredential` fields are persisted.
	 *
	 * @param tokens - The token set to store
	 */
	saveTokens(tokens: AuthTokens): void {
		const serialized: AuthTokens = {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
		}
		if (tokens.deviceCredential !== undefined) {
			serialized.deviceCredential = tokens.deviceCredential
		}
		this.storage.setItem(this.storageKey, JSON.stringify(serialized))
	}

	/**
	 * Load tokens from storage.
	 *
	 * @returns The stored {@link AuthTokens}, or null if no tokens have been saved
	 */
	loadTokens(): AuthTokens | null {
		const raw = this.storage.getItem(this.storageKey)
		if (raw === null) {
			return null
		}

		try {
			const parsed: unknown = JSON.parse(raw)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return null
			}
			const record = parsed as Record<string, unknown>

			// Validate required fields are present and are strings
			if (
				typeof record['accessToken'] !== 'string'
				|| typeof record['refreshToken'] !== 'string'
			) {
				return null
			}

			const tokens: AuthTokens = {
				accessToken: record['accessToken'],
				refreshToken: record['refreshToken'],
			}

			if (typeof record['deviceCredential'] === 'string') {
				tokens.deviceCredential = record['deviceCredential']
			}

			return tokens
		} catch {
			// Corrupted data in storage; treat as empty
			return null
		}
	}

	/**
	 * Clear all stored tokens.
	 *
	 * Call this on logout to remove credentials from persistent storage.
	 */
	clearTokens(): void {
		this.storage.removeItem(this.storageKey)
	}

	/**
	 * Get the current access token.
	 *
	 * Returns the raw token string without validating expiration.
	 * The caller is responsible for checking whether the token is
	 * still valid and initiating a refresh if needed.
	 *
	 * @returns The access token string, or null if no tokens are stored
	 */
	getAccessToken(): string | null {
		const tokens = this.loadTokens()
		return tokens?.accessToken ?? null
	}

	/**
	 * Get the current refresh token.
	 *
	 * @returns The refresh token string, or null if no tokens are stored
	 */
	getRefreshToken(): string | null {
		const tokens = this.loadTokens()
		return tokens?.refreshToken ?? null
	}
}
