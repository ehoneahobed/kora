import type { SyncStatusInfo } from '../types'

/**
 * How a sync status should feel to the person using the app:
 * - `ok`: nothing to think about (everything reached the server, or the app is local only);
 * - `working`: in progress or waiting, with the data safe on this device (offline is normal);
 * - `attention`: someone has to act before sync can continue, or data is at risk.
 */
export type SyncTone = 'ok' | 'working' | 'attention'

/** One state an app can render, from the full sync status. */
export type SyncSummaryState =
	| 'local-only'
	| 'downloading'
	| 'synced'
	| 'saving'
	| 'offline'
	| 'reconnecting'
	| 'sign-in-required'
	| 'locked'
	| 'clock-error'
	| 'update-required'
	| 'storage-at-risk'
	| 'blocked'
	| 'error'

/** A sync status summarized for an indicator: tone, short title, one-line detail. */
export interface SyncSummary {
	state: SyncSummaryState
	tone: SyncTone
	/** A word or two: "Synced", "Offline", "Downloading". */
	title: string
	/** One honest line about the data: never claims the server has what it has not confirmed. */
	detail: string
	/** Writes saved on this device and not yet confirmed by the server. */
	pending: number
	/** When the server last confirmed everything (null: never). */
	lastSyncedAt: number | null
	/**
	 * The device's first download from the server has not finished: an empty list may only mean
	 * "not here yet". Show "Downloading…" rather than an empty state or a first-run setup. False
	 * for the catch-up after a reconnect or restart (the device already holds its data).
	 */
	downloading: boolean
	/** Progress of the first download, 0 to 1, when the server announced its size. */
	progress: number | null
}

export interface SummarizeSyncOptions {
	/** False when the app has no sync configured (local only). Defaults to true. */
	syncConfigured?: boolean
}

function changes(count: number): string {
	return `${count} ${count === 1 ? 'change' : 'changes'}`
}

/**
 * Summarizes a sync status for an indicator, with the wording rules Kora's apps share: offline
 * is normal, never an alarm; "saved on this device" until the server confirms; the
 * `attention` tone only when someone must act. Pure: render it however the app likes.
 *
 * @example
 * ```typescript
 * const summary = summarizeSyncStatus(app.sync.status)
 * badge.textContent = `${summary.title} · ${summary.detail}`
 * ```
 */
export function summarizeSyncStatus(
	info: SyncStatusInfo,
	options: SummarizeSyncOptions = {},
): SyncSummary {
	const pending = info.pendingOperations
	const base = { pending, lastSyncedAt: info.lastSyncedAt, downloading: false, progress: null }
	if (options.syncConfigured === false) {
		return {
			...base,
			state: 'local-only',
			tone: 'ok',
			title: 'On this device',
			detail: 'Everything is saved on this device',
		}
	}
	if (info.localDurability === 'degraded') {
		return {
			...base,
			state: 'storage-at-risk',
			tone: 'attention',
			title: 'Storage at risk',
			detail: 'This device cannot store changes safely. Stay online and free some space.',
		}
	}
	if (info.blockedFailure) {
		return {
			...base,
			state: 'blocked',
			tone: 'attention',
			title: 'Sync stopped',
			detail: info.blockedFailure.message,
		}
	}
	const waiting = pending > 0 ? `${changes(pending)} saved on this device` : null
	const initial = info.initialSync
	// Only the first download: a reconnect's catch-up is ordinary syncing, the data is already here.
	const downloading = initial !== undefined && !initial.complete && initial.first === true
	switch (info.status) {
		case 'connected':
		case 'syncing':
		case 'synced': {
			if (downloading) {
				return {
					...base,
					state: 'downloading',
					tone: 'working',
					title: 'Downloading',
					detail:
						initial?.progress != null
							? `Getting your data · ${Math.round(initial.progress * 100)}%`
							: 'Getting your data from the server',
					downloading: true,
					progress: initial?.progress ?? null,
				}
			}
			if (pending > 0)
				return {
					...base,
					state: 'saving',
					tone: 'working',
					title: 'Saving',
					detail: `${changes(pending)} on the way to the server`,
				}
			if (info.status === 'synced')
				return {
					...base,
					state: 'synced',
					tone: 'ok',
					title: 'Synced',
					detail: 'Everything has reached the server',
				}
			return {
				...base,
				state: 'saving',
				tone: 'working',
				title: 'Syncing',
				detail: 'Checking for changes',
			}
		}
		case 'offline':
			return {
				...base,
				downloading,
				state: 'offline',
				tone: 'working',
				title: 'Offline',
				detail: waiting ?? 'Everything is saved on this device',
			}
		case 'reconnecting':
			return {
				...base,
				downloading,
				state: 'reconnecting',
				tone: 'working',
				title: 'Reconnecting',
				detail: waiting ?? 'Everything is saved on this device',
			}
		case 'auth-required':
			return {
				...base,
				downloading,
				state: 'sign-in-required',
				tone: 'attention',
				title: 'Sign in to sync',
				detail: waiting
					? `${waiting}. They sync after you sign in.`
					: 'Sign in again to keep syncing',
			}
		case 'encryption-locked':
			return {
				...base,
				downloading,
				state: 'locked',
				tone: 'attention',
				title: 'Sync locked',
				detail: 'Unlock your data to keep syncing',
			}
		case 'clock-error':
			return {
				...base,
				downloading,
				state: 'clock-error',
				tone: 'attention',
				title: 'Check the clock',
				detail: 'Set this device’s date and time correctly to keep syncing',
			}
		case 'schema-mismatch':
			return {
				...base,
				downloading,
				state: 'update-required',
				tone: 'attention',
				title: 'Update needed',
				detail: 'This app and the server are on different versions',
			}
		case 'error':
			return {
				...base,
				downloading,
				state: 'error',
				tone: 'attention',
				title: 'Sync needs attention',
				detail: info.reason || (waiting ? `${waiting}` : 'Your data is still saved on this device'),
			}
		default: {
			const unknown: never = info.status
			return unknown
		}
	}
}
