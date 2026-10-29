/**
 * The structural subset of `OfflineStatus` (`app.offline.status()`) the helpers read. It is
 * declared here, not imported, so `@korajs/test/playwright` never pulls in `korajs` and keeps
 * working when the app under test is a different build than the one the tests were compiled with.
 */
export interface OfflineStatusLike {
	/** `ready`, `preparing` or `not-ready`. */
	state: 'ready' | 'preparing' | 'not-ready'
	/** Why the app is not ready: empty exactly when `state` is `ready`. */
	reasons: readonly string[]
	/** The remaining fields of `OfflineStatus` (`shell`, `data`, `files`, `storage`, `auth`). */
	[field: string]: unknown
}

/**
 * Where the helpers find the offline handle inside the page: a dotted path from `window` to an
 * object with `status()`. For example `'app.offline'` (the default) or `'kora.app.offline'`.
 */
export type OfflineAccessor = string

/** The default accessor: `window.app.offline`. */
export const DEFAULT_OFFLINE_ACCESSOR: OfflineAccessor = 'app.offline'

/** Options shared by every helper that reads the offline status from the page. */
export interface StatusReadOptions {
	/** Dotted path from `window` to the offline handle. Default `'app.offline'`. */
	accessor?: OfflineAccessor
}
