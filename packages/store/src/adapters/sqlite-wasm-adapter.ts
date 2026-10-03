import { generateFullDDL } from '@korajs/core'
import type { KoraEventEmitter, SchemaDefinition } from '@korajs/core'
import {
	AdapterError,
	BridgeTerminatedError,
	StorageDurabilityError,
	StoreNotOpenError,
} from '../errors'
import {
	FollowerBroadcastBridge,
	type TabStorageSession,
	acquireTabStorageSession,
} from '../multi-tab/tab-storage'
import type {
	MigrationPlan,
	StorageAdapter,
	StorageFallbackReason,
	StorageOpenState,
	Transaction,
} from '../types'
import { restoreDumpStatements } from './database-dump'
import type { DatabaseDump } from './database-dump'
import { Mutex } from './sqlite-wasm-channel'
import type {
	WebWorkerBridge,
	WorkerBridge,
	WorkerRequest,
	WorkerResponse,
	WorkerSendOptions,
	WorkerStatusEvent,
} from './sqlite-wasm-channel'
import { deleteFromIndexedDB, loadDumpFromIndexedDB } from './sqlite-wasm-persistence'
import { isManifestAvailable, readManifestRecord, recordDatabase } from './storage-manifest'

type WorkerSuccessResponse = Extract<WorkerResponse, { type: 'success' }>
let warnedSharedWorkerDeprecated = false

/** Per-request options for {@link SqliteWasmAdapter.execute} and `query`. */
export interface StorageRequestOptions {
	/**
	 * Stop waiting for the response. The leader may still apply a write that
	 * already reached it; retry with the same `requestId` to stay idempotent.
	 */
	signal?: AbortSignal
	/**
	 * Stable id for this request. A follower tab's retry with the same id is
	 * answered from the leader's response cache instead of being applied twice.
	 */
	requestId?: string
}

/**
 * Options for creating a SqliteWasmAdapter.
 */
export interface SqliteWasmAdapterOptions {
	/**
	 * Injected WorkerBridge for testing. If omitted, a WebWorkerBridge is created
	 * in browser environments.
	 */
	bridge?: WorkerBridge

	/**
	 * Database name for persistence. Each database gets its own OPFS pool.
	 */
	dbName?: string

	/**
	 * URL to the sqlite-wasm-worker script. Required in browsers if no bridge is provided.
	 */
	workerUrl?: string | URL

	/** Timeout for worker / follower RPC responses. Defaults to 30000ms. */
	workerResponseTimeoutMs?: number

	/**
	 * @deprecated SharedWorker-hosted SQLite cannot use OPFS SyncAccessHandle and
	 * is never durable. Kora ignores this option and uses the dedicated-worker
	 * leader/follower path for durable multi-tab storage.
	 */
	sharedWorkerUrl?: string | URL

	/**
	 * When false, the adapter records a non-persistent open without emitting
	 * `store:opfs-unavailable`. `createApp()` uses this while it promotes the store
	 * to durable IndexedDB; direct adapter users keep the diagnostic by default.
	 */
	emitNonPersistentDiagnostic?: boolean

	/**
	 * Accept writes when durable OPFS storage could not be obtained and the
	 * database runs in memory. Defaults to false: a non-durable open or promotion
	 * emits the blocking `store:durability-lost` event and every write is refused
	 * with {@link StorageDurabilityError}, so data is never accepted and then lost
	 * on reload. Set true only for apps that can tolerate losing local writes.
	 */
	allowNonDurable?: boolean

	/**
	 * For `createApp()`: skip the durability check at open only, because the caller
	 * inspects {@link SqliteWasmAdapter.getStorageOpenState} right after open and
	 * switches to a durable backend itself. A later leader promotion that loses
	 * durable storage is still enforced.
	 */
	deferOpenDurabilityCheck?: boolean

	/**
	 * Release storage ownership when the page is frozen or hidden into the
	 * back/forward cache (`freeze` / `pagehide`), so a visible tab can take over
	 * instead of waiting on a tab that cannot run; ownership is re-acquired on
	 * `resume` / `pageshow`. Defaults to true.
	 */
	releaseOnFreeze?: boolean

	/**
	 * When set, storage diagnostics are emitted here: `store:opfs-unavailable`,
	 * `store:durability-lost`, `store:storage-blocked` (another holder has the
	 * storage; the open waits), `store:storage-migrated` and
	 * `store:db-name-collision`.
	 */
	emitter?: KoraEventEmitter

	/**
	 * @internal Used by the IndexedDB adapter: open an in-memory database that
	 * never touches OPFS (the IndexedDB adapter persists snapshots itself).
	 */
	storage?: 'opfs' | 'memory'

