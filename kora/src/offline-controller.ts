import {
	type KoraEventEmitter,
	type OfflineAuthStatus,
	type OfflineDataStatus,
	type OfflineShellStatus,
	type OfflineStatus,
	type OfflineStorageStatus,
	computeOfflineState,
} from '@korajs/core'
import type { StoragePersistence, Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import type { KoraConfig } from './types'

/** Where the controller reads the live parts of the app from. */
export interface OfflineControllerRuntime {
	store: Store | null
	engine: SyncEngine | null
	/** Whether the opened database survives a reload (`storeInfo().durable`). */
	durable: boolean
	backend: OfflineStorageStatus['backend']
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
 * published only when it differs. Components that later steps fill in report the values
 * that can never claim readiness they cannot prove: no offline shell yet (`none`), no
 * kept files (zeros), and `unknown` sign-in whenever the app authenticates (a stored
 * session is not yet shown to restore offline, so `ready` is not claimed).
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
		const { store, engine, durable, backend } = runtime()
		const evicted = store?.getStorageEviction() ?? null
		const writes = store?.getWriteDurability().state === 'failing' ? 'failing' : 'durable'
		const storage: OfflineStorageStatus = {
			backend,
			durable,
			// A5 attaches the blob store; until a pin keeps files nothing depends on it.
			blobStoreDurable: durable,
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
		const auth: OfflineAuthStatus =
			config.sync?.auth || config.sync?.authClient
				? { state: 'unknown', offlineUntil: null }
				: { state: 'n/a', offlineUntil: null }
		const shellStatus = shell()
		const files = { kept: 0, missing: 0, bytesMissing: 0, failed: 0 }
		const { state, reasons } = computeOfflineState({
			shell: shellStatus,
			data,
			files,
			storage,
			auth,
			dataBlocked,
			pinsComplete: true,
			filesKept: false,
			filesDownloading: false,
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
			recompute()
		},
		dispose() {
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
