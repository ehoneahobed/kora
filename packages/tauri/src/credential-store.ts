import type { InvokeFn } from './tauri-sqlite-adapter'

/**
 * Key-value storage for sign-in credentials. Structurally the `AuthKeyValueStorage` that
 * `createAuthTokenStorage` from `@korajs/auth` takes.
 */
export interface TauriCredentialStore {
	getItem(key: string): Promise<string | null>
	setItem(key: string, value: string): Promise<void>
	removeItem(key: string): Promise<void>
	/**
	 * Where credentials are kept: `keychain` (the operating system's credential store),
	 * `fallback` (WebView storage, because this platform has no usable credential store), or
	 * `unknown` before the first access.
	 */
	readonly location: 'keychain' | 'fallback' | 'unknown'
}

/** Synchronous key-value storage the store falls back to, `localStorage` by default. */
export interface FallbackCredentialStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

export interface TauriCredentialStoreOptions {
	/** Tauri's `invoke`. Defaults to the one from `@tauri-apps/api/core`. */
	invoke?: InvokeFn
	/**
	 * Used where the platform has no usable credential store (mobile today, a browser build of
	 * the app, a Linux desktop without a Secret Service), and the source of credentials an
	 * earlier version of the app saved there, which move to the keychain on first read.
	 * Defaults to `window.localStorage`; `null` keeps credentials in memory only.
	 */
	fallback?: FallbackCredentialStorage | null
	/** Called once if the store falls back, with the reason. Defaults to `console.warn`. */
	onFallback?: (reason: string) => void
}

const PLUGIN = 'plugin:kora-sqlite|'
const UNAVAILABLE = 'CREDENTIAL_STORE_UNAVAILABLE'

/**
 * Keeps sign-in credentials in the operating system's credential store: Keychain on macOS,
 * Credential Manager on Windows, the Secret Service on Linux, under the app's bundle identifier.
 * Other processes and web content can't read them the way they can read WebView storage.
 *
 * @example
 * ```typescript
 * import { createAuthTokenStorage, createKoraAuth } from '@korajs/auth'
 * import { createTauriCredentialStore } from '@korajs/tauri'
 *
 * const authClient = createKoraAuth({
 *   serverUrl: 'https://sync.example.com',
 *   storage: createAuthTokenStorage({ store: createTauriCredentialStore(), durability: 'durable' }),
 * })
 * ```
 */
export function createTauriCredentialStore(
	options: TauriCredentialStoreOptions = {},
): TauriCredentialStore {
	const memory = new Map<string, string>()
	const fallback: FallbackCredentialStorage =
		options.fallback === undefined
			? (defaultFallback() ?? memoryStorage(memory))
			: (options.fallback ?? memoryStorage(memory))
	const warn = options.onFallback ?? ((reason: string) => console.warn(`[kora] ${reason}`))
	// This process is the only writer of the app's entries, so reads after the first are served
	// from here instead of a keychain round trip.
	const cache = new Map<string, string | null>()
	let location: TauriCredentialStore['location'] = 'unknown'
	let invokePromise: Promise<InvokeFn | null> | null = null

	function resolveInvoke(): Promise<InvokeFn | null> {
		if (options.invoke) return Promise.resolve(options.invoke)
		invokePromise ??= import('@tauri-apps/api/core')
			.then(({ invoke }) => invoke as InvokeFn)
			.catch(() => null)
		return invokePromise
	}

	function fallBack(reason: string): void {
		if (location === 'fallback') return
		location = 'fallback'
		cache.clear()
		warn(`Sign-in credentials are kept in WebView storage: ${reason}`)
	}

	/** Runs a keychain command; `null` means the keychain is unavailable here. */
	async function keychain<T>(
		command: string,
		args: Record<string, unknown>,
	): Promise<{ readonly value: T } | null> {
		if (location === 'fallback') return null
		const invoke = await resolveInvoke()
		if (!invoke) {
			fallBack('not running inside Tauri.')
			return null
		}
		try {
			const value = await invoke<T>(`${PLUGIN}${command}`, args)
			location = 'keychain'
			return { value }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			// Unavailable here, or an app whose capabilities or plugin predate the commands.
			if (
				message.startsWith(UNAVAILABLE) ||
				/not allowed|not found|unknown command/i.test(message)
			) {
				fallBack(message)
				return null
			}
			throw new Error(`Credential store ${command} failed: ${message}`)
		}
	}

	return {
		get location() {
			return location
		},

		async getItem(key) {
			if (cache.has(key)) return cache.get(key) ?? null
			const read = await keychain<string | null>('credential_get', { key })
			if (!read) return fallback.getItem(key)
			const stored = read.value ?? null
			if (stored !== null) {
				cache.set(key, stored)
				return stored
			}
			// Saved by an earlier version of the app, or before the keychain was available: move it.
			const earlier = fallback.getItem(key)
			if (earlier !== null && (await keychain('credential_set', { key, value: earlier }))) {
				fallback.removeItem(key)
			}
			cache.set(key, earlier)
			return earlier
		},

		async setItem(key, value) {
			if (!(await keychain('credential_set', { key, value }))) {
				fallback.setItem(key, value)
				return
			}
			cache.set(key, value)
			fallback.removeItem(key)
		},

		async removeItem(key) {
			cache.delete(key)
			await keychain('credential_delete', { key })
			fallback.removeItem(key)
		},
	}
}

function defaultFallback(): FallbackCredentialStorage | null {
	try {
		const storage = (globalThis as { localStorage?: FallbackCredentialStorage }).localStorage
		if (storage) return storage
	} catch {
		// storage blocked
	}
	return null
}

function memoryStorage(map: Map<string, string>): FallbackCredentialStorage {
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value)
		},
		removeItem: (key) => {
			map.delete(key)
		},
	}
}