	/**
	 * @internal Do not read or write the storage manifest (the IndexedDB adapter's
	 * inner database and its one-shot OPFS reader manage the manifest themselves).
	 */
	skipBackendRecord?: boolean

	/**
	 * @internal Used by the IndexedDB adapter (STORE-6): runs in one transaction on this
	 * tab's OWN worker right after it opened the database as storage leader (first open
	 * or promotion), before the worker serves any other tab. The IndexedDB adapter
	 * restores its persisted snapshot here, so a snapshot is only ever restored into a
	 * freshly created worker database and never over a leader's live one. Throwing fails
	 * the open (or the promotion, which then refuses writes).
	 */
	onLeaderWorkerOpened?: (tx: Transaction) => Promise<void>
}

interface Gate {
	promise: Promise<void>
	open(): void
}

function createGate(): Gate {
	let open: () => void = () => {}
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}

/**
 * SQLite WASM adapter that communicates with a SQLite instance through a WorkerBridge.
 *
 * In browsers, one tab per database (the leader) runs a dedicated worker that
 * owns the database's OPFS pool; other tabs reach that worker over a
 * BroadcastChannel. In Node.js tests, the bridge is backed by MockWorkerBridge
 * wrapping better-sqlite3.
 *
 * Storage is durable or loud, never silently in memory (W8a): another holder of
 * the storage makes the open wait (reported with `store:storage-blocked`); only a
 * runtime without OPFS SAH support gets a non-durable database, which refuses
 * writes unless the app opted in with `allowNonDurable`.
 *
 * @example
 * ```typescript
 * // Browser usage
 * const adapter = new SqliteWasmAdapter({ workerUrl: '/sqlite-wasm-worker.js' })
 *
 * // Test usage with MockWorkerBridge
 * import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'
 * const adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
 * ```
 */
export class SqliteWasmAdapter implements StorageAdapter {
	private bridge: WorkerBridge | null = null
	/** The dedicated worker this tab runs while it is the database's leader. */
	private ownWorker: WebWorkerBridge | null = null
	private opened = false
	private readonly mutex = new Mutex()
	private readonly injectedBridge: WorkerBridge | undefined
	private readonly workerUrl: string | URL | undefined
	private readonly sharedWorkerUrl: string | URL | undefined
	private readonly workerResponseTimeoutMs: number
	private readonly dbName: string
	private readonly emitter: KoraEventEmitter | undefined
	private tabSession: TabStorageSession | null = null
	private readonly emitNonPersistentDiagnostic: boolean
	private storageOpenState: StorageOpenState | null = null
	/** Retained so a follower promoted to leader can re-open its own worker. */
	private schema: SchemaDefinition | null = null
	private promoting = false
	private closing = false
	private suspended = false
	/** Requests wait here while leadership changes hands (promotion, resume). */
	private gate: Gate | null = null
	private removeLifecycleListeners: (() => void) | null = null
	private readonly allowNonDurable: boolean
	private readonly deferOpenDurabilityCheck: boolean
	private readonly releaseOnFreeze: boolean
	private readonly storage: 'opfs' | 'memory'
	private readonly skipBackendRecord: boolean
	/** Set when this adapter lost (or never had) durable storage; writes are refused. */
	private durabilityLoss: { phase: 'open' | 'promotion'; reason: string } | null = null
	private readonly onLeaderWorkerOpened: ((tx: Transaction) => Promise<void>) | undefined

	constructor(options: SqliteWasmAdapterOptions = {}) {
		this.injectedBridge = options.bridge
		this.workerUrl = options.workerUrl
		this.sharedWorkerUrl = options.sharedWorkerUrl
		this.workerResponseTimeoutMs = options.workerResponseTimeoutMs ?? 30_000
		this.dbName = options.dbName ?? 'kora-db'
		this.emitter = options.emitter
		this.emitNonPersistentDiagnostic = options.emitNonPersistentDiagnostic ?? true
		this.allowNonDurable = options.allowNonDurable ?? false
		this.deferOpenDurabilityCheck = options.deferOpenDurabilityCheck ?? false
		this.releaseOnFreeze = options.releaseOnFreeze ?? true
		this.storage = options.storage ?? 'opfs'
		this.skipBackendRecord = options.skipBackendRecord ?? false
		this.onLeaderWorkerOpened = options.onLeaderWorkerOpened
	}

