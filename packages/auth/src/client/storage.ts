import type { AuthTokenStorage } from './auth-client'

type MaybePromise<T> = T | Promise<T>

/**
 * Minimal key-value credential storage interface used by Kora auth adapters.
 *
 * This intentionally matches the shape of secure stores across runtimes:
 * browser Storage, Tauri secure storage plugins, Expo SecureStore, iOS Keychain,
 * Android Keystore wrappers, and encrypted desktop stores.
 */
export interface AuthKeyValueStorage {
	getItem(key: string): MaybePromise<string | null>
	setItem(key: string, value: string): MaybePromise<void>
	removeItem(key: string): MaybePromise<void>
}

export interface AuthTokenStorageOptions {
	/** Backing credential store. */
	store: AuthKeyValueStorage
	/** Storage key prefix. Defaults to `kora_auth`. */
	prefix?: string
}

/**
 * Creates an `AuthTokenStorage` adapter from a runtime key-value store.
 *
 * Use this with platform credential stores instead of wiring `AuthClient`
 * directly to browser localStorage in desktop and mobile apps.
 */
export function createAuthTokenStorage(options: AuthTokenStorageOptions): AuthTokenStorage {
	const prefix = options.prefix ?? 'kora_auth'
	const accessKey = `${prefix}_access_token`
	const refreshKey = `${prefix}_refresh_token`
	const store = options.store

	return {
		getAccessToken: () => store.getItem(accessKey),
		getRefreshToken: () => store.getItem(refreshKey),
		async setTokens(accessToken: string, refreshToken: string): Promise<void> {
			await store.setItem(accessKey, accessToken)
			await store.setItem(refreshKey, refreshToken)
		},
		async clear(): Promise<void> {
			await store.removeItem(accessKey)
			await store.removeItem(refreshKey)
		},
	}
}

/**
 * Creates an in-memory token storage adapter.
 *
 * Useful for tests, demos, and SSR. Production desktop and mobile apps should
 * prefer a secure platform-backed store.
 */
export function createMemoryAuthTokenStorage(): AuthTokenStorage {
	let accessToken: string | null = null
	let refreshToken: string | null = null

	return {
		getAccessToken: () => accessToken,
		getRefreshToken: () => refreshToken,
		setTokens(access: string, refresh: string): void {
			accessToken = access
			refreshToken = refresh
		},
		clear(): void {
			accessToken = null
			refreshToken = null
		},
	}
}

/**
 * Adapts Web Storage-compatible APIs such as `localStorage` or `sessionStorage`.
 */
export function createWebStorageAuthTokenStorage(
	storage: Storage,
	prefix?: string,
): AuthTokenStorage {
	return createAuthTokenStorage({
		prefix,
		store: {
			getItem: (key) => storage.getItem(key),
			setItem: (key, value) => {
				storage.setItem(key, value)
			},
			removeItem: (key) => {
				storage.removeItem(key)
			},
		},
	})
}
