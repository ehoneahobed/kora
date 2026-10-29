/**
 * The offline-readiness status (`app.offline.status()`, `useOfflineReady()`), and the rule
 * that turns its components into one state (offline-readiness design, sections 3 and 3.1).
 *
 * `ready` means: reload with no network and this app opens, shows the data it was told to
 * keep, and accepts writes. A component that cannot prove it is never assumed to hold:
 * `unknown` is never `ready`.
 */

/** A detected loss of the database's storage (`store:storage-evicted`). */
export interface StorageEviction {
	dbName: string
	/** Wall-clock milliseconds the loss was detected. */
	detectedAt: number
	/** Wall-clock milliseconds of the vanished database's last durable open, when known. */
	lastOpenedAt: number | null
	/** Which independent records named the vanished database. */
	evidence: Array<'manifest' | 'localStorage'>
	/**
	 * Unsynced writes the vanished database held when it was last recorded. `certain` is
	 * true when no write followed that recording; otherwise the count may be too low.
	 */
	lostWrites: { count: number; certain: boolean }
}

/** Why the device is not `ready` (empty exactly when it is). */
export type OfflineReason =
	| 'shell-none'
	| 'shell-unsupported'
	| 'shell-not-installed'
	| 'shell-installing'
	| 'shell-other-build'
	| 'data-syncing'
	| 'data-incomplete'
	| 'data-blocked'
	| 'files-downloading'
	| 'files-missing'
	| 'files-failed'
	| 'storage-non-durable'
	| 'storage-writes-failing'
	| 'storage-uncoordinated'
	| 'storage-other-tab'
	| 'auth-loading'
	| 'auth-not-restorable'
	| 'auth-unknown'
	| 'server-rendering'

/** The offline shell (service worker precache) component. */
export interface OfflineShellStatus {
	state:
		| 'installed'
		| 'installing'
		| 'not-installed'
		| 'other-build'
		| 'unsupported'
		| 'bundled'
		| 'none'
	/** The active worker's precache version. */
	version: string | null
	/** URLs the worker failed to serve offline (diagnostic). */
	misses: string[]
}

/** The synced data component. */
export interface OfflineDataStatus {
	/**
	 * `complete`: a completion mark proves the current view was fully delivered, as of
	 * `completedAt`. `syncing`: a session is live and no mark matches yet. `incomplete`:
	 * no mark matches and nothing is downloading. `local`: no sync, nothing to download.
	 */
	state: 'complete' | 'syncing' | 'incomplete' | 'local'
	/** 0..1, approximate, while syncing. */
	progress: number | null
	/** Wall time of the mark in use (display only). */
	completedAt: number | null
	/** Operations held in quarantine: reported only, never gating. */
	quarantined: number
}

/** The kept files component. */
export interface OfflineFilesStatus {
	kept: number
	missing: number
	bytesMissing: number
	failed: number
}

/** The storage component. */
export interface OfflineStorageStatus {
	backend: 'opfs' | 'indexeddb' | 'native' | 'memory'
	/** The database survives a reload (and the blob store too, while a pin keeps files). */
	durable: boolean
	/** Diagnostic: the blob store alone survives a reload. */
	blobStoreDurable: boolean
	/** `navigator.storage.persisted()`; null: unknown or unsupported. Informational. */
	persisted: boolean | null
	/** `failing` while snapshot saves fail, and until reload after a lost snapshot. */
	writes: 'durable' | 'failing'
	usage: number | null
	quota: number | null
	/** A detected storage loss the app has not acknowledged. */
	evicted: StorageEviction | null
}

/** The sign-in component: can the signed-in session be restored on an offline reload? */
export interface OfflineAuthStatus {
	state: 'n/a' | 'loading' | 'restorable' | 'not-restorable' | 'unknown'
	/** Restorable offline until this time (ms); null: no limit known. */
	offlineUntil: number | null
}

/** The full offline-readiness status. */
export interface OfflineStatus {
	state: 'ready' | 'preparing' | 'not-ready'
	/** Empty exactly when `state` is `ready`. */
	reasons: OfflineReason[]
	shell: OfflineShellStatus
	data: OfflineDataStatus
	files: OfflineFilesStatus
	storage: OfflineStorageStatus
	auth: OfflineAuthStatus
}

/** Everything the state rule reads besides the components themselves. */
export interface OfflineStateInputs {
	shell: OfflineShellStatus
	data: OfflineDataStatus
	files: OfflineFilesStatus
	storage: OfflineStorageStatus
	auth: OfflineAuthStatus
	/** The transient failure that stalls delivery (`data-blocked`): gating, not progress. */
	dataBlocked: boolean
	/** Every pin's completion (pins arrive with `keep`; true without any). */
	pinsComplete: boolean
	/** A pin with `files: true` exists (the blob store then gates `storage.durable`). */
	filesKept: boolean
	/** Files are being downloaded right now (progress, not failure). */
	filesDownloading: boolean
	/** A sync session is live, so `data` can still become complete. */
	sessionLive: boolean
	/** The page is rendered on a server: nothing is on any device. */
	serverRendering: boolean
	/** Another tab holds the database (a tab waiting for the exclusive lock). */
	otherTab: boolean
	/** The app opted into tabs without coordination: never claimed ready. */
	uncoordinated: boolean
	/** The wall clock, for `auth.offlineUntil`. */
	now: number
}

/**
 * The state rule (design 3.1). `ready` iff every component holds; otherwise `preparing`
 * when every failing component is making progress (shell installing, data syncing on a
 * live session, files downloading, auth loading), else `not-ready`.
 *
 * `persisted`, `quota`, `quarantined`, `evicted` and `misses` never change the result.
 */