	async open(schema: SchemaDefinition): Promise<void> {
		if (this.opened) return

		const ddlStatements = generateFullDDL(schema)
		if (this.injectedBridge) {
			this.bridge = this.injectedBridge
			const response = await this.openCurrentBridge(ddlStatements)
			this.reportStorageMode(response.data)
			this.enforceDurability('open')
			this.opened = true
			return
		}
		if (this.workerUrl) {
			this.warnSharedWorkerDeprecated()
			this.schema = schema
			try {
				const response = await this.attachAndOpen(ddlStatements)
				this.reportStorageMode(response.data)
				this.enforceDurability('open')
				await this.afterLeaderOpen(response.data)
				this.opened = true
			} catch (error) {
				// A failed open must not keep the worker, the OPFS pool or the leader
				// lock for the rest of the page's life (NEW-STORE-8).
				await this.teardown()
				throw error
			}
			return
		}
		throw new AdapterError(
			'SqliteWasmAdapter requires either a bridge (for testing) or a workerUrl (for browsers). ' +
				'Pass { bridge: new MockWorkerBridge() } for tests, or { workerUrl: "/worker.js" } for browsers.',
		)
	}

	/**
	 * Join the database as leader (own worker) or follower (RPC to the leader's
	 * worker), then open it. The open waits, without a timeout, while another
	 * holder still has the storage; the worker reports that as a blocking state.
	 */
	private async attachAndOpen(ddlStatements: string[]): Promise<WorkerSuccessResponse> {
		const workerUrl = this.workerUrl
		if (!workerUrl) {
			throw new AdapterError('Durable SQLite WASM storage requires workerUrl.')
		}
		const session = await acquireTabStorageSession(this.dbName, {
			onPromote: () => {
				void this.promoteToLeader()
			},
		})
		this.tabSession = session

		if (session.role === 'leader') {
			const { WebWorkerBridge } = await import('./sqlite-wasm-channel')
			const worker = new WebWorkerBridge(workerUrl, this.workerResponseTimeoutMs, {
				onEvent: (event) => this.onWorkerEvent(event),
			})
			this.ownWorker = worker
			this.bridge = worker
			const response = await this.openLeaderWorker(worker, ddlStatements)
			this.installLifecycleListeners()
			return response
		}

		const followerBridge = new FollowerBroadcastBridge(
			session.channelName,
			this.workerResponseTimeoutMs,
		)
		this.bridge = followerBridge
		// Another runtime on this origin already owns this database name. That is
		// expected for multiple tabs of the same app (they share one leader),
		// but a bug if these are logically separate apps, so surface it so the
		// developer can give them distinct store names.
		this.emitter?.emit({
			type: 'store:db-name-collision',
			dbName: this.dbName,
			message: `Another runtime on this origin is already using database "${this.dbName}"; this runtime is sharing it as a follower. If these are separate apps, give each a distinct store name.`,
		})
		// Readiness handshake: give the leader relay a moment to answer before the
		// first RPC, so a follower opened during a leader's startup race retries the
		// handshake instead of firing into the void.
		await followerBridge.waitForLeader()
		this.installLifecycleListeners()
		return this.checkedOpen(followerBridge, ddlStatements)
	}

	/** Open the database in this tab's own worker and start serving followers. */
	private async openLeaderWorker(
		worker: WebWorkerBridge,
		ddlStatements: string[],
	): Promise<WorkerSuccessResponse> {
		const hook = this.onLeaderWorkerOpened
		if (!hook) {
			const pending = this.checkedOpen(worker, ddlStatements)
			// Posted after the open so follower requests queue behind it in the worker.
			worker.post({ id: 0, type: 'serve', channelName: this.tabSession?.channelName ?? '' })
			return pending
		}
		const response = await this.checkedOpen(worker, ddlStatements)
		// The hook (snapshot restore, STORE-6) runs before the worker serves other tabs,
		// so no follower ever reads or writes the database before it holds its data.
		await runWorkerTransaction(worker, hook)
		worker.post({ id: 0, type: 'serve', channelName: this.tabSession?.channelName ?? '' })
		return response
	}

	/**
	 * Whether this runtime owns the database's worker: the storage leader in a browser,
	 * or any adapter with an injected bridge (tests, Node). A follower tab relays every
	 * request to the leader's worker (STORE-6).
	 */
	isLeader(): boolean {
		if (this.injectedBridge) return true
		return this.tabSession?.role === 'leader'
	}

	private async checkedOpen(
		bridge: WorkerBridge,
		ddlStatements: string[],
	): Promise<WorkerSuccessResponse> {
		const response = await bridge.send(
			{
				id: 0,
				type: 'open',
				ddlStatements,
				dbName: this.dbName,
				...(this.storage === 'memory' ? { storage: 'memory' as const } : {}),
			},
			undefined,
			{ timeoutMs: Number.POSITIVE_INFINITY },
		)
		if (response.type === 'error') {
			throw new AdapterError(`Failed to open database: ${response.message}`, {
				code: response.code,
				dbName: this.dbName,
				...(response.context ?? {}),
			})
		}
		return response
	}

