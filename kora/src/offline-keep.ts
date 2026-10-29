import {
	type BlobRef,
	KoraError,
	type KoraEventEmitter,
	type OfflineFileFailureReason,
	type OfflineFilesStatus,
	type OfflineKeepHandle,
	type OfflineKeepOptions,
	type OfflineKeepQuery,
	type OfflineKeepRelease,
	type OfflineKeepStatus,
	type OfflinePinInfo,
	type OfflinePinSpec,
	offlinePinId,
	toOfflinePinSpec,
} from '@korajs/core'
import {
	BlobIntegrityError,
	BlobTransferError,
	type ContentAddressedBlobStore,
	type StoragePersistence,
	type Store,
	type StoredOfflinePin,
	type StoredOfflinePinHold,
	extractBlobRefs,
} from '@korajs/store'
import type { SyncEngine, SyncQuerySubset } from '@korajs/sync'
import type { TabCoordination } from './offline-tab-coordination'
import { queryDescriptorToSyncSubset } from './sync-query-bridge'

/** The name of the Web Lock that elects the one tab downloading kept files. */
export function offlineFilesLockName(dbName: string): string {
	return `kora-offline-files-${dbName}`
}

/** Where the pins read the live parts of the app from. */
export interface OfflineKeepRuntime {
	store(): Store | null
	engine(): SyncEngine | null
	blobStore(): ContentAddressedBlobStore | null
	/** Fetch a blob into the blob store (`app.blobs.pull`); throws without a connection. */
	pull(ref: BlobRef): Promise<unknown>
	/** Whether every record of the sync view is delivered (true without sync). */
	dataComplete(): boolean
}

/** Options for {@link createOfflineKeep}. */
export interface CreateOfflineKeepOptions {
	dbName: string
	emitter: KoraEventEmitter
	persistence: Pick<StoragePersistence, 'requestInBackground'>
	coordination: TabCoordination
	runtime: OfflineKeepRuntime
	/** `navigator.storage.estimate()`; null when the browser cannot say. */
	estimate?: () => Promise<{ usage?: number; quota?: number } | null>
}

/** What `app.offline.status()` reads from the pins. */
export interface OfflineKeepSnapshot {
	/** The pin table was read and the pins are part of the sync view. */
	loaded: boolean
	pins: number
	files: OfflineFilesStatus
	/** A pin keeps files (the blob store then gates readiness). */
	filesKept: boolean
	/** This tab is downloading kept files, or still working out what is missing. */
	downloading: boolean
	/** The blob store survives a reload. */
	blobStoreDurable: boolean
	/** Pins that could not be looked at (a removed collection, a failed query): never `ready`. */
	unprovenPins: number
}

/** The pins of one opening of the database. */
export interface OfflineKeep {
	keep(query: OfflineKeepQuery, options?: OfflineKeepOptions): Promise<OfflineKeepHandle>
	release(handle: OfflineKeepHandle | string): Promise<void>
	hold(query: OfflineKeepQuery, options?: OfflineKeepOptions): Promise<OfflineKeepRelease>
	list(): OfflinePinInfo[]
	/** Read the pins, prune the holds of tabs that are gone, join the sync view. */
	load(): Promise<void>
	/** Read the pins and holds again (another tab changed them). */
	reload(): Promise<void>
	/**
	 * The sync engine exists now (it is created after the pins load): put the pins into its
	 * sync view and start watching its connection for file retries. Idempotent.
	 */
	engineReady(): Promise<void>
	/** Work out which kept files are missing now, and (in the elected tab) fetch them. */
	refreshFiles(): Promise<void>
	/** Resolves once every queued change and file pass has finished (tests, shutdown). */
	whenIdle(): Promise<void>
	snapshot(): OfflineKeepSnapshot
	/** Called whenever {@link snapshot} or a pin's status may have changed. */
	onChange(listener: () => void): () => void
	dispose(): void
}

interface PinScan {
	records: number
	refs: BlobRef[]
}

interface OwnHold {
	pin: StoredOfflinePin
	tabLock: string | null
}

function emptyStatus(): OfflineKeepStatus {
	return {
		complete: false,
		records: 0,
		files: { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, failed: 0, failedReason: null },
	}
}

const ZERO_FILES: OfflineFilesStatus = { kept: 0, missing: 0, bytesMissing: 0, failed: 0 }