export function computeOfflineState(inputs: OfflineStateInputs): {
	state: OfflineStatus['state']
	reasons: OfflineReason[]
} {
	const reasons: OfflineReason[] = []
	// A failing component that is making progress does not make the device `not-ready`.
	let stalled = false
	const fail = (reason: OfflineReason, progressing: boolean): void => {
		reasons.push(reason)
		if (!progressing) stalled = true
	}

	if (inputs.serverRendering) fail('server-rendering', false)
	if (inputs.otherTab) fail('storage-other-tab', false)
	if (inputs.uncoordinated) fail('storage-uncoordinated', false)

	switch (inputs.shell.state) {
		case 'installed':
		case 'bundled':
			break
		case 'installing':
			fail('shell-installing', true)
			break
		case 'not-installed':
			fail('shell-not-installed', false)
			break
		case 'other-build':
			fail('shell-other-build', false)
			break
		case 'unsupported':
			fail('shell-unsupported', false)
			break
		case 'none':
			fail('shell-none', false)
			break
	}

	// A blocked delivery outranks the data state: it is a failure the app must act on.
	if (inputs.dataBlocked) {
		fail('data-blocked', false)
	} else if (inputs.data.state === 'syncing') {
		fail('data-syncing', inputs.sessionLive)
	} else if (inputs.data.state === 'incomplete') {
		fail('data-incomplete', false)
	} else if (!inputs.pinsComplete) {
		// A pin whose records are not all delivered yet follows the data's own progress.
		fail('data-incomplete', inputs.sessionLive)
	}

	if (inputs.files.failed > 0) fail('files-failed', false)
	else if (inputs.files.missing > 0) {
		if (inputs.filesDownloading) fail('files-downloading', true)
		else fail('files-missing', false)
	}

	// The database must survive a reload; the blob store counts only while a pin keeps files.
	const storageDurable =
		inputs.storage.durable && (!inputs.filesKept || inputs.storage.blobStoreDurable)
	if (!storageDurable) fail('storage-non-durable', false)
	if (inputs.storage.writes !== 'durable') fail('storage-writes-failing', false)

	switch (inputs.auth.state) {
		case 'n/a':
			break
		case 'loading':
			fail('auth-loading', true)
			break
		case 'restorable':
			if (inputs.auth.offlineUntil !== null && inputs.auth.offlineUntil <= inputs.now) {
				fail('auth-not-restorable', false)
			}
			break
		case 'not-restorable':
			fail('auth-not-restorable', false)
			break
		case 'unknown':
			fail('auth-unknown', false)
			break
	}

	if (reasons.length === 0) return { state: 'ready', reasons }
	return { state: stalled ? 'not-ready' : 'preparing', reasons }
}

/** The status before anything is known (server render, or before `app.ready`). */
export const OFFLINE_STATUS_UNKNOWN: OfflineStatus = Object.freeze({
	state: 'not-ready',
	reasons: Object.freeze(['data-incomplete', 'storage-non-durable']) as unknown as OfflineReason[],
	shell: Object.freeze({ state: 'none', version: null, misses: [] }) as OfflineShellStatus,
	data: Object.freeze({
		state: 'incomplete',
		progress: null,
		completedAt: null,
		quarantined: 0,
	}) as OfflineDataStatus,
	files: Object.freeze({ kept: 0, missing: 0, bytesMissing: 0, failed: 0 }) as OfflineFilesStatus,
	storage: Object.freeze({
		backend: 'memory',
		durable: false,
		blobStoreDurable: false,
		persisted: null,
		writes: 'durable',
		usage: null,
		quota: null,
		evicted: null,
	}) as OfflineStorageStatus,
	auth: Object.freeze({ state: 'unknown', offlineUntil: null }) as OfflineAuthStatus,
}) as OfflineStatus

/** A query subset a delivery view is restricted to (structural twin of `SyncQuerySubset`). */
export interface OfflineMarkSubset {
	collection: string
	where: Record<string, unknown>
}

/**
 * The durable proof that a delivery view was fully delivered (`_kora_meta`
 * `offline_complete:<signature>`, design 4.1). Written in the same transaction as the
 * watermark advance of the unit's final batch.
 */
export interface OfflineCompletionMark {
	/** The view signature the mark belongs to. */
	signature: string
	/** The delivery watermark the mark was set at. */
	watermark: number
	scopeKey: string
	subsets: OfflineMarkSubset[]
	rulesKey: string | null
	principal: string | null
	collectionsKey: string
	/** Wall time the mark was set (display only). */
	at: number
}

/** A delivery unit that may have applied part of its batches (`offline_unit_open:*`). */
export interface OfflineUnitKey {
	signature: string
	unitId: string
	/** The delivery sequence the unit started from (diagnostic). */
	base: number
	/** The highest delivery sequence the unit can apply. */
	upTo: number
}

/**
 * What a final delivery batch commits together with its watermark: the mark, and the unit
 * it closes (whose key, and the keys of every unit it covers, leave in the same transaction).
 */
export interface OfflineCompletion {
	mark: OfflineCompletionMark
	/** The closing unit's id, when it opened a key. */
	unitId: string | null
}

/** Every mark and unit key stored in a database. */
export interface OfflineMarksSnapshot {
	marks: OfflineCompletionMark[]
	units: OfflineUnitKey[]
}

/** The status a server render reports: nothing is on any device. */
export const OFFLINE_STATUS_SERVER_RENDER: OfflineStatus = Object.freeze({
	...OFFLINE_STATUS_UNKNOWN,
	reasons: Object.freeze(['server-rendering']) as unknown as OfflineReason[],
}) as OfflineStatus