	private async openCurrentBridge(ddlStatements: string[]): Promise<WorkerSuccessResponse> {
		const bridge = this.bridge
		if (!bridge) throw new StoreNotOpenError()
		return this.checkedOpen(bridge, ddlStatements)
	}

	private onWorkerEvent(event: WorkerStatusEvent): void {
		if (!this.emitter) return
		const holder =
			event.resource === 'legacy-pool'
				? 'the shared OPFS pool used by older Kora versions (a tab running an older version of this app may still be open)'
				: 'another tab or worker that is still releasing it'
		if (event.kind === 'storage-blocked') {
			this.emitter.emit({
				type: 'store:storage-blocked',
				dbName: this.dbName,
				resource: event.resource,
				state: 'waiting',
				message: `Database "${this.dbName}" is waiting for ${holder}. Close other tabs of this app if this persists; Kora will not fall back to non-durable storage.`,
			})
			return
		}
		this.emitter.emit({
			type: 'store:storage-blocked',
			dbName: this.dbName,
			resource: event.resource,
			state: 'resolved',
			waitedMs: event.waitedMs,
			message: `Database "${this.dbName}" obtained its storage after waiting ${event.waitedMs}ms.`,
		})
	}

	/**
	 * Leader-only bookkeeping after a durable open: report a legacy-pool
	 * migration, move an IndexedDB-held copy into OPFS explicitly (never two
	 * disjoint copies), and record OPFS as this database's backend.
	 */
	private async afterLeaderOpen(data: unknown): Promise<void> {
		if (!this.ownWorker || this.skipBackendRecord || this.storageOpenState?.persistent !== true) {
			return
		}
		const info = (typeof data === 'object' && data !== null ? data : {}) as {
			migratedFromLegacy?: boolean
		}
		if (info.migratedFromLegacy === true) {
			this.emitter?.emit({
				type: 'store:storage-migrated',
				dbName: this.dbName,
				from: 'legacy-opfs-pool',
				to: 'opfs',
				message: `Database "${this.dbName}" moved from the shared pre-1.0 OPFS pool into its own pool.`,
			})
		}
		if (!isManifestAvailable()) return

		let recordedBackend: string | null = null
		try {
			recordedBackend = (await readManifestRecord(this.dbName))?.backend ?? null
		} catch (error) {
			console.warn(`[kora] Could not read the storage manifest for "${this.dbName}":`, error)
		}
		if (recordedBackend === 'indexeddb') {
			// The authoritative copy is in IndexedDB (an earlier session ran without
			// OPFS). Move it here before anything reads or writes; a failure fails
			// the open instead of showing the older OPFS copy.
			const dump = await loadDumpFromIndexedDB<DatabaseDump>(this.dbName)
			if (dump) {
				await this.applyDumpThroughWorker(this.ownWorker, dump)
			}
			this.emitter?.emit({
				type: 'store:storage-migrated',
				dbName: this.dbName,
				from: 'indexeddb',
				to: 'opfs',
				message: `Database "${this.dbName}" moved from IndexedDB into OPFS.`,
			})
		}
		try {
			await recordDatabase({
				dbName: this.dbName,
				backend: 'opfs',
				...(this.storageOpenState.poolName ? { poolName: this.storageOpenState.poolName } : {}),
			})
			if (recordedBackend === 'indexeddb') {
				await deleteFromIndexedDB(this.dbName)
			}
		} catch (error) {
			console.warn(`[kora] Could not update the storage manifest for "${this.dbName}":`, error)
		}
	}

	private async applyDumpThroughWorker(worker: WorkerBridge, dump: DatabaseDump): Promise<void> {
		const check = async (request: WorkerRequest, what: string): Promise<void> => {
			const response = await worker.send(request)
			if (response.type === 'error') {
				throw new AdapterError(`${what} failed: ${response.message}`, { dbName: this.dbName })
			}
		}
		await check({ id: 0, type: 'begin' }, 'BEGIN IndexedDB import')
		try {
			for (const statement of restoreDumpStatements(dump)) {
				await check(
					{ id: 0, type: 'execute', sql: statement.sql, params: statement.params },
					'IndexedDB import',
				)
			}
			await check({ id: 0, type: 'commit' }, 'COMMIT IndexedDB import')
		} catch (error) {
			await worker.send({ id: 0, type: 'rollback' }).catch(() => undefined)
			throw error
		}
	}

