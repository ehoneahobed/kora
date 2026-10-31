import { OFFLINE_STATUS_SERVER_RENDER, OFFLINE_STATUS_UNKNOWN } from '@korajs/core/bindings'
import { KoraError, type SchemaInput } from '@korajs/core/lite'
import { SimpleEventEmitter, currentWriteObserver, runWithWriteObserver } from '@korajs/core/lite'
import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store/lite'
import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync/lite'
import { createCollectionAccessor } from './collection-accessor'
import { applyDescriptor } from './deferred-query'
import { wireFirstDataSignal } from './first-data-signal'
import { offlineSyncDiagnostics } from './offline-sync-diagnostics'
import { PreReadyWriteQueue } from './pre-ready-writes'
import { warnShadowedCollections } from './reserved-app-properties'
import { ServerRenderingAppError, isServerRenderingInert } from './ssr'
import type { InternalStorageWritesApi } from './storage-accessor'
import type {
	EncryptionControl,
	KoraApp,
	KoraConfig,
	OfflineApi,
	StorageApi,
	StoreInfo,
	SyncControl,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'
import { validateCreateAppConfig } from './validate-config'
import { wireSyncEventForwarding } from './wire-sync-event-forwarding'

/**
 * Creates a new Kora application instance.
 *
 * Returns the app's shell at once: collection accessors, `ready`, events and the sync,
 * offline, storage and encryption controls. The runtime behind them (the local store, the
 * sync engine, SQLite, offline readiness) is a separate chunk that loads with a dynamic
 * `import()` right after the first paint, so it is not part of the JavaScript the first
 * paint waits for. Everything the shell offers before then either works from the schema
 * alone (collections, deferred queries, queued hook writes) or reports the state of an
 * app that is not open yet, and everything behind `await app.ready` is as it always was.
 *
 * Collection accessors are always available through `app.collections`. Non-reserved names
 * also retain the convenient direct form (for example, `app.todos`). A collection named
 * after a framework property (`ready`, `events`, `sync`, `storage`, ... see
 * `RESERVED_APP_PROPERTIES`) is only reachable as `app.collections.<name>`; createApp
 * warns about it in development.
 *
 * Reading `app.ready` starts loading the runtime at once (a framework provider does it
 * after its first render); so does anything else that needs it. During a server render (no
 * `window`, see {@link KoraConfig.ssr}) the app is inert: it loads nothing, opens no
 * storage and starts no sync, and `app.ready` rejects with `ServerRenderingAppError`
 * (handled, so it never surfaces as an unhandled rejection).
 */
export function createApp<const S extends SchemaInput>(config: TypedKoraConfig<S>): TypedKoraApp<S>
export function createApp(config: KoraConfig): KoraApp
export function createApp<const S extends SchemaInput>(
	config: TypedKoraConfig<S> | KoraConfig,
): TypedKoraApp<S> | KoraApp {
	validateCreateAppConfig(config)

	const emitter = new SimpleEventEmitter()
	if (config.onSyncEvent) {
		wireSyncEventForwarding(emitter, config.onSyncEvent)
	}

	// DX-6: a module-scope createApp evaluated by a server renderer must not open a
	// database (or start sync) in the server process.
	const inert = isServerRenderingInert(config)
	const baseName = config.store?.name ?? 'kora-db'
	const queryStoreCache = new QueryStoreCache(baseName)
	const authClient = config.sync?.authClient
	const queue = new PreReadyWriteQueue({
		dbName: baseName,
		...(authClient?.resolveUserId
			? { resolveOwner: () => authClient.resolveUserId?.() ?? Promise.resolve(undefined) }
			: {}),
		...(inert ? { journal: null, locks: null } : {}),
	})

	// The runtime app, once its chunk has loaded and created it; `opened` flips when its
	// `ready` resolved, which is also when the writes queued before are applied.
	let runtime: KoraApp | null = null
	let opened = false
	let closed = false
	let started: Promise<void> | null = null
	let publicReady: Promise<void> | null = null
	// Settles when the runtime opened (or failed to). Waiting on it does not ask for the
	// runtime; the first-paint scheduler, a provider or a call that needs it does.
	let settleOpen: { resolve: () => void; reject: (error: unknown) => void } = {
		resolve: () => {},
		reject: () => {},
	}
	const runtimeOpen = new Promise<void>((resolve, reject) => {
		settleOpen = { resolve, reject }
	})
	// The error reaches callers through `app.ready` and the calls that await the runtime.
	runtimeOpen.catch(() => {})
	const inertFailure: Promise<void> | null = inert ? inertReady() : null
	inertFailure?.catch(() => {})
	// `connect()` before the runtime exists is remembered: the socket opens while the store does.
	let connectRequested = config.sync?.autoConnect === true
	const notices: LateSubscriptions[] = []

	const start = (): Promise<void> => {
		if (inertFailure) return inertFailure
		if (started) return started
		const attempt = (async () => {
			if (closed) throw new KoraError('The app was closed before it opened.', 'APP_CLOSED')
			const { createRuntimeApp } = await import('./runtime-app')
			if (closed) throw new KoraError('The app was closed before it opened.', 'APP_CLOSED')
			runtime = createRuntimeApp(config, emitter, {
				queryStoreCache,
				warmTransport: () => connectRequested,
				applyPreReadyWrites: (store) => queue.apply(store),
			})
			for (const subscriptions of notices) subscriptions.flush()
			await runtime.ready
			opened = true
			for (const subscriptions of notices) subscriptions.flush()
		})()
		started = attempt
		attempt.then(settleOpen.resolve, (error: unknown) => {
			// The queued writes learn the store did not open; whoever reads `ready` sees the error.
			void queue.fail(error)
			settleOpen.reject(error)
		})
		return attempt
	}

	/** Start loading the runtime after the browser had a chance to paint. */
	if (!inert) {
		if (typeof window !== 'undefined' && typeof document !== 'undefined') {
			afterFirstPaint(() => {
				if (!closed) void start().catch(() => {})
			})
		} else {
			// No paint to wait for (a Node program, a worker): open at once, like before.
			void start().catch(() => {})
		}
	}

	const whenOpen = (): Promise<void> => {
		const opening = start()
		opening.catch(() => {})
		return opening
	}
	const getStore = (): Store | null => (opened && runtime ? runtime.getStore() : null)
	const host = {
		getStore,
		queue,
		whenReady: whenOpen,
		resolve(descriptor: import('@korajs/store').QueryDescriptor) {
			const store = getStore()
			if (!store) return null
			return applyDescriptor(
				store.collection(descriptor.collection).where(descriptor.where),
				descriptor,
			)
		},
	}

	const collections: Record<string, ReturnType<typeof createCollectionAccessor>> = Object.create(
		null,
	)
	for (const collectionName of Object.keys(config.schema.collections)) {
		Object.defineProperty(collections, collectionName, {
			get() {
				return createCollectionAccessor(collectionName, host)
			},
			enumerable: true,
			configurable: false,
		})
	}
	Object.freeze(collections)

	/** `await ready` for a call that needs the runtime now, then the runtime app. */
	const rt = async (): Promise<KoraApp> => {
		await whenOpen()
		if (!runtime) throw new Error('Kora runtime is not available.')
		return runtime
	}

	/**
	 * Run `call` on the runtime app. Once the store is open it runs in the caller's own turn,
	 * so the write observer a mutation hook installed is still current; before that, the
	 * observer is captured and restored around the delayed call.
	 */
	const withRuntime = <T>(call: (app: KoraApp) => Promise<T>): Promise<T> => {
		if (opened && runtime) return call(runtime)
		const observer = currentWriteObserver()
		return rt().then((app) => runWithWriteObserver(observer, () => call(app)))
	}

	const sync = config.sync ? createSyncFacade() : null
	const encryption = createEncryptionFacade()
	const offline = createOfflineFacade()
	const storage = createStorageFacade()

	function createSyncFacade(): SyncControl {
		const statusListeners = new LateSubscriptions()
		notices.push(statusListeners)
		const status = (): SyncStatusInfo =>
			opened && runtime?.sync ? runtime.sync.status : OFFLINE_SYNC_STATUS
		const control: SyncControl = {
			get status() {
				return status()
			},
			getStatus: () => (opened && runtime?.sync ? runtime.sync.getStatus() : OFFLINE_SYNC_STATUS),
			subscribeStatus: (listener) =>
				statusListeners.add(listener, () =>
					opened && runtime?.sync ? runtime.sync.subscribeStatus(listener) : null,
				),
			async connect() {
				connectRequested = true
				// Waits for the runtime without asking for it: it loads after the first paint, and
				// the socket opens while its store does.
				await (inertFailure ?? runtimeOpen)
				await (runtime?.sync ?? throwNoSync()).connect()
			},
			async disconnect() {
				connectRequested = false
				await (await rt()).sync?.disconnect()
			},
			async reconnect() {
				await (await rt()).sync?.reconnect()
			},
			async setQuerySubsets(subsets) {
				await (await rt()).sync?.setQuerySubsets(subsets)
			},
			async waitForSettled(options) {
				const app = await rt()
				if (!app.sync) throwNoSync()
				return app.sync.waitForSettled(options)
			},
			async retryNow() {
				await (await rt()).sync?.retryNow()
			},
			clearSchemaBlock() {
				runtime?.sync?.clearSchemaBlock()
			},
			exportDiagnostics() {
				if (runtime?.sync) return runtime.sync.exportDiagnostics()
				return offlineSyncDiagnostics(config)
			},
			async getRejectedOperations() {
				return (await (await rt()).sync?.getRejectedOperations()) ?? []
			},
			async clearRejectedOperations(operationIds) {
				await (await rt()).sync?.clearRejectedOperations(operationIds)
			},
			async getHeldOperations() {
				return (await (await rt()).sync?.getHeldOperations()) ?? []
			},
			async assignHeld(nodeId, to) {
				const app = await rt()
				if (!app.sync) throwNoSync()
				await app.sync.assignHeld(nodeId, to)
			},
			async discardHeld(nodeId) {
				const app = await rt()
				if (!app.sync) throwNoSync()
				return app.sync.discardHeld(nodeId)
			},
		}
		return control
	}

	function createEncryptionFacade(): EncryptionControl | null {
		const enabled = config.sync?.encryption?.enabled === true
		if (!enabled) return null
		const listeners = new LateSubscriptions()
		notices.push(listeners)
		const keyringName = config.sync?.encryption?.keyring ?? 'default'
		const lockedStatus: ReturnType<EncryptionControl['getStatus']> = {
			state: 'locked',
			keyring: keyringName,
			keyVersion: null,
			keyId: null,
			availableVersions: [],
			cache: 'none',
			message: 'The app is still opening.',
		}
		const via = async <T>(call: (control: EncryptionControl) => Promise<T>): Promise<T> => {
			const app = await rt()
			if (!app.encryption) throw new KoraError('Encryption is not enabled.', 'ENCRYPTION_DISABLED')
			return call(app.encryption)
		}
		return {
			getStatus: () => runtime?.encryption?.getStatus() ?? lockedStatus,
			onStatusChange: (listener) =>
				listeners.add(listener, () => runtime?.encryption?.onStatusChange(listener) ?? null),
			unlock: (passphrase) => via((control) => control.unlock(passphrase)),
			lock: () => via((control) => control.lock()),
			rotateKey: () => via((control) => control.rotateKey()),
			changePassphrase: (newPassphrase, options) =>
				via((control) => control.changePassphrase(newPassphrase, options)),
			enableRecovery: () => via((control) => control.enableRecovery()),
			recover: (recoveryKey, newPassphrase) =>
				via((control) => control.recover(recoveryKey, newPassphrase)),
			startNewKeyring: () => via((control) => control.startNewKeyring()),
		}
	}

	function createOfflineFacade(): OfflineApi {
		const listeners = new LateSubscriptions()
		notices.push(listeners)
		return {
			status: () =>
				runtime?.offline.status() ??
				(inert ? OFFLINE_STATUS_SERVER_RENDER : OFFLINE_STATUS_UNKNOWN),
			subscribe: (listener) =>
				listeners.add(listener, () => runtime?.offline.subscribe(listener) ?? null),
			async acknowledgeEviction() {
				await (await rt()).offline.acknowledgeEviction()
			},
			async keep(query, options) {
				return (await rt()).offline.keep(query, options)
			},
			async release(handle) {
				await (await rt()).offline.release(handle)
			},
			async hold(query, options) {
				return (await rt()).offline.hold(query, options)
			},
			list: () => runtime?.offline.list() ?? [],
		}
	}

	function createStorageFacade(): StorageApi {
		const writeListeners = new LateSubscriptions()
		const rollbackListeners = new LateSubscriptions()
		notices.push(writeListeners, rollbackListeners)
		const internalWrites = (): InternalStorageWritesApi | null =>
			(runtime?.storage.writes as InternalStorageWritesApi | undefined) ?? null
		const writes: InternalStorageWritesApi = {
			status: () => runtime?.storage.writes.status() ?? { state: 'durable' },
			subscribe: (callback) =>
				writeListeners.add(callback, () => runtime?.storage.writes.subscribe(callback) ?? null),
			// The instant-updates extras (see InternalStorageWritesApi) read through to the
			// runtime once it exists; before it there is nothing pending to roll back.
			get pending(): number {
				return internalWrites()?.pending ?? 0
			},
			onRollback: (callback) =>
				rollbackListeners.add(callback, () => internalWrites()?.onRollback(callback) ?? null),
		}
		return {
			writes,
			get evicted() {
				return runtime?.storage.evicted ?? null
			},
			persistence: {
				status: () =>
					runtime?.storage.persistence.status() ?? {
						state: 'unknown',
						persisted: false,
						requested: false,
					},
				// Straight through once the runtime exists, so the request starts in the caller's turn.
				request: () =>
					runtime
						? runtime.storage.persistence.request()
						: rt().then((app) => app.storage.persistence.request()),
			},
			listDatabases: async () => (await rt()).storage.listDatabases(),
			deleteDatabase: async (name, options) => (await rt()).storage.deleteDatabase(name, options),
		}
	}

	let currentStoreInfo: StoreInfo = {
		baseName,
		databaseName: '',
		authUserId: null,
		persistence: config.store?.adapter ?? 'sqlite-wasm',
		durable: false,
		isolationState: 'closed',
	}

	const app: KoraApp = {
		get ready(): Promise<void> {
			// Reading `ready` is a request to open: a provider does it after its first render.
			if (!publicReady) {
				// The caller that reads `ready` owns a real failure, exactly as with the full app. An
				// app closed before it opened has nobody left to tell, so `ready` settles quietly.
				publicReady = start().then(
					() => undefined,
					(error: unknown) => {
						if (closed && error instanceof KoraError && error.code === 'APP_CLOSED') return
						throw error
					},
				)
			}
			return publicReady
		},
		events: emitter,
		on: emitter.on.bind(emitter),
		collections,
		sync,
		encryption,
		sequences: {
			next: (name, sequenceConfig) =>
				withRuntime((app) => app.sequences.next(name, sequenceConfig)),
			current: async (name, sequenceConfig) => (await rt()).sequences.current(name, sequenceConfig),
			reset: (name, sequenceConfig) =>
				withRuntime((app) => app.sequences.reset(name, sequenceConfig)),
		},
		blobs: {
			get store() {
				if (!runtime) {
					throw new Error('Blob subsystem not initialized. Await app.ready before using app.blobs.')
				}
				return runtime.blobs.store
			},
			put: (bytes, metadata) => withRuntime((app) => app.blobs.put(bytes, metadata)),
			get: async (hash) => (await rt()).blobs.get(hash),
			has: async (hash) => (await rt()).blobs.has(hash),
			delete: (hash) => withRuntime((app) => app.blobs.delete(hash)),
			pull: async (manifest) => (await rt()).blobs.pull(manifest),
			gc: async (gcOptions) => (await rt()).blobs.gc(gcOptions),
		},
		storage,
		offline,
		getStore(): Store {
			if (!opened || !runtime) {
				throw new Error('Store not initialized. Await app.ready before accessing the store.')
			}
			return runtime.getStore()
		},
		getSyncEngine() {
			return runtime?.getSyncEngine() ?? null
		},
		getQueryStoreCache() {
			return queryStoreCache
		},
		storeInfo(): StoreInfo {
			return runtime ? runtime.storeInfo() : { ...currentStoreInfo }
		},
		transaction: (fn) => withRuntime((app) => app.transaction(fn)),
		mutation: (name, fn) => withRuntime((app) => app.mutation(name, fn)),
		// Synchronous through the runtime once it exists: `app:before-build-reload` listeners
		// must run before this call returns.
		reloadForNewBuild: () =>
			runtime ? runtime.reloadForNewBuild() : rt().then((app) => app.reloadForNewBuild()),
		async close() {
			closed = true
			if (inert || !started) {
				queryStoreCache.clear()
				emitter.clear()
				stopFirstData()
				return
			}
			// The runtime closes what it opened; a start that failed has nothing to close.
			await started.catch(() => undefined)
			stopFirstData()
			currentStoreInfo = { ...currentStoreInfo, isolationState: 'closed' }
			if (runtime) await runtime.close()
		},
		exportBackup: async (options) => (await rt()).exportBackup(options),
		importBackup: (data, options) => withRuntime((app) => app.importBackup(data, options)),
		replayTo: async (operationId) => (await rt()).replayTo(operationId),
		exportAudit: async (options) => (await rt()).exportAudit(options),
	}

	// The offline shell precaches only after the first data (first-visit parity, S1), so its
	// download never competes with the WASM and the first sync batch.
	let stopFirstData: () => void = () => {}
	if (!inert && typeof window !== 'undefined') {
		stopFirstData = wireFirstDataSignal({
			ready: runtimeOpen,
			syncs: sync !== null,
			status: () => sync?.status ?? OFFLINE_SYNC_STATUS,
			subscribeStatus: (listener) => sync?.subscribeStatus(listener) ?? (() => {}),
		})
	}

	const reservedProperties = new Set(Reflect.ownKeys(app))
	warnShadowedCollections(Object.keys(config.schema.collections), reservedProperties)
	for (const collectionName of Object.keys(config.schema.collections)) {
		if (reservedProperties.has(collectionName)) continue
		Object.defineProperty(app, collectionName, {
			get() {
				return createCollectionAccessor(collectionName, host)
			},
			enumerable: true,
			configurable: false,
		})
	}

	return app
}

/**
 * Listeners that were added before the runtime they belong to existed. Each `add` attaches
 * at once when the target is available; `flush` attaches the rest when it becomes so.
 */
class LateSubscriptions {
	private readonly entries = new Set<{
		attach: () => (() => void) | null
		detach: (() => void) | null
	}>()

	add(_listener: unknown, attach: () => (() => void) | null): () => void {
		const entry = { attach, detach: attach() }
		this.entries.add(entry)
		return () => {
			entry.detach?.()
			entry.detach = null
			this.entries.delete(entry)
		}
	}

	flush(): void {
		for (const entry of this.entries) {
			if (entry.detach === null) entry.detach = entry.attach()
		}
	}
}

/** Run `callback` after the browser has had a frame to paint the first render. */
function afterFirstPaint(callback: () => void): void {
	let done = false
	const run = (): void => {
		if (done) return
		done = true
		callback()
	}
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(() => setTimeout(run, 0))
	}
	// A hidden tab never paints; the app still has to open there.
	setTimeout(run, 3000)
}

function throwNoSync(): never {
	throw new KoraError('Sync is not configured for this app.', 'SYNC_NOT_CONFIGURED', {
		fix: 'Pass sync: { url } to createApp.',
	})
}

/** `app.ready` of an inert (server-rendered) app. */
function inertReady(): Promise<void> {
	return Promise.reject(new ServerRenderingAppError())
}