function abortError(): Error {
	const error = new Error('The wait was aborted.')
	error.name = 'AbortError'
	return error
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError'
}

function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = []
	let current: unknown = error
	for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
		chain.push(current)
		current = (current as { cause?: unknown }).cause
	}
	return chain
}

/** Whether a storage write failed for lack of space (`QuotaExceededError`, legacy code 22). */
export function isQuotaError(error: unknown): boolean {
	return causeChain(error).some((link) => {
		const candidate = link as { name?: unknown; code?: unknown }
		return candidate.name === 'QuotaExceededError' || candidate.code === 22
	})
}

/**
 * What a failed fetch means: nothing yet (`offline`, retried when the connection returns),
 * or a file that could not be kept and why.
 */
export function classifyFileError(error: unknown): 'offline' | OfflineFileFailureReason {
	if (isQuotaError(error)) return 'quota'
	for (const link of causeChain(error)) {
		if (link instanceof BlobIntegrityError) return 'integrity'
		if (link instanceof BlobTransferError) {
			if (link.code === 'BLOB_CHUNK_CANCELLED') return 'offline'
			if (link.lastReason === 'not-connected') return 'offline'
			return 'unavailable'
		}
	}
	// `app.blobs.pull` without a sync connection at all.
	if (error instanceof Error && /without an active sync connection/.test(error.message)) {
		return 'offline'
	}
	return 'error'
}

/** Sync statuses in which a blob pull can reach the server. */
const CONNECTED_STATUSES: ReadonlySet<string> = new Set(['connected', 'syncing', 'synced'])

/** A holder name no stored hold has: removing it only runs the orphan check. */
const EXPLICIT_HOLDER = '\u0000explicit'

function pinSubset(pin: StoredOfflinePin): SyncQuerySubset {
	return queryDescriptorToSyncSubset(
		{ collection: pin.collection, where: pin.where },
		{ warn: false },
	)
}

function subsetKey(subsets: SyncQuerySubset[]): string {
	return JSON.stringify(subsets.map((s) => `${s.collection}:${JSON.stringify(s.where)}`).sort())
}

/**
 * The pins of `app.offline.keep()` (offline-readiness design 4.3 and 5): the pin table, the
 * holds components take on it, the one tab that downloads kept files, and the facts the
 * status reads.
 *
 * Every change to the pin table goes through one queue, so a React StrictMode double mount
 * (hold, release, hold) leaves exactly one hold. Nothing here waits on the network: a kept
 * file that cannot be fetched stays missing (not ready), and is retried when the sync
 * connection comes back.
 */