	/**
	 * Surface a `store:opfs-unavailable` diagnostic when the worker reported that
	 * persistence silently degraded to an in-memory database, so a data-loss
	 * condition is observable instead of failing silently. A persistent open (or a
	 * bridge that does not report a mode, e.g. the Node mock) emits nothing.
	 */
	private reportStorageMode(data: unknown): void {
		this.storageOpenState = parseStorageOpenState(data)
		if (!this.emitNonPersistentDiagnostic || !this.emitter || !this.storageOpenState) {
			return
		}
		if (this.storageOpenState.persistent === false && this.storage === 'opfs') {
			const reason = this.storageOpenState.fallbackReason ?? 'unsupported'
			this.emitter.emit({
				type: 'store:opfs-unavailable',
				dbName: this.dbName,
				reason,
				message: `OPFS persistence is unavailable (${reason}) for database "${this.dbName}"; the store is running in memory and data will not survive a reload.`,
			})
		}
	}

	getStorageOpenState(): StorageOpenState | null {
		return this.storageOpenState
	}

	/**
	 * Durable or loud, never silent (NEW-STORE-6). When the open or a promotion
	 * ended on non-persistent storage and the app did not opt into that, emit the
	 * blocking `store:durability-lost` event and refuse every later write. A
	 * bridge that reports no mode (the Node mock) is not judged.
	 */
	private enforceDurability(
		phase: 'open' | 'promotion',
		failure?: { reason: 'open-failed'; message: string },
	): void {
		if (this.allowNonDurable) return
		if (phase === 'open' && this.deferOpenDurabilityCheck && !failure) return
		let reason: 'lock-conflict' | 'timeout' | 'unsupported' | 'open-failed'
		if (failure) {
			reason = failure.reason
		} else if (this.storageOpenState?.persistent === false) {
			reason = this.storageOpenState.fallbackReason ?? 'unsupported'
		} else {
			this.durabilityLoss = null
			return
		}
		this.durabilityLoss = { phase, reason }
		this.emitter?.emit({
			type: 'store:durability-lost',
			dbName: this.dbName,
			phase,
			reason,
			message:
				`Database "${this.dbName}" has no durable storage (${reason} during ${phase}); ` +
				`writes are refused until the app reloads with durable storage.${failure ? ` ${failure.message}` : ''}`,
		})
	}

	private guardDurableWrite(): void {
		if (this.durabilityLoss) {
			throw new StorageDurabilityError(
				this.dbName,
				this.durabilityLoss.phase,
				this.durabilityLoss.reason,
			)
		}
	}

	private warnSharedWorkerDeprecated(): void {
		if (!this.sharedWorkerUrl || warnedSharedWorkerDeprecated) {
			return
		}
		warnedSharedWorkerDeprecated = true
		console.warn(
			'[kora] sharedWorkerUrl is deprecated and ignored: SharedWorker-hosted SQLite ' +
				'cannot use OPFS and is never durable. Kora uses the durable dedicated-worker ' +
				'leader/follower path for multi-tab storage.',
		)
	}

	/**
	 * Close the database. A leader closes the database file and releases the OPFS
	 * pool inside its worker, terminates the worker, and only then releases the
	 * tab leader lock, so the next leader never races a still-running worker for
	 * the file handles (NEW-STORE-10). A follower just leaves.
	 */
	async close(): Promise<void> {
		if (!this.bridge && !this.tabSession) return
		this.closing = true
		try {
			if (this.injectedBridge && this.bridge) {
				await this.bridge.send({ id: 0, type: 'close' })
			} else if (this.ownWorker && !this.ownWorker.isTerminated()) {
				const response = await this.ownWorker
					.send({ id: 0, type: 'close' }, undefined, { timeoutMs: 5000 })
					.catch((error: unknown) => ({
						id: 0,
						type: 'error' as const,
						message: error instanceof Error ? error.message : String(error),
						code: 'CLOSE_FAILED',
					}))
				if (response.type === 'error') {
					// Terminating the worker below still releases the pool.
					console.warn(`[kora] Closing "${this.dbName}" in its worker failed:`, response.message)
				}
			}
		} finally {
			await this.teardown()
			this.closing = false
		}
	}

