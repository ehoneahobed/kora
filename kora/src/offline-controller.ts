import {
	type KoraEventEmitter,
	type OfflineAuthStatus,
	type OfflineDataStatus,
	type OfflineShellStatus,
	type OfflineStatus,
	type OfflineStorageStatus,
	computeOfflineState,
} from '@korajs/core'
import type { OfflineRestoreResult } from '@korajs/core/bindings'
import type { StoragePersistence, Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import type { OfflineKeep } from './offline-keep'
import type { KoraConfig } from './types'

/** How often a restorable session checks the wall clock against the monotonic one. */
const AUTH_WATCHDOG_INTERVAL_MS = 30_000
/** A wall-clock jump beyond this, in either direction, re-evaluates the auth component. */
const AUTH_CLOCK_JUMP_MS = 2_000

/** Where the controller reads the live parts of the app from. */
export interface OfflineControllerRuntime {
	store: Store | null
	engine: SyncEngine | null
	/** Whether the opened database survives a reload (`storeInfo().durable`). */
	durable: boolean
	backend: OfflineStorageStatus['backend']
	/** The pins of `app.offline.keep()`; null before the database is open. */
	keep?: OfflineKeep | null
}

/** Options for {@link createOfflineController}. */
export interface OfflineControllerOptions {
	config: KoraConfig
	emitter: KoraEventEmitter
	persistence: StoragePersistence
	/** True during a server render: nothing is on any device. */
	inert: boolean
	runtime(): OfflineControllerRuntime
	/** The offline shell's status; absent until the shell reports (it is then `none`). */
	shell?: () => OfflineShellStatus
}

/** Whether the synced data is fully delivered (or there is nothing to deliver). */
function isDataDelivered(data: OfflineDataStatus): boolean {
	return data.state === 'complete' || data.state === 'local'
}

const SHELL_CONTRACT_STATES: readonly OfflineShellStatus['state'][] = [
	'installed',
	'installing',
	'not-installed',
	'other-build',
	'unsupported',
]

/**
 * The shell status the registration script of `koraServiceWorker()` publishes as
 * `globalThis.__KORA_SHELL__ = { v: 1, state, version, misses }` (design section 7).
 * `korajs` cannot import `@korajs/cli`, so the contract is read structurally. Anything that
 * is not a version 1 value with a known state reads as absent: a newer contract is never
 * guessed at, and `bundled` / `none` are decided here, never reported by a page script.
 */
export function readShellContract(): OfflineShellStatus | null {
	const raw: unknown = (globalThis as { __KORA_SHELL__?: unknown }).__KORA_SHELL__
	if (typeof raw !== 'object' || raw === null) return null
	const value = raw as { v?: unknown; state?: unknown; version?: unknown; misses?: unknown }
	if (value.v !== 1) return null
	const state = SHELL_CONTRACT_STATES.find((known) => known === value.state)
	if (state === undefined) return null
	return {
		state,
		version: typeof value.version === 'string' ? value.version : null,
		misses: Array.isArray(value.misses)
			? value.misses.filter((miss): miss is string => typeof miss === 'string')
			: [],
	}
}

/** The `app.offline` status source: computes, caches and publishes {@link OfflineStatus}. */
export interface OfflineController {
	status(): OfflineStatus
	subscribe(listener: (status: OfflineStatus) => void): () => void
	/** Start following the opened store and sync engine (after `app.ready`). */
	attach(): void
	/** Re-read marks and watermarks from the database (another tab changed them). */
	refreshFromDatabase(): Promise<void>
	/** Stop following everything. */
	dispose(): void
}

/**
 * Build the offline-readiness status source (offline-readiness design, sections 3 and 4).
 *
 * The status is a synchronous snapshot recomputed on every change of its inputs and
 * published only when it differs. Components not yet known report the values that can
 * never claim readiness they cannot prove: no offline shell yet (`none`), an unread pin
 * table (not complete). The kept-files component and the pins come from `runtime().keep`. The sign-in component comes from the app's `offline.auth`
 * declaration or the auth binding's `resolveOfflineRestore`; an app that authenticates and
 * answers neither reports `unknown`, which is never `ready`.
 *
 * @param options - The app pieces the status reads
 * @returns The controller; `status()` works before the store opens
 */
export function createOfflineController(options: OfflineControllerOptions): OfflineController {
	const { config, emitter, persistence, inert, runtime } = options
	const shellOverride = options.shell
	const listeners = new Set<(status: OfflineStatus) => void>()
	const detach: Array<() => void> = []
	let otherTab = false
	let quarantined = 0
	let attached = false
	let current: OfflineStatus | null = null
	let serial = ''
	let disposed = false
	let authGeneration = 0
	let authTimer: ReturnType<typeof setTimeout> | null = null
	let authWatchdog: ReturnType<typeof setInterval> | null = null

	/**
	 * Where the answer comes from (offline-readiness design 8.2): the app's own declaration
	 * wins, then the auth binding; a bare `sync.auth` token function cannot know how the app
	 * signs in, and Kora never assumes yes.
	 */
	const authSource = (): 'none' | 'declared' | 'binding' | 'bare' => {
		if (config.offline?.auth) return 'declared'
		if (config.sync?.authClient) return 'binding'
		return config.sync?.auth ? 'bare' : 'none'
	}
	const initialAuth = (): OfflineAuthStatus => {
		switch (authSource()) {
			case 'none':
				return { state: 'n/a', offlineUntil: null }
			case 'bare':
				return { state: 'unknown', offlineUntil: null }
			default:
				return { state: 'loading', offlineUntil: null }
		}
	}
	let authStatus: OfflineAuthStatus = initialAuth()

	const fromRestore = (result: OfflineRestoreResult): OfflineAuthStatus => {
		if (result.restorable === true) return { state: 'restorable', offlineUntil: result.until }
		if (result.restorable === false) return { state: 'not-restorable', offlineUntil: null }
		return { state: 'unknown', offlineUntil: null }
	}

	const resolveAuth = async (): Promise<OfflineAuthStatus> => {
		const source = authSource()
		if (source === 'declared') {
			const declared = await config.offline?.auth?.()
			if (!declared) return { state: 'unknown', offlineUntil: null }
			if (declared.restorable === true) {
				return { state: 'restorable', offlineUntil: declared.until ?? null }
			}
			return declared.restorable === false
				? { state: 'not-restorable', offlineUntil: null }
				: { state: 'unknown', offlineUntil: null }
		}
		const binding = config.sync?.authClient
		if (source !== 'binding' || !binding) return initialAuth()
		const sync = await binding.resolveSyncState?.()
		if (sync?.state === 'loading') return { state: 'loading', offlineUntil: null }
		// A client that may connect anonymously has no session to restore (koraforms respondents).
		if (sync?.state === 'anonymous') return { state: 'n/a', offlineUntil: null }
		if (!binding.resolveOfflineRestore) return { state: 'unknown', offlineUntil: null }
		return fromRestore(await binding.resolveOfflineRestore())
	}

	const clearAuthTimers = (): void => {
		if (authTimer !== null) clearTimeout(authTimer)
		if (authWatchdog !== null) clearInterval(authWatchdog)
		authTimer = null
		authWatchdog = null
	}

	/**
	 * Re-evaluate the auth component and re-arm its timers. A wall clock moved backwards
	 * fires neither the binding's subscription nor the `until` timer, so while the session is
	 * `restorable` a watchdog compares the wall-clock delta with the monotonic delta.
	 */
	const refreshAuth = (): void => {
		if (disposed || authSource() === 'none' || authSource() === 'bare') return
		const generation = ++authGeneration
		void resolveAuth()
			.catch((error: unknown): OfflineAuthStatus => {
				console.warn('[kora] Could not determine whether the session restores offline:', error)
				return { state: 'unknown', offlineUntil: null }
			})
			.then((next) => {
				if (disposed || generation !== authGeneration) return
				authStatus = next
				clearAuthTimers()
				if (next.state === 'restorable') armAuthTimers(next.offlineUntil)
				recompute()
			})
	}

	const armAuthTimers = (until: number | null): void => {
		if (until !== null) {
			// setTimeout caps at 2^31-1 ms; a later `until` re-arms when the cap fires.
			const wait = Math.min(Math.max(until - Date.now(), 0) + 1, 2_147_483_647)
			authTimer = setTimeout(refreshAuth, wait)
		}
		if (typeof performance !== 'undefined') {
			let wall = Date.now()
			let mono = performance.now()
			authWatchdog = setInterval(() => {
				const nextWall = Date.now()
				const nextMono = performance.now()
				const drift = nextWall - wall - (nextMono - mono)
				wall = nextWall
				mono = nextMono
				if (Math.abs(drift) > AUTH_CLOCK_JUMP_MS) refreshAuth()
			}, AUTH_WATCHDOG_INTERVAL_MS)
		}
	}

	// The offline shell: a desktop build embeds its interface in the binary (`bundled`, the
	// native storage backend); a web build reports through the `__KORA_SHELL__` contract the
	// `koraServiceWorker()` registration script maintains; neither: no shell (`none`), or
	// `unsupported` where the browser has no service workers at all.
	const shell = (): OfflineShellStatus => {
		if (shellOverride) return shellOverride()
		if (runtime().backend === 'native') return { state: 'bundled', version: null, misses: [] }
		const reported = readShellContract()
		if (reported) return reported
		const supported =
			typeof navigator !== 'undefined' && (navigator as { serviceWorker?: unknown }).serviceWorker
		return { state: supported ? 'none' : 'unsupported', version: null, misses: [] }
	}

	const persistedFlag = (): boolean | null => {
		const status = persistence.status()
		if (status.persisted) return true
		return status.state === 'unknown' ? null : false
	}

	const compute = (): OfflineStatus => {
		const { store, engine, durable, backend, keep } = runtime()
		const kept = keep?.snapshot() ?? null
		const filesKept = kept?.filesKept ?? false
		const blobStoreDurable = kept?.blobStoreDurable ?? durable
		const evicted = store?.getStorageEviction() ?? null
		const writes = store?.getWriteDurability().state === 'failing' ? 'failing' : 'durable'
		const storage: OfflineStorageStatus = {
			backend,
			// The database survives a reload, and so does the blob store while a pin keeps files.
			durable: durable && (!filesKept || blobStoreDurable),
			blobStoreDurable,
			persisted: persistedFlag(),
			writes,
			usage: null,
			quota: null,
			evicted,
		}
		const syncConfigured = config.sync !== undefined
		let data: OfflineDataStatus
		let dataBlocked = false
		let sessionLive = false
		if (engine) {
			const { blocked, sessionLive: live, ...rest } = engine.getOfflineData()
			data = { ...rest, quarantined }
			dataBlocked = blocked
			sessionLive = live
		} else {
			data = {
				state: syncConfigured ? 'incomplete' : 'local',
				progress: null,
				completedAt: null,
				quarantined: 0,
			}
		}
		const auth = authStatus
		const shellStatus = shell()
		const files = kept?.files ?? { kept: 0, missing: 0, bytesMissing: 0, failed: 0 }
		// Pins are part of the sync view, so a complete mark covers them; a pin table that was
		// not read yet proves nothing.
		const pinsComplete =
			kept === null || (kept.loaded && (kept.pins === 0 || isDataDelivered(data)))
		const { state, reasons } = computeOfflineState({
			shell: shellStatus,
			data,
			files,
			storage,
			auth,
			dataBlocked,
			pinsComplete,
			filesKept,
			filesDownloading: kept?.downloading ?? false,
			sessionLive,
			serverRendering: inert,
			otherTab,
			uncoordinated: config.store?.allowUncoordinatedTabs === true,
			now: Date.now(),
		})
		return { state, reasons, shell: shellStatus, data, files, storage, auth }
	}

	const recompute = (): void => {
		const next = compute()
		const nextSerial = JSON.stringify(next)
		if (current !== null && nextSerial === serial) return
		current = next
		serial = nextSerial
		for (const listener of [...listeners]) {
			try {
				listener(next)
			} catch (error) {
				console.error('[kora] An app.offline listener failed:', error)
			}
		}
	}

	const refreshQuarantine = (): void => {
		const engine = runtime().engine
		if (!engine) return
		engine
			.getQuarantinedOperations()
			.then((entries) => {
				if (entries.length === quarantined) return
				quarantined = entries.length
				recompute()
			})
			.catch(() => {
				// Reported only, never gating: a failed count leaves the last one.
			})
	}

	const onPageResume = (): void => {
		void controller.refreshFromDatabase()
	}

	const controller: OfflineController = {
		status(): OfflineStatus {
			if (current === null) {
				current = compute()
				serial = JSON.stringify(current)
			}
			return current
		},
		subscribe(listener) {
			// Prime the snapshot so the first recompute is compared with something.
			controller.status()
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		attach() {
			if (attached) return
			attached = true
			otherTab = false
			const { engine } = runtime()
			if (engine) detach.push(engine.onStatusChange(recompute))
			const keep = runtime().keep
			if (keep) detach.push(keep.onChange(recompute))
			detach.push(
				emitter.on('store:write-durability', recompute),
				emitter.on('storage:persistence', recompute),
				emitter.on('store:storage-evicted', recompute),
				emitter.on('offline:meta-changed', recompute),
				emitter.on('sync:apply-failed', refreshQuarantine),
				emitter.on('sync:apply-recovered', refreshQuarantine),
			)
			if (typeof window !== 'undefined') {
				// A tab that was frozen or restored from the back-forward cache missed bus messages.
				window.addEventListener('pageshow', onPageResume)
				detach.push(() => window.removeEventListener('pageshow', onPageResume))
			}
			if (typeof document !== 'undefined') {
				document.addEventListener('resume', onPageResume)
				detach.push(() => document.removeEventListener('resume', onPageResume))
			}
			if (authSource() !== 'none') {
				const unsubscribe = config.sync?.authClient?.subscribe?.(refreshAuth)
				if (unsubscribe) detach.push(unsubscribe)
				// A device that slept, or one whose connectivity changed, may have a clock the
				// timers did not follow.
				if (typeof window !== 'undefined') {
					for (const name of ['pageshow', 'online', 'offline'] as const) {
						window.addEventListener(name, refreshAuth)
						detach.push(() => window.removeEventListener(name, refreshAuth))
					}
				}
				if (typeof document !== 'undefined') {
					document.addEventListener('visibilitychange', refreshAuth)
					detach.push(() => document.removeEventListener('visibilitychange', refreshAuth))
				}
				refreshAuth()
			}
			refreshQuarantine()
			void controller.refreshFromDatabase()
		},
		async refreshFromDatabase() {
			const { engine } = runtime()
			try {
				await engine?.refreshOfflineMarks()
			} catch (error) {
				console.warn('[kora] Could not refresh the offline-readiness marks:', error)
			}
			try {
				// Another tab may have kept, released or pruned pins (or fetched files).
				await runtime().keep?.reload()
			} catch (error) {
				console.warn('[kora] Could not refresh the kept pins:', error)
			}
			recompute()
		},
		dispose() {
			disposed = true
			clearAuthTimers()
			for (const off of detach.splice(0)) off()
			listeners.clear()
			attached = false
		},
	}

	// The registration script reports the shell's state at start, on updatefound,
	// controllerchange and visibilitychange; it can do so before the app is ready.
	if (typeof window !== 'undefined') {
		window.addEventListener('kora:shell', recompute)
		detach.push(() => window.removeEventListener('kora:shell', recompute))
	}
	// The page cannot open storage while another tab holds it: say so instead of "ready".
	detach.push(
		emitter.on('store:tab-exclusive', () => {
			otherTab = true
			recompute()
		}),
	)
	return controller
}