export function createOfflineKeep(options: CreateOfflineKeepOptions): OfflineKeep {
	const { dbName, emitter, persistence, coordination, runtime } = options
	const estimate =
		options.estimate ??
		(async () => {
			const manager = (
				globalThis as { navigator?: { storage?: { estimate?: () => Promise<unknown> } } }
			).navigator?.storage
			if (!manager || typeof manager.estimate !== 'function') return null
			return (await manager.estimate()) as { usage?: number; quota?: number }
		})

	let pins: StoredOfflinePin[] = []
	let holds: StoredOfflinePinHold[] = []
	let loaded = false
	let disposed = false
	let appliedSubsets = ''
	let appliedEngine: SyncEngine | null = null
	let attachedEngine: SyncEngine | null = null
	// Blobs whose bytes were read back and hashed in this session (`present` needs it).
	const verified = new Set<string>()
	const unprovenPins = new Set<string>()
	const scans = new Map<string, PinScan>()
	const present = new Set<string>()
	const failed = new Map<string, OfflineFileFailureReason>()
	let scanned = false
	let scanFailure = false
	let downloading = false
	let leader = coordination.locks === null
	let stopLeading: (() => void) | null = null
	let election: AbortController | null = null
	let again = false
	let engineKey = ''
	const listeners = new Set<() => void>()
	const handleListeners = new Map<string, Set<(status: OfflineKeepStatus) => void>>()
	const handleSerials = new Map<string, string>()
	const ownHolds = new Map<string, OwnHold>()
	const watchers = new Map<string, AbortController>()
	const detach: Array<() => void> = []
	let holdSerial = 0
	// In `explicit` mode there are no stored holds: a count per pin stands in for them.
	const explicitCounts = new Map<string, number>()
	let queue: Promise<unknown> = Promise.resolve()

	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn)
		queue = next.catch(() => undefined)
		return next
	}

	const reportError = (what: string, error: unknown): void => {
		console.error(`[kora] ${what}:`, error)
	}

	const requireStore = (): Store => {
		const store = runtime.store()
		if (!store) {
			throw new KoraError(
				'Offline keep needs the database: await app.ready first.',
				'APP_NOT_READY',
				{ fix: 'Await app.ready before app.offline.keep().' },
			)
		}
		return store
	}

	// === Status ===

	const holderCount = (pinId: string): number =>
		holds.filter((hold) => hold.pinId === pinId).length + (explicitCounts.get(pinId) ?? 0)

	const pinFilesStatus = (pin: StoredOfflinePin): OfflineKeepStatus['files'] => {
		const scan = scans.get(pin.id)
		const refs = scan?.refs ?? []
		let done = 0
		let bytesDone = 0
		let bytesTotal = 0
		let failedCount = 0
		let reason: OfflineFileFailureReason | null = null
		for (const ref of refs) {
			bytesTotal += ref.size
			if (present.has(ref.hash)) {
				done++
				bytesDone += ref.size
				continue
			}
			const why = failed.get(ref.hash)
			if (why !== undefined) {
				failedCount++
				reason = reason ?? why
			}
		}
		return {
			done,
			total: refs.length,
			bytesDone,
			bytesTotal,
			failed: failedCount,
			failedReason: reason,
		}
	}

	const pinStatus = (pin: StoredOfflinePin): OfflineKeepStatus => {
		const scan = scans.get(pin.id)
		const files = pinFilesStatus(pin)
		const filesOk = !pin.files || (scanned && files.done === files.total && files.failed === 0)
		return {
			// Never complete before the pin joined the sync view and was looked at once.
			complete:
				loaded &&
				scan !== undefined &&
				!unprovenPins.has(pin.id) &&
				runtime.dataComplete() &&
				filesOk,
			records: scan?.records ?? 0,
			files,
		}
	}

	const filesTotals = (): OfflineFilesStatus => {
		const filePins = pins.filter((pin) => pin.files)
		if (filePins.length === 0) return ZERO_FILES
		const refs = new Map<string, BlobRef>()
		for (const pin of filePins) {
			for (const ref of scans.get(pin.id)?.refs ?? []) refs.set(ref.hash, ref)
		}
		let kept = 0
		let missing = 0
		let bytesMissing = 0
		let failedCount = 0
		for (const ref of refs.values()) {
			if (present.has(ref.hash)) kept++
			else if (failed.has(ref.hash)) failedCount++
			else {
				missing++
				bytesMissing += ref.size
			}
		}
		// Until the pins were looked at once, "nothing is missing" is not known.
		if (!scanned && !scanFailure) missing = Math.max(missing, 1)
		if (filePins.some((pin) => unprovenPins.has(pin.id))) failedCount = Math.max(failedCount, 1)
		return { kept, missing, bytesMissing, failed: failedCount }
	}

	const notify = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener()
			} catch (error) {
				console.error('[kora] An app.offline listener failed:', error)
			}
		}
		for (const [id, subscribers] of [...handleListeners]) {
			if (subscribers.size === 0) continue
			const pin = pins.find((candidate) => candidate.id === id)
			const status = pin ? pinStatus(pin) : emptyStatus()
			const serial = JSON.stringify(status)
			if (handleSerials.get(id) === serial) continue
			handleSerials.set(id, serial)
			for (const listener of [...subscribers]) {
				try {
					listener(status)
				} catch (error) {
					console.error('[kora] A keep() listener failed:', error)
				}
			}
		}
	}

	const emitMeta = (kind: 'pin' | 'hold' | 'files'): void => {
		emitter.emit({ type: 'offline:meta-changed', kind })
	}

	// === The sync view ===

	const applySubsets = (): void => {
		// The engine appears after the pins load. Nothing is recorded as applied until an
		// engine took it, so a later call (engineReady) still delivers the pins.
		const engine = runtime.engine()
		if (!engine) return
		const subsets = pins.map(pinSubset)
		const key = subsetKey(subsets)
		if (key === appliedSubsets && engine === appliedEngine) return
		const first = appliedEngine !== engine
		appliedEngine = engine
		appliedSubsets = key
		// A fresh engine without pins already has the view it needs.
		if (first && subsets.length === 0) return
		engine.setPinQuerySubsets(subsets)
	}

	// === Reading the table ===

	const refreshFromDatabase = async (): Promise<boolean> => {
		const store = requireStore()
		const [nextPins, nextHolds] = await Promise.all([
			store.loadOfflinePins(),
			store.loadOfflinePinHolds(),
		])
		const changed =
			JSON.stringify(nextPins.map((p) => [p.id, p.explicit])) !==
				JSON.stringify(pins.map((p) => [p.id, p.explicit])) || nextHolds.length !== holds.length
		pins = nextPins
		holds = nextHolds
		for (const id of [...scans.keys()]) {
			if (!pins.some((pin) => pin.id === id)) {
				scans.delete(id)
				handleSerials.delete(id)
			}
		}
		return changed
	}

	// === Holder pruning (design 4.3) ===

	const liveTabIds = async (): Promise<Set<string> | null> => {
		const locks = coordination.locks
		if (!locks) return null
		try {
			const snapshot = await locks.query()
			const live = new Set<string>()
			for (const lock of snapshot.held ?? []) {
				const id = lock.name === undefined ? null : coordination.parseTabLock(lock.name)
				if (id !== null) live.add(id)
			}
			return live
		} catch (error) {
			console.warn('[kora] Could not list the open tabs; holds of closed tabs are kept:', error)
			return null
		}
	}

	const pruneTab = async (tabId: string): Promise<void> => {
		await enqueue(async () => {
			if (disposed) return
			const store = requireStore()
			const result = await store.pruneOfflinePinHolds((id) => id === tabId)
			if (result.holdsRemoved > 0) await afterPinChange('hold')
		})
	}

	const dropWatcher = (tabId: string): void => {
		watchers.get(tabId)?.abort()
		watchers.delete(tabId)
	}

	/**
	 * One shared-lock request per other tab that has holds: it is granted only once that
	 * tab's lock is released (it exited), and then prunes the tab's holds. The shared lock is
	 * held only for the length of that prune, then given back.
	 */
	const syncWatchers = (): void => {
		const locks = coordination.locks
		if (coordination.mode !== 'locks' || !locks || disposed) return
		const others = new Map<string, string | null>()
		for (const hold of holds) {
			if (hold.tabId === coordination.tabId) continue
			if (!others.has(hold.tabId) || others.get(hold.tabId) === null) {
				others.set(hold.tabId, hold.tabLock)
			}
		}
		for (const tabId of [...watchers.keys()]) if (!others.has(tabId)) dropWatcher(tabId)
		for (const [tabId, lockName] of others) {
			if (watchers.has(tabId)) continue
			if (lockName === null) {
				// A hold that never named a lock cannot be watched: prune it unless that tab
				// is still listed as open.
				void liveTabIds().then((live) => {
					if (live !== null && !live.has(tabId)) void pruneTab(tabId)
				})
				continue
			}
			const controller = new AbortController()
			watchers.set(tabId, controller)
			locks
				.request(lockName, { mode: 'shared', signal: controller.signal }, async () => {
					if (watchers.get(tabId) === controller) watchers.delete(tabId)
					await pruneTab(tabId)
				})
				.catch((error: unknown) => {
					if (!isAbortError(error)) {
						console.warn('[kora] Watching a tab for its pin holds failed:', error)
						if (watchers.get(tabId) === controller) watchers.delete(tabId)
					}
				})
		}
	}

	const pruneStale = async (): Promise<void> => {
		if (coordination.mode === 'explicit') return
		const store = requireStore()
		if (coordination.mode === 'exclusive') {
			// One tab owns the database at a time: every hold of another tab is stale.
			await store.pruneOfflinePinHolds((id) => id !== coordination.tabId)
			return
		}
		const live = await liveTabIds()
		if (live === null) return
		await store.pruneOfflinePinHolds((id) => id !== coordination.tabId && !live.has(id))
	}

	// === Files ===

	const anyFilesPin = (): boolean => pins.some((pin) => pin.files)

	/** Read a stored blob once per session: `get` hashes the bytes against the reference. */
	const verifyPresent = async (
		blobStore: ContentAddressedBlobStore,
		hash: string,
	): Promise<void> => {
		if (verified.has(hash)) {
			if (await blobStore.has(hash)) present.add(hash)
			else verified.delete(hash)
			return
		}
		if (!(await blobStore.has(hash))) return
		try {
			if ((await blobStore.get(hash)) !== null) {
				verified.add(hash)
				present.add(hash)
			}
		} catch (error) {
			// Bytes that do not hash to their reference are not a kept file: drop them so the
			// fetcher replaces them.
			console.warn(
				`[kora] A stored kept file failed its check and will be fetched again (${hash}):`,
				error,
			)
			await blobStore.delete(hash).catch(() => false)
		}
	}

	const scan = async (): Promise<void> => {
		const store = runtime.store()
		const blobStore = runtime.blobStore()
		if (!store || disposed) return
		const nextScans = new Map<string, PinScan>()
		const nextUnproven = new Set<string>()
		// One pin that cannot be read (its collection was removed from the schema) must not
		// stop the others from reaching complete: it alone stays unproven.
		for (const pin of pins) {
			try {
				const query = store.collection(pin.collection).where(pin.where)
				if (pin.files) {
					const records = await query.exec()
					const refs = new Map<string, BlobRef>()
					for (const record of records) {
						for (const ref of extractBlobRefs(record as Record<string, unknown>)) {
							refs.set(ref.hash, ref)
						}
					}
					nextScans.set(pin.id, { records: records.length, refs: [...refs.values()] })
				} else {
					nextScans.set(pin.id, { records: await query.count(), refs: [] })
				}
			} catch (error) {
				if (disposed) return
				nextUnproven.add(pin.id)
				console.warn(
					`[kora] Could not look at the pin on collection "${pin.collection}"; it stays incomplete:`,
					error,
				)
			}
		}
		try {
			if (blobStore) {
				const hashes = new Set<string>()
				for (const entry of nextScans.values()) for (const ref of entry.refs) hashes.add(ref.hash)
				present.clear()
				for (const hash of hashes) await verifyPresent(blobStore, hash)
				for (const hash of [...failed.keys()]) {
					if (present.has(hash) || !hashes.has(hash)) failed.delete(hash)
				}
			}
		} catch (error) {
			if (disposed) return
			console.warn('[kora] Could not work out which kept files are on this device:', error)
			for (const pin of pins) if (pin.files) nextUnproven.add(pin.id)
		}
		scans.clear()
		for (const [id, entry] of nextScans) scans.set(id, entry)
		unprovenPins.clear()
		for (const id of nextUnproven) unprovenPins.add(id)
		scanned = true
		scanFailure = nextUnproven.size > 0
	}

	const fetchMissing = async (): Promise<void> => {
		const blobStore = runtime.blobStore()
		if (!blobStore || !leader) return
		// A pull with no connection waits out its own transfer timeouts, which would hold this
		// pass (and every re-scan queued behind it) for minutes. With sync configured, fetch
		// only while connected; the next status change runs another pass.
		const engine = runtime.engine()
		if (engine && !CONNECTED_STATUSES.has(engine.getStatus().status)) return
		const wanted = new Map<string, BlobRef>()
		for (const pin of pins) {
			if (!pin.files) continue
			for (const ref of scans.get(pin.id)?.refs ?? []) {
				if (!present.has(ref.hash) && !failed.has(ref.hash)) wanted.set(ref.hash, ref)
			}
		}
		if (wanted.size === 0) return
		// The browser quota is the real cap: files that cannot fit fail with a reason now,
		// not after a download that would throw.
		let budget = Number.POSITIVE_INFINITY
		try {
			const usage = await estimate()
			if (usage && typeof usage.quota === 'number' && typeof usage.usage === 'number') {
				budget = Math.max(0, usage.quota - usage.usage)
			}
		} catch {
			// An estimate is a courtesy; the write itself reports a real shortage.
		}
		downloading = true
		notify()
		// Progress is announced every few files and once at the end, so a long download does
		// not re-read every pin per file.
		let sinceAnnounce = 0
		let addedAny = false
		const announce = (): void => {
			sinceAnnounce = 0
			if (addedAny) {
				addedAny = false
				emitMeta('files')
			}
			notify()
		}
		try {
			for (const ref of wanted.values()) {
				if (disposed || !leader) break
				if (ref.size > budget) {
					failed.set(ref.hash, 'quota')
					console.warn(
						`[kora] Not enough storage to keep a file of ${ref.size} bytes offline (about ${budget} bytes free).`,
					)
					if (++sinceAnnounce >= 10) announce()
					continue
				}
				try {
					await runtime.pull(ref)
					// Read once: `get` verifies the bytes hash to the reference.
					const bytes = await blobStore.get(ref.hash)
					if (bytes === null) {
						failed.set(ref.hash, 'error')
					} else {
						present.add(ref.hash)
						verified.add(ref.hash)
						budget -= ref.size
						addedAny = true
					}
				} catch (error) {
					const verdict = classifyFileError(error)
					if (verdict === 'offline') break
					failed.set(ref.hash, verdict)
					console.warn(`[kora] A kept file could not be fetched (${verdict}):`, error)
					if (verdict === 'integrity') await blobStore.delete(ref.hash).catch(() => false)
				}
				if (++sinceAnnounce >= 10) announce()
			}
		} finally {
			downloading = false
			announce()
		}
	}

	const markCompleted = async (): Promise<void> => {
		const store = runtime.store()
		if (!store) return
		for (const pin of pins) {
			const complete = pinStatus(pin).complete
			const before = pin.completedAt
			if (complete && before === null) pin.completedAt = Date.now()
			else if (!complete && before !== null) pin.completedAt = null
			else continue
			// The mark is display only; a failed write is reported and tried again next pass.
			await store.markOfflinePinCompleted(pin.id, pin.completedAt).catch((error: unknown) => {
				pin.completedAt = before
				reportError(`Could not record that the pin on "${pin.collection}" completed`, error)
			})
		}
	}

	let passRun: Promise<void> | null = null
	const pass = (): Promise<void> => {
		if (passRun) {
			again = true
			return passRun
		}
		passRun = (async () => {
			try {
				do {
					again = false
					await scan()
					notify()
					if (anyFilesPin()) await fetchMissing()
					if (again) continue
					await scan()
					await markCompleted()
					notify()
				} while (again && !disposed)
			} finally {
				passRun = null
			}
		})()
		return passRun
	}

	const ensureElection = (): void => {
		if (disposed || election || !anyFilesPin()) return
		const locks = coordination.locks
		if (!locks) {
			leader = true
			return
		}
		const controller = new AbortController()
		election = controller
		locks
			.request(
				offlineFilesLockName(dbName),
				{ mode: 'exclusive', signal: controller.signal },
				() =>
					new Promise<void>((resolve) => {
						leader = true
						stopLeading = resolve
						void pass()
					}),
			)
			.catch((error: unknown) => {
				if (!isAbortError(error)) console.warn('[kora] Electing the file fetcher failed:', error)
			})
			.finally(() => {
				leader = false
				stopLeading = null
				if (election === controller) election = null
			})
	}

	// === Changes ===

	async function afterPinChange(kind: 'pin' | 'hold'): Promise<void> {
		await refreshFromDatabase()
		applySubsets()
		syncWatchers()
		ensureElection()
		if (!anyFilesPin() && election) {
			election.abort()
			stopLeading?.()
		}
		scanned = false
		emitMeta(kind)
		notify()
		void pass()
	}

	const handleFor = (id: string): OfflineKeepHandle => {
		const find = (): StoredOfflinePin | undefined => pins.find((pin) => pin.id === id)
		const status = (): OfflineKeepStatus => {
			const pin = find()
			if (!pin) return emptyStatus()
			return pinStatus(pin)
		}
		const subscribe = (listener: (status: OfflineKeepStatus) => void): (() => void) => {
			let set = handleListeners.get(id)
			if (!set) {
				set = new Set()
				handleListeners.set(id, set)
			}
			set.add(listener)
			handleSerials.set(id, JSON.stringify(status()))
			return () => {
				handleListeners.get(id)?.delete(listener)
			}
		}
		return {
			id,
			status,
			subscribe,
			whenComplete(opts) {
				return new Promise<void>((resolve, reject) => {
					const signal = opts?.signal
					if (signal?.aborted) {
						reject(abortError())
						return
					}
					let off: (() => void) | null = null
					const finish = (): void => {
						off?.()
						signal?.removeEventListener('abort', onAbort)
					}
					const onAbort = (): void => {
						finish()
						reject(abortError())
					}
					const check = (): void => {
						if (!find()) {
							finish()
							reject(
								new KoraError('The pin was released before it completed.', 'OFFLINE_PIN_RELEASED', {
									pin: id,
								}),
							)
						} else if (status().complete) {
							finish()
							resolve()
						}
					}
					signal?.addEventListener('abort', onAbort)
					off = subscribe(check)
					check()
				})
			},
		}
	}

	const newPin = async (spec: OfflinePinSpec): Promise<{ id: string; spec: OfflinePinSpec }> => ({
		id: await offlinePinId(spec),
		spec,
	})

	const requestPersistenceForFiles = (spec: OfflinePinSpec): void => {
		// The user just asked for an offline copy of files: ask for persistent storage, in
		// the background (a prompt must never hold anything up).
		if (spec.files) persistence.requestInBackground('offline-keep')
	}

	// === Public API ===

	const keep = async (
		query: OfflineKeepQuery,
		opts?: OfflineKeepOptions,
	): Promise<OfflineKeepHandle> => {
		const { id, spec } = await newPin(toOfflinePinSpec(query, opts))
		await enqueue(async () => {
			const store = requireStore()
			await store.keepOfflinePin({ id, ...spec })
			await afterPinChange('pin')
		})
		requestPersistenceForFiles(spec)
		return handleFor(id)
	}

	const release = async (target: OfflineKeepHandle | string): Promise<void> => {
		const id = typeof target === 'string' ? target : target.id
		await enqueue(async () => {
			const store = requireStore()
			// Components of this tab still holding it (explicit mode counts them in memory)
			// keep the pin; its explicit flag is what `keep` set, and it clears here only.
			await store.releaseOfflinePin(id, { stillHeld: (explicitCounts.get(id) ?? 0) > 0 })
			await afterPinChange('pin')
		})
	}

	const decrementExplicit = (id: string): number => {
		const left = (explicitCounts.get(id) ?? 1) - 1
		if (left > 0) explicitCounts.set(id, left)
		else explicitCounts.delete(id)
		return Math.max(0, left)
	}

	const holdExplicitly = async (id: string, spec: OfflinePinSpec): Promise<OfflineKeepRelease> => {
		await enqueue(async () => {
			const store = requireStore()
			// Not `keepOfflinePin`: a component's hold must not mark the pin kept by the app,
			// or releasing the component would never remove it (and a persisted keep() must
			// survive any hold).
			await store.ensureOfflinePin({ id, ...spec })
			explicitCounts.set(id, (explicitCounts.get(id) ?? 0) + 1)
			try {
				await afterPinChange('pin')
			} catch (error) {
				decrementExplicit(id)
				throw error
			}
		})
		let released = false
		return () => {
			if (released) return Promise.resolve()
			released = true
			return enqueue(async () => {
				const store = requireStore()
				const left = decrementExplicit(id)
				// Drops the pin only when nothing else (an explicit keep, a stored hold) wants it.
				if (left === 0) await store.removeOfflinePinHold(id, EXPLICIT_HOLDER)
				await afterPinChange('pin')
			})
		}
	}

	const hold = async (
		query: OfflineKeepQuery,
		opts?: OfflineKeepOptions,
	): Promise<OfflineKeepRelease> => {
		const { id, spec } = await newPin(toOfflinePinSpec(query, opts))
		requestPersistenceForFiles(spec)
		if (coordination.mode === 'explicit') return holdExplicitly(id, spec)
		const holder = `${coordination.tabId}:${++holdSerial}`
		const tabLock = coordination.tabLock()
		await enqueue(async () => {
			const store = requireStore()
			const pin: StoredOfflinePin = {
				id,
				...spec,
				explicit: false,
				createdAt: Date.now(),
				completedAt: null,
			}
			await store.addOfflinePinHold({ id, ...spec }, { holder, tabId: coordination.tabId, tabLock })
			ownHolds.set(holder, { pin, tabLock })
			try {
				await afterPinChange('hold')
			} catch (error) {
				// The caller gets an error and never a release function: take the hold back so
				// it cannot outlive the failed call.
				ownHolds.delete(holder)
				await store.removeOfflinePinHold(id, holder).catch((undoError: unknown) => {
					reportError('Could not undo a pin hold after a failure', undoError)
				})
				throw error
			}
		})
		let released = false
		return () => {
			if (released) return Promise.resolve()
			released = true
			return enqueue(async () => {
				ownHolds.delete(holder)
				await requireStore().removeOfflinePinHold(id, holder)
				await afterPinChange('hold')
			})
		}
	}

	/**
	 * Watch the engine's connection: a reconnect retries what could not be reached (a
	 * quota failure may have cleared too), and a finished delivery may bring records with files.
	 */
	const attachEngine = (): void => {
		const engine = runtime.engine()
		if (!engine || disposed || attachedEngine === engine) return
		attachedEngine = engine
		detach.push(
			engine.onStatusChange(() => {
				const status = engine.getStatus()
				const key = `${status.phase ?? status.status}|${status.reconnecting === true}|${runtime.dataComplete()}`
				if (key !== engineKey) {
					engineKey = key
					for (const [hash, reason] of failed) {
						if (reason === 'unavailable' || reason === 'error' || reason === 'quota') {
							failed.delete(hash)
						}
					}
					void pass()
				}
				notify()
			}),
		)
		applySubsets()
	}

	/** A tab that came back from the back-forward cache records its mounted holds again. */
	const reassert = (): Promise<void> =>
		enqueue(async () => {
			if (disposed || ownHolds.size === 0) return
			const store = requireStore()
			const tabLock = coordination.tabLock()
			for (const [holder, own] of ownHolds) {
				const { pin } = own
				// The pin id is the same hash and the write idempotent: a pin another tab's
				// prune deleted meanwhile is recreated.
				await store.addOfflinePinHold(
					{ id: pin.id, collection: pin.collection, where: pin.where, files: pin.files },
					{ holder, tabId: coordination.tabId, tabLock },
				)
			}
			await afterPinChange('hold')
		})

	return {
		keep,
		release,
		hold,
		list(): OfflinePinInfo[] {
			return pins.map((pin) => ({
				id: pin.id,
				collection: pin.collection,
				where: pin.where,
				files: pin.files,
				explicit: pin.explicit,
				holders: holderCount(pin.id),
				createdAt: pin.createdAt,
				completedAt: pin.completedAt,
			}))
		},
		async load() {
			await enqueue(async () => {
				await pruneStale()
				await refreshFromDatabase()
				applySubsets()
				loaded = true
				syncWatchers()
				ensureElection()
				attachEngine()
				const store = runtime.store()
				if (store) {
					detach.push(
						store.onRecordsChanged((change) => {
							if (!pins.some((pin) => pin.files && pin.collection === change.collection)) return
							scanned = false
							void pass()
						}),
					)
				}
				detach.push(
					coordination.onResume(() => {
						reassert().catch((error: unknown) => {
							reportError('Could not record the pin holds again after the page came back', error)
						})
					}),
				)
				scanned = false
				void pass()
				notify()
			})
		},
		async reload() {
			await enqueue(async () => {
				if (!loaded || disposed) return
				await refreshFromDatabase()
				applySubsets()
				syncWatchers()
				ensureElection()
				scanned = false
				notify()
				void pass()
			})
		},
		async engineReady() {
			await enqueue(async () => {
				if (disposed) return
				attachEngine()
				// A pin set that was read before the engine existed reaches it now.
				applySubsets()
				if (loaded) {
					scanned = false
					notify()
					void pass()
				}
			})
		},
		async refreshFiles() {
			await pass()
		},
		async whenIdle() {
			for (;;) {
				const settled = queue
				await settled
				if (passRun) await passRun
				if (settled === queue && !passRun) return
			}
		},
		snapshot(): OfflineKeepSnapshot {
			const files = filesTotals()
			const filesKept = anyFilesPin()
			const blobStore = runtime.blobStore()
			return {
				loaded,
				pins: pins.length,
				files,
				filesKept,
				downloading: filesKept && (downloading || (!scanned && !scanFailure)),
				blobStoreDurable: blobStore?.durable === true,
				unprovenPins: unprovenPins.size,
			}
		},
		onChange(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		dispose() {
			disposed = true
			for (const tabId of [...watchers.keys()]) dropWatcher(tabId)
			election?.abort()
			stopLeading?.()
			for (const off of detach.splice(0)) off()
			listeners.clear()
			handleListeners.clear()
		},
	}
}