	/**
	 * Release everything this adapter holds, in ownership order: lifecycle
	 * listeners, then the worker (which holds the OPFS pool and its Web Lock),
	 * then the tab leader lock or queued promotion request.
	 */
	private async teardown(): Promise<void> {
		this.removeLifecycleListeners?.()
		this.removeLifecycleListeners = null
		const session = this.tabSession
		this.tabSession = null
		session?.stopRelay?.()
		this.bridge?.terminate()
		this.bridge = null
		this.ownWorker = null
		if (session) {
			if (session.releaseLock) {
				await session.releaseLock()
			}
			session.cancelPromotionWatch?.()
		}
		this.opened = false
		this.suspended = false
		const gate = this.gate
		this.gate = null
		gate?.open()
	}

	/**
	 * Promotes a follower to leader after the previous leader released the storage
	 * lock (its tab closed, crashed, or suspended on freeze). The new worker waits
	 * on the pool's Web Lock and handles, so it never races the previous worker.
	 * Requests issued during the hand-off wait for it; requests that were in
	 * flight to the old leader fail with a retriable `BridgeTerminatedError`.
	 */
	private async promoteToLeader(): Promise<void> {
		if (
			this.promoting ||
			this.closing ||
			!this.opened ||
			this.workerUrl === undefined ||
			this.schema === null
		) {
			return
		}
		this.promoting = true
		const gate = createGate()
		this.gate = gate

		try {
			const { WebWorkerBridge } = await import('./sqlite-wasm-channel')
			if (this.closing || !this.opened) return
			const worker = new WebWorkerBridge(this.workerUrl, this.workerResponseTimeoutMs, {
				onEvent: (event) => this.onWorkerEvent(event),
			})
			const previousBridge = this.bridge
			this.bridge = worker
			this.ownWorker = worker
			if (this.tabSession) {
				this.tabSession.role = 'leader'
			}
			previousBridge?.terminate()

			// Re-open against our own worker. DDL is idempotent, and the OPFS data the
			// old leader persisted is readable once its worker is gone.
			const ddlStatements = generateFullDDL(this.schema)
			let response: WorkerSuccessResponse
			try {
				response = await this.openLeaderWorker(worker, ddlStatements)
			} catch (error) {
				// The promoted worker could not obtain durable storage. Never let it
				// run silently in memory.
				this.storageOpenState = { persistent: false, mode: 'memory' }
				this.enforceDurability('promotion', {
					reason: 'open-failed',
					message: error instanceof Error ? error.message : String(error),
				})
				return
			}
			this.storageOpenState = parseStorageOpenState(response.data) ?? this.storageOpenState
			this.enforceDurability('promotion')
			try {
				await this.afterLeaderOpen(response.data)
			} catch (error) {
				this.enforceDurability('promotion', {
					reason: 'open-failed',
					message: error instanceof Error ? error.message : String(error),
				})
			}
		} finally {
			this.promoting = false
			if (this.gate === gate) this.gate = null
			gate.open()
		}
	}

	/**
	 * Page Lifecycle: a frozen or bfcached page cannot run, so it must not keep
	 * other tabs waiting on its storage. Leaders terminate their worker (freeing
	 * the OPFS pool) and then release the leader lock, so a visible tab is
	 * promoted; followers withdraw their queued lock request so a frozen tab is
	 * never granted leadership it cannot use. Never uses Web Locks `steal`.
	 */
	private installLifecycleListeners(): void {
		if (!this.releaseOnFreeze || this.removeLifecycleListeners) return
		if (typeof addEventListener !== 'function' || typeof document === 'undefined') return
		const onFreeze = (): void => this.suspend()
		const onPageHide = (): void => this.suspend()
		const onResume = (): void => {
			void this.resume()
		}
		const onPageShow = (event: Event): void => {
			if ((event as PageTransitionEvent).persisted) void this.resume()
		}
		document.addEventListener('freeze', onFreeze)
		document.addEventListener('resume', onResume)
		addEventListener('pagehide', onPageHide)
		addEventListener('pageshow', onPageShow)
		this.removeLifecycleListeners = () => {
			document.removeEventListener('freeze', onFreeze)
			document.removeEventListener('resume', onResume)
			removeEventListener('pagehide', onPageHide)
			removeEventListener('pageshow', onPageShow)
		}
	}

	/** Synchronous by necessity: a `freeze` handler gets no further turns. */
	private suspend(): void {
		if (!this.opened || this.suspended || this.closing || this.promoting) return
		this.suspended = true
		this.gate = createGate()
		const session = this.tabSession
		this.tabSession = null
		// Worker (pool holder) first, then the leader lock (NEW-STORE-10).
		this.bridge?.terminate()
		this.bridge = null
		this.ownWorker = null
		if (session) {
			void session.releaseLock?.()
			session.cancelPromotionWatch?.()
		}
	}

