/**
 * Runtime sync server configuration.
 *
 * On first launch, the user enters their sync server URL (or organization URL).
 * This is stored in localStorage and used for all subsequent launches.
 *
 * This allows a single binary to be distributed to multiple organizations,
 * each pointing to their own sync server.
 */

const SYNC_URL_KEY = 'kora-sync-url'
const SYNC_CONFIGURED_KEY = 'kora-sync-configured'

/**
 * Get the configured sync server URL.
 * Priority: localStorage → VITE_SYNC_URL env var → null (needs setup).
 */
export function getSyncUrl(): string | null {
	const stored = localStorage.getItem(SYNC_URL_KEY)
	if (stored) return stored

	// Compile-time default (set via VITE_SYNC_URL when building)
	const envUrl = import.meta.env.VITE_SYNC_URL
	if (envUrl) return envUrl

	return null
}

/** Save a sync server URL to persistent local config. */
export function setSyncUrl(url: string): void {
	localStorage.setItem(SYNC_URL_KEY, url)
	localStorage.setItem(SYNC_CONFIGURED_KEY, 'true')
}

/** Clear the stored sync server URL (returns to setup screen). */
export function clearSyncUrl(): void {
	localStorage.removeItem(SYNC_URL_KEY)
	localStorage.removeItem(SYNC_CONFIGURED_KEY)
}

/**
 * Whether the user has completed initial setup (connected or explicitly skipped).
 * This is separate from getSyncUrl() — a user who skipped still completed setup.
 */
export function hasCompletedSetup(): boolean {
	// If there's a compile-time URL, setup is not needed
	if (import.meta.env.VITE_SYNC_URL) return true
	return localStorage.getItem(SYNC_CONFIGURED_KEY) === 'true'
}

/** Mark setup as completed (used when user skips sync). */
export function markSetupComplete(): void {
	localStorage.setItem(SYNC_CONFIGURED_KEY, 'true')
}

/**
 * Full factory reset: clears sync config and all local data.
 * The app reloads with a fresh state, showing the setup screen.
 */
export function factoryReset(): void {
	// Clear sync config
	clearSyncUrl()
	localStorage.removeItem(SYNC_CONFIGURED_KEY)

	// Clear all Kora local data by removing IndexedDB databases
	// and any other localStorage keys the app may have set.
	const keysToRemove: string[] = []
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i)
		if (key?.startsWith('kora-')) {
			keysToRemove.push(key)
		}
	}
	for (const key of keysToRemove) {
		localStorage.removeItem(key)
	}

	// Reload to reinitialize everything from scratch
	window.location.reload()
}

/** Test if a WebSocket URL is reachable by attempting a brief connection. */
export function testConnection(url: string, timeoutMs = 5000): Promise<boolean> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			ws.close()
			resolve(false)
		}, timeoutMs)

		const ws = new WebSocket(url)

		ws.onopen = () => {
			clearTimeout(timeout)
			ws.close()
			resolve(true)
		}

		ws.onerror = () => {
			clearTimeout(timeout)
			resolve(false)
		}
	})
}
