import type { SyncStatusInfo } from '@korajs/sync'

/**
 * The first-data signal (first-visit parity, design section 5.8, stage S1).
 *
 * On a first visit the offline shell's service worker precaches the whole app (about 1.7 MB
 * gzip for the default template). Started while the app is still downloading its SQLite
 * WebAssembly and its first sync batch, it competes with them for the link. The shell's
 * registration script (`koraServiceWorker()` in `@korajs/cli/vite`, which this package cannot
 * import) therefore waits for this signal before it registers the worker.
 *
 * The contract, like the `__KORA_SHELL__` one in the other direction:
 * `globalThis.__KORA_FIRST_DATA__ = { v: 1, state: 'pending' | 'done' }`, and a
 * `kora:first-data` window event when it becomes `done`. Per page; the first app created
 * on the page owns it.
 */

/** The window event dispatched when the first data is in. */
export const FIRST_DATA_EVENT = 'kora:first-data'

/** The page-global state of the signal. */
export interface FirstDataSignalState {
	v: 1
	state: 'pending' | 'done'
}

/** Statuses after which no first data is coming until the user or developer acts. */
const STALLED_STATUSES: ReadonlySet<SyncStatusInfo['status']> = new Set([
	'auth-required',
	'encryption-locked',
	'clock-error',
	'schema-mismatch',
	'error',
])

/** Phases of a sync attempt in progress (anything but idle, caught up or stopped). */
const ACTIVE_PHASES: ReadonlySet<NonNullable<SyncStatusInfo['phase']>> = new Set([
	'connecting',
	'authenticating',
	'handshaking',
	'uploading',
	'receiving',
	'applying',
])

/**
 * Whether the app's first-visit network work is over, judged from one sync status.
 *
 * Over when the first delivery batch has been applied, when the session is caught up
 * (`streaming`, also with nothing to deliver), when sync is stopped until someone acts
 * (signed out, locked, blocked), or when an attempt that was under way ended offline.
 *
 * @param status - The current sync status
 * @param attempted - Whether a sync attempt was seen in progress earlier
 * @returns true once no first data is still on its way
 */
export function firstDataSettled(status: SyncStatusInfo, attempted: boolean): boolean {
	if (STALLED_STATUSES.has(status.status)) return true
	if (status.phase === 'blocked' || status.phase === 'suspended') return true
	if (status.phase === 'streaming' && status.hasInFlightDeliveryBatch !== true) return true
	if ((status.initialSync?.receivedBatches ?? 0) > 0 && status.hasInFlightDeliveryBatch !== true) {
		return true
	}
	return attempted && status.status === 'offline' && !isActive(status)
}

function isActive(status: SyncStatusInfo): boolean {
	return status.phase !== undefined && ACTIVE_PHASES.has(status.phase)
}

/** What {@link wireFirstDataSignal} reads. */
export interface FirstDataSignalOptions {
	/** `app.ready`. */
	ready: Promise<unknown>
	/** Whether the app syncs (`config.sync` set). */
	syncs: boolean
	/** The current sync status, read after `ready`. */
	status: () => SyncStatusInfo
	/** Subscribes to sync status changes; returns the unsubscribe function. */
	subscribeStatus: (listener: (status: SyncStatusInfo) => void) => () => void
	/** The page (tests pass a fake). Defaults to `globalThis`. */
	target?: FirstDataTarget
}

/** The slice of `window` the signal writes to. */
export interface FirstDataTarget {
	__KORA_FIRST_DATA__?: unknown
	dispatchEvent(event: Event): boolean
}

/**
 * Publishes `pending` now and `done` once the first data is in: right after `app.ready` for a
 * local-only app (its data is local), when {@link firstDataSettled} says so for a syncing
 * app, and when `app.ready` fails (nothing more is coming). A page that already published
 * the signal (a second app on the page) is left alone.
 *
 * @param options - The app's ready promise and sync status source
 * @returns A function that stops listening (the signal stays as it is)
 */
export function wireFirstDataSignal(options: FirstDataSignalOptions): () => void {
	const target = options.target ?? (globalThis as unknown as FirstDataTarget)
	if (target.__KORA_FIRST_DATA__ !== undefined) return () => {}
	target.__KORA_FIRST_DATA__ = { v: 1, state: 'pending' } satisfies FirstDataSignalState

	let stopped = false
	let unsubscribe: (() => void) | null = null
	const stop = (): void => {
		stopped = true
		unsubscribe?.()
		unsubscribe = null
	}
	const publish = (): void => {
		if (stopped) return
		stop()
		target.__KORA_FIRST_DATA__ = { v: 1, state: 'done' } satisfies FirstDataSignalState
		try {
			target.dispatchEvent(new Event(FIRST_DATA_EVENT))
		} catch (error) {
			console.warn('[kora] Could not announce the first data:', error)
		}
	}

	options.ready.then(
		() => {
			if (stopped) return
			if (!options.syncs) {
				publish()
				return
			}
			let attempted = false
			const check = (status: SyncStatusInfo): void => {
				if (firstDataSettled(status, attempted)) {
					publish()
					return
				}
				if (isActive(status)) attempted = true
			}
			unsubscribe = options.subscribeStatus(check)
			if (stopped) {
				// The subscription answered synchronously and settled.
				unsubscribe()
				unsubscribe = null
				return
			}
			check(options.status())
		},
		() => publish(),
	)
	return stop
}