	private async resume(): Promise<void> {
		if (!this.suspended || this.closing || this.schema === null) return
		const gate = this.gate
		try {
			const response = await this.attachAndOpen(generateFullDDL(this.schema))
			this.reportStorageMode(response.data)
			this.enforceDurability('promotion')
			await this.afterLeaderOpen(response.data)
		} catch (error) {
			this.enforceDurability('promotion', {
				reason: 'open-failed',
				message: error instanceof Error ? error.message : String(error),
			})
		} finally {
			this.suspended = false
			if (this.gate === gate) this.gate = null
			gate?.open()
		}
	}

	/**
	 * Non-transactional write. Takes the same mutex as {@link transaction}, so it
	 * never lands inside this tab's open transaction and is never rolled back
	 * with it (STORE-8). Inside a transaction callback, use the `tx` handle.
	 */
	async execute(sql: string, params?: unknown[], options?: StorageRequestOptions): Promise<void> {
		this.guardOpen()
		this.guardDurableWrite()
		const release = await this.mutex.acquire()
		try {
			const response = await this.sendRequest(
				{
					id: 0,
					type: 'execute',
					sql,
					params,
					...(options?.requestId ? { requestId: options.requestId } : {}),
				},
				options?.signal ? { signal: options.signal } : undefined,
			)
			if (response.type === 'error') {
				throw new AdapterError(`Execute failed: ${response.message}`, { sql, params })
			}
		} finally {
			release()
		}
	}

	/**
	 * Non-transactional read. Waits for this tab's open transaction to finish, so
	 * it never observes uncommitted (possibly rolled-back) rows (STORE-8).
	 */
	async query<T>(sql: string, params?: unknown[], options?: StorageRequestOptions): Promise<T[]> {
		this.guardOpen()
		const release = await this.mutex.acquire()
		try {
			const response = await this.sendRequest(
				{
					id: 0,
					type: 'query',
					sql,
					params,
					...(options?.requestId ? { requestId: options.requestId } : {}),
				},
				options?.signal ? { signal: options.signal } : undefined,
			)
			if (response.type === 'error') {
				throw new AdapterError(`Query failed: ${response.message}`, { sql, params })
			}
			return (response.data as T[]) ?? []
		} finally {
			release()
		}
	}

	async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		this.guardOpen()
		this.guardDurableWrite()

		const release = await this.mutex.acquire()
		let txBridge: WorkerBridge | null = null
		// Every statement of the span must reach the worker that ran BEGIN. If
		// leadership changed hands mid-transaction, the old worker rolled it back
		// (or is gone); sending the rest to the new worker would autocommit a
		// partial transaction, so fail with a retriable error instead.
		const sendInSpan = async (request: WorkerRequest): Promise<WorkerResponse> => {
			if (txBridge === null || this.bridge !== txBridge) {
				throw new BridgeTerminatedError(request.type, 'storage leader changed during transaction')
			}
			return txBridge.send(request)
		}
		try {
			while (this.gate) {
				await this.gate.promise
			}
			txBridge = this.bridge
			if (!txBridge) throw new StoreNotOpenError()
			const begin = await sendInSpan({ id: 0, type: 'begin' })
			if (begin.type === 'error') {
				throw new AdapterError(`BEGIN transaction failed: ${begin.message}`)
			}

			const tx: Transaction = {
				execute: async (sql: string, params?: unknown[]): Promise<void> => {
					const response = await sendInSpan({ id: 0, type: 'execute', sql, params })
					if (response.type === 'error') {
						throw new AdapterError(`Transaction execute failed: ${response.message}`, {
							sql,
							params,
						})
					}
				},
				query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
					const response = await sendInSpan({ id: 0, type: 'query', sql, params })
					if (response.type === 'error') {
						throw new AdapterError(`Transaction query failed: ${response.message}`, { sql, params })
					}
					return (response.data as T[]) ?? []
				},
			}

