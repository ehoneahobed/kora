// @korajs/test/playwright — offline helpers for Playwright end-to-end tests.
// Nothing here imports `playwright-core` at runtime; it is an optional peer dependency used
// for types only, and the main `@korajs/test` entry never loads this module.

// === Connectivity, crash and service worker ===
export {
	NETWORK_PRESETS,
	blockServiceWorker,
	goOffline,
	goOnline,
	killTab,
	resolveNetworkConditions,
	throttleNetwork,
} from './network'
export type { NetworkConditions, NetworkPreset, NetworkTarget, NetworkThrottle } from './network'

// === Clock ===
export { skewClock } from './clock'

// === Profile ===
export { openProfile, restartProfile } from './profile'
export type { Profile, ProfileOptions } from './profile'

// === Offline status ===
export { hasReason, readOfflineStatus, waitForOfflineStatus } from './status'
export type { StatusMatcher, WaitForOfflineStatusOptions } from './status'
export { DEFAULT_OFFLINE_ACCESSOR } from './types'
export type { OfflineAccessor, OfflineStatusLike, StatusReadOptions } from './types'

// === Readiness contract ===
export { assertReadyMeansOffline, expectNeverReady, firstVisitOffline } from './readiness'
export type {
	AssertReadyMeansOfflineOptions,
	ExpectNeverReadyOptions,
	FirstVisitOfflineOptions,
	FirstVisitOfflineResult,
	NeverReadyReport,
	ReadyMeansOfflineReport,
} from './readiness'

// === Errors ===
export { OfflineAssertionError } from './errors'
