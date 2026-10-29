/// <reference lib="dom" />
import { type VersionGate, parseTabLockName, tabLockName } from '@korajs/store'

/**
 * How the tabs of one database find out which of them still exist, for the holds
 * `useOfflineKeep` records (offline-readiness design 4.3). A hold names the tab that made it
 * (the `tabId` of its version-gate tab lock); the tabs still open delete the holds of a tab
 * whose lock is gone.
 */

/** The `navigator.locks` calls the pins use. */
export interface OfflineLockManagerLike {
	request(
		name: string,
		options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean; signal?: AbortSignal },
		callback: (lock: unknown) => unknown,
	): Promise<unknown>
	query(): Promise<{
		held?: Array<{ name?: string; mode?: string }>
		pending?: Array<{ name?: string; mode?: string }>
	}>
}

/**
 * How holds are kept in this runtime.
 * - `locks`: tab locks exist (Web Locks and a broadcast channel): holds are recorded and
 *   pruned by the other tabs when their owner's lock goes.
 * - `exclusive`: one tab owns the database at a time, so every hold of another tab is stale.
 * - `explicit`: nothing coordinates tabs (a native host, no Web Locks): a component takes an
 *   explicit pin and releases it on unmount; a crash leaves it pinned until released.
 */
export type OfflineHoldMode = 'locks' | 'exclusive' | 'explicit'

/** What the pins need to know about this tab and its siblings. */
export interface TabCoordination {
	mode: OfflineHoldMode
	/** This tab's id (`tabId` of its tab lock); a random id in `explicit` mode. */
	tabId: string
	/** The name of this tab's lock, or null when it has none. */
	tabLock(): string | null
	/** Web Locks, or null (a single fetcher is then assumed). */
	locks: OfflineLockManagerLike | null
	/** The tab id in one of this database's tab lock names, or null for any other lock. */
	parseTabLock(name: string): string | null
	/**
	 * Called after this tab got its tab lock back (it was suspended into bfcache or frozen
	 * and its lock released), so it can record its mounted holds again.
	 */
	onResume(listener: () => void): () => void
}

function randomId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function browserLocks(): OfflineLockManagerLike | null {
	const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator
	const locks = nav?.locks as Partial<OfflineLockManagerLike> | undefined
	return locks && typeof locks.request === 'function' && typeof locks.query === 'function'
		? (locks as OfflineLockManagerLike)
		: null
}

/** The gate parts {@link createTabCoordination} reads (a `VersionGate`, or a fake). */
export type TabCoordinationGate = Pick<
	VersionGate,
	'mode' | 'getIdentity' | 'getState' | 'onChange'
>

/** Where the page lifecycle events come from (`window` in a browser). */
export interface PageLifecycleSource {
	addEventListener(type: 'pageshow', listener: (event: { persisted?: boolean }) => void): void
	removeEventListener(type: 'pageshow', listener: (event: { persisted?: boolean }) => void): void
}

/**
 * Coordination for the app's version gate. Without a gate (a native host, a test) holds
 * are `explicit`. A tab restored from the back-forward cache re-records its holds after the
 * gate reports `open` again (the lock is back), or on `pageshow` with `persisted`.
 *
 * @param gate - The gate of this opening of the database, or null
 * @param options - Test seams: the lock manager and the page
 */
export function createTabCoordination(
	gate: TabCoordinationGate | null,
	options: {
		dbName: string
		locks?: OfflineLockManagerLike | null
		page?: PageLifecycleSource | null
	},
): TabCoordination {
	const locks = options.locks === undefined ? browserLocks() : options.locks
	const identity = gate?.getIdentity() ?? null
	const mode: OfflineHoldMode =
		gate && identity && locks
			? gate.mode === 'full'
				? 'locks'
				: gate.mode === 'exclusive'
					? 'exclusive'
					: 'explicit'
			: 'explicit'
	const tabId = identity?.tabId ?? randomId()
	const listeners = new Set<() => void>()
	const fire = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener()
			} catch (error) {
				console.error('[kora] A tab-resume listener failed:', error)
			}
		}
	}

	let detach: Array<() => void> = []
	const start = (): void => {
		if (detach.length > 0) return
		if (gate) {
			// `suspended`, then `open` again (through `opening`): the tab lock was released and
			// got back, and the holds it lost meanwhile have to be recorded again.
			let suspended = gate.getState() === 'suspended'
			detach.push(
				gate.onChange((snapshot) => {
					if (snapshot.state === 'suspended') suspended = true
					else if (snapshot.state === 'open' && suspended) {
						suspended = false
						fire()
					}
				}),
			)
		}
		const page = options.page === undefined ? pageOf() : options.page
		if (page) {
			const onShow = (event: { persisted?: boolean }): void => {
				if (event.persisted !== true) return
				// The tab lock may not be back yet: record the holds once it is.
				const resumed = gate?.getState() === 'open'
				if (resumed) fire()
			}
			page.addEventListener('pageshow', onShow)
			detach.push(() => page.removeEventListener('pageshow', onShow))
		}
	}
	const stop = (): void => {
		for (const off of detach.splice(0)) off()
		detach = []
	}

	return {
		mode,
		tabId,
		tabLock: () => {
			const id = gate?.getIdentity()
			return id ? tabLockName(options.dbName, id) : null
		},
		locks,
		parseTabLock: (name) => parseTabLockName(options.dbName, name)?.tabId ?? null,
		onResume(listener) {
			listeners.add(listener)
			start()
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0) stop()
			}
		},
	}
}

function pageOf(): PageLifecycleSource | null {
	return typeof window !== 'undefined' ? (window as unknown as PageLifecycleSource) : null
}