			await fn(tx)
			const commit = await sendInSpan({ id: 0, type: 'commit' })
			if (commit.type === 'error') {
				throw new AdapterError(`COMMIT transaction failed: ${commit.message}`)
			}
		} catch (error) {
			// Attempt rollback on the worker that ran BEGIN, but don't mask the
			// original error.
			try {
				if (txBridge && this.bridge === txBridge) {
					await txBridge.send({ id: 0, type: 'rollback' })
				}
			} catch {
				// Rollback failure is secondary to the original error
			}
			throw error
		} finally {
			release()
		}
	}

	async migrate(from: number, to: number, migration: MigrationPlan): Promise<void> {
		this.guardOpen()
		this.guardDurableWrite()

		const release = await this.mutex.acquire()
		try {
			await this.sendChecked({ id: 0, type: 'begin' }, 'BEGIN migration')

			for (const sql of migration.statements) {
				const response = await this.sendRequest({ id: 0, type: 'execute', sql })
				if (response.type === 'error') {
					throw new AdapterError(`Migration from v${from} to v${to} failed: ${response.message}`, {
						from,
						to,
					})
				}
			}

			await this.sendChecked({ id: 0, type: 'commit' }, 'COMMIT migration')
		} catch (error) {
			try {
				await this.sendRequest({ id: 0, type: 'rollback' })
			} catch {
				// Rollback failure is secondary
			}
			if (error instanceof AdapterError) throw error
			throw new AdapterError(
				`Migration from v${from} to v${to} failed: ${(error as Error).message}`,
				{ from, to },
			)
		} finally {
			release()
		}
	}

	/**
	 * Export the database as a Uint8Array (for IndexedDB persistence).
	 * Only available when the database is open.
	 */
	async exportDatabase(): Promise<Uint8Array> {
		this.guardOpen()
		const release = await this.mutex.acquire()
		try {
			const response = await this.sendRequest({ id: 0, type: 'export' })
			if (response.type === 'error') {
				throw new AdapterError(`Export failed: ${response.message}`, {
					code: response.code,
					context: response.context,
				})
			}
			return response.data as Uint8Array
		} finally {
			release()
		}
	}

	/**
	 * Import a serialized database snapshot.
	 */
	async importDatabase(data: Uint8Array): Promise<void> {
		this.guardOpen()
		this.guardDurableWrite()
		const release = await this.mutex.acquire()
		try {
			const response = await this.sendRequest({ id: 0, type: 'import', data })
			if (response.type === 'error') {
				throw new AdapterError(`Import failed: ${response.message}`)
			}
		} finally {
			release()
		}
	}

	private guardOpen(): void {
		if (!this.opened || (!this.bridge && !this.gate)) {
			throw new StoreNotOpenError()
		}
	}

	private async sendRequest(
		request: WorkerRequest,
		options?: WorkerSendOptions,
	): Promise<WorkerResponse> {
		// While leadership changes hands, wait for the new bridge instead of
		// sending into a torn-down one.
		while (this.gate) {
			await this.gate.promise
		}
		const bridge = this.bridge
		if (!bridge) {
			throw new StoreNotOpenError()
		}
		return bridge.send(request, undefined, options)
	}

	private async sendChecked(request: WorkerRequest, description: string): Promise<void> {
		const response = await this.sendRequest(request)
		if (response.type === 'error') {
			throw new AdapterError(`${description} failed: ${response.message}`)
		}
	}
}

/**
 * Run `fn` in one transaction sent straight to `worker`, bypassing the adapter's mutex
 * and leadership gate (the caller is the leader opening its own worker).
 */
async function runWorkerTransaction(
	worker: WorkerBridge,
	fn: (tx: Transaction) => Promise<void>,
): Promise<void> {
	const send = async (request: WorkerRequest, what: string): Promise<WorkerResponse> => {
		const response = await worker.send(request)
		if (response.type === 'error') {
			throw new AdapterError(`${what} failed: ${response.message}`, {
				code: response.code,
				...(request.type === 'execute' || request.type === 'query' ? { sql: request.sql } : {}),
			})
		}
		return response
	}
	await send({ id: 0, type: 'begin' }, 'BEGIN')
	try {
		await fn({
			execute: async (sql, params) => {
				await send({ id: 0, type: 'execute', sql, params }, 'Leader open execute')
			},
			query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
				const response = await send({ id: 0, type: 'query', sql, params }, 'Leader open query')
				return ((response as WorkerSuccessResponse).data as T[]) ?? []
			},
		})
		await send({ id: 0, type: 'commit' }, 'COMMIT')
	} catch (error) {
		await worker.send({ id: 0, type: 'rollback' }).catch(() => undefined)
		throw error
	}
}

function parseStorageOpenState(data: unknown): StorageOpenState | null {
	if (typeof data !== 'object' || data === null) {
		return null
	}
	const mode = data as {
		persistent?: boolean
		fallbackReason?: StorageFallbackReason
		poolName?: string
		journalMode?: string
	}
	if (typeof mode.persistent !== 'boolean') {
		return null
	}
	return {
		persistent: mode.persistent,
		mode: mode.persistent ? 'opfs' : 'memory',
		...(mode.fallbackReason ? { fallbackReason: mode.fallbackReason } : {}),
		...(typeof mode.poolName === 'string' ? { poolName: mode.poolName } : {}),
		...(typeof mode.journalMode === 'string' ? { journalMode: mode.journalMode } : {}),
	}
}
