import type { OfflineStatus } from './offline-status'

/** The status before anything is known (server render, or before `app.ready`). */
export const OFFLINE_STATUS_UNKNOWN: OfflineStatus = Object.freeze({
	state: 'not-ready',
	reasons: ['data-incomplete', 'storage-non-durable'],
	shell: { state: 'none', version: null, misses: [] },
	data: { state: 'incomplete', progress: null, completedAt: null, quarantined: 0 },
	files: { kept: 0, missing: 0, bytesMissing: 0, failed: 0 },
	storage: {
		backend: 'memory',
		durable: false,
		blobStoreDurable: false,
		persisted: null,
		writes: 'durable',
		usage: null,
		quota: null,
		evicted: null,
	},
	auth: { state: 'unknown', offlineUntil: null },
}) as OfflineStatus

/**
 * The status while the browser is still opening the local database (render-before-ready, first
 * visit): nothing is wrong, nothing is held yet, and the store is making progress. Reported as
 * `preparing`, never as the stalled `not-ready` that {@link OFFLINE_STATUS_UNKNOWN} means.
 */
export const OFFLINE_STATUS_OPENING: OfflineStatus = Object.freeze({
	...OFFLINE_STATUS_UNKNOWN,
	state: 'preparing',
	reasons: ['storage-opening', 'data-incomplete'],
}) as OfflineStatus

/** The status a server render reports: nothing is on any device. */
export const OFFLINE_STATUS_SERVER_RENDER: OfflineStatus = Object.freeze({
	...OFFLINE_STATUS_UNKNOWN,
	reasons: ['server-rendering'],
}) as OfflineStatus
