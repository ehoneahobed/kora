import { OFFLINE_STATUS_SERVER_RENDER, OFFLINE_STATUS_UNKNOWN } from '@korajs/core/bindings'
import { KoraError, type SchemaInput } from '@korajs/core/lite'
import { SimpleEventEmitter, currentWriteObserver, runWithWriteObserver } from '@korajs/core/lite'
import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store/lite'
import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync/lite'
import { createCollectionAccessor } from './collection-accessor'
import { CONFIG_VALIDATOR_SLOT, type ConfigValidatorSlot } from './config-validator-slot'
import { applyDescriptor } from './deferred-query'
import { wireFirstDataSignal } from './first-data-signal'
import { LateSubscriptions, onlyChanges } from './late-subscriptions'
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
	// Development: a bad option throws here. Production: the runtime validates and rejects `ready`.
	;(globalThis as ConfigValidatorSlot)[CONFIG_VALIDATOR_SLOT]?.(config as never)

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
		...(authClient?.resolveUserId || authClient?.resolveSyncState
			? {
					// `loading` is not "signed out": an entry must not be attributed to nobody while the
					// session is still being restored.
					resolveOwner: async () => {
						if (authClient.resolveSyncState) {
							const state = await authClient.resolveSyncState()
							if (state.state === 'loading') return { loading: true as const }
							return state.state === 'authenticated' ? state.userId : null
						}
						return authClient.resolveUserId?.()
					},
				}
			: {}),
		...(inert ? { journal: null, locks: null } : {}),
		// The journal keeps arguments as given, before the store's at-rest transform (secret
		// fields) or end-to-end encryption could run, so those collections stay in memory only.
		journalBlock: (collection) => {
			if (config.sync?.encryption?.enabled === true) return 'encryption'
			const fields = Object.values(config.schema?.collections?.[collection]?.fields ?? {})
			return fields.some((field) => field.kind === 'secret') ? 'secret-field' : null
		},
		namespacedByUser: config.store?.namespaceByAuthUser === true,
		openedFor: () =>
			config.store?.namespaceByAuthUser === true && runtime
				? runtime.storeInfo().authUserId
				: undefined,
		emit: (event) => emitter.emit(event),
	})

	// The runtime app, once its chunk has loaded and created it; `opened` flips when its
	// `ready` resolved, which is also when the writes queued before are applied.
	let runtime: KoraApp | null = null
	let opened = false
	let closed = false
	let started: Promise<void> | null = null
	let stopAuthWatch: (() => void) | null = null
	let stopQueueWatch: (() => void) | null = null
	let stopJournalPolicy: (() => void) | null = null
	const earlyQueries = new Set<import('@korajs/store').QueryDescriptor>()
	let releaseEarlyQueries: (() => void) | null = null
	/**
	 * Withdraw the sync subsets registered for subscriptions that waited for the store, once
	 * every one of them holds its own: the sync view never loses a subset in between, which
	 * would change it twice and reconnect a handshake that is already under way.
	 */
	const maybeReleaseEarlyQueries = (): void => {
		if (!opened || earlyQueries.size > 0 || !releaseEarlyQueries) return
		const release = releaseEarlyQueries
		releaseEarlyQueries = null
		// A closed app has no sync view left to change.
		if (!closed) release()
	}
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

	// A dropped request or a stale chunk after a deploy fails the dynamic import. A browser keeps
	// the failure for that URL, so importing it again cannot succeed: the one recovery is a fresh
	// page load (guarded to once, like `vite:preloadError` handlers), which fetches it again. When
	// that already happened, or there is no page to reload, `ready` ends with a typed error.
	let abortReload: (() => void) | null = null
	const loadRuntimeModule = async (): Promise<typeof import('./runtime-app')> => {
		try {
			return await import('./runtime-app')
		} catch (error) {
			if (!closed && reloadOnceForChunk('runtime')) {
				// The page is going away; `ready` stays pending until it does (or the app is closed).
				return new Promise<never>((_, reject) => {
					abortReload = () => reject(new KoraError('The app was closed.', 'APP_CLOSED'))
				})
			}
			throw new KoraError(
				'The Kora runtime could not be loaded. Reload the page; if it keeps failing, the app was redeployed and this tab holds files from the old build.',
				'RUNTIME_LOAD_FAILED',
				{ cause: error instanceof Error ? error.message : String(error) },
			)
		}
	}

	const start = (): Promise<void> => {
		if (inertFailure) return inertFailure
		if (started) return started
		const attempt = (async () => {
			if (closed) throw new KoraError('The app was closed before it opened.', 'APP_CLOSED')
			const { createRuntimeApp } = await loadRuntimeModule()
			// Production builds do not validate at `createApp` (the validator is not registered):
			// the same checks run here, from their own chunk, and a bad option ends `ready` with
			// the error naming it. Development already threw it at the call.
			if (!(globalThis as ConfigValidatorSlot)[CONFIG_VALIDATOR_SLOT]) {
				const { validateCreateAppConfig } = await import('./validate-config')
				validateCreateAppConfig(config)
			}
			if (closed) throw new KoraError('The app was closed before it opened.', 'APP_CLOSED')
			// Read the write journal while the store opens, so recovery before `ready` is free
			// when it is empty.
			queue.scan()
			runtime = createRuntimeApp(config, emitter, {
				queryStoreCache,
				warmTransport: () => connectRequested,
				applyPreReadyWrites: (store) => queue.apply(store),
				earlyQueries: {
					descriptors: () => [...earlyQueries],
					hold: (release) => {
						releaseEarlyQueries = release
					},
				},
			})
			for (const subscriptions of notices) subscriptions.flush()
			await runtime.ready
			opened = true
			if (config.sync?.unassignedWrites === 'assign-to-first-user') {
				void import('./pre-ready-recovery').then((m) => {
					if (!closed) stopJournalPolicy = m.assignJournalOnConnect(emitter, queue)
				})
			}
			// A user who signs out or is replaced takes the failed writes kept for them along, and
			// entries still waiting for their owner learn it. The first answer is the baseline.
			if (authClient?.resolveUserId) {
				const note = (): void => {
					void authClient.resolveUserId?.().then(
						(user) => queue.noteSignedInUser(user ?? null),
						() => {},
					)
				}
				if (authClient.subscribe) stopAuthWatch = authClient.subscribe(note)
				note()
			}
			// What a listener reads has just changed from the placeholder to the real value
			// (sync status, offline status, encryption status), and nothing else will tell a
			// subscriber that already read the placeholder: tell it once.
			for (const subscriptions of notices) subscriptions.flush(true)
			maybeReleaseEarlyQueries()
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
	const answers = !inert ? loadPreReadyAnswers(config) : null
	// Answers delivered from memory, waiting to become seeds. They are seeded before any
	// subscription attaches to the store, so its first result is the answer on screen (5.5).
	const heldAnswers: import('./pre-ready-answers').AnswerHandoff[] = []
	let seeding: Promise<void> = Promise.resolve()
	const seedHeldAnswers = (): Promise<void> => {
		seeding = seeding.then(async () => {
			const store = getStore()
			if (store === null || heldAnswers.length === 0 || answers === null) return
			const handoffs = heldAnswers.splice(0)
			// The seeding code travels with the answers, not with the first paint.
			const loaded = await answers.catch(() => null)
			if (loaded === null) return
			await loaded.seed(store, handoffs, (code, message) =>
				emitter.emit({
					type: 'store:persistence-error',
					dbName: config.store?.name ?? 'kora-db',
					message,
					code,
				}),
			)
		})
		return seeding
	}
	const host = {
		getStore,
		queue,
		whenReady: (): Promise<void> => whenOpen().then(seedHeldAnswers),
		preReady(
			descriptor: import('@korajs/store').QueryDescriptor,
			deliver: (records: import('@korajs/store').CollectionRecord[]) => void,
		) {
			if (answers === null) return null
			let withdraw: (() => void) | null = null
			let gone = false
			let answered: import('@korajs/store').CollectionRecord[] | null = null
			// A write made before the store opens shows on a screen answered from memory at
			// once (the seeds stay the server's rows only). Plain equality filters only: any
			// other filter is left to the store, which takes over at the open.
			const showWithWrites = (): void => {
				if (answered === null || gone || opened) return
				deliver(
					withQueuedInserts(descriptor, answered, queue.pendingInserts(descriptor.collection)),
				)
			}
			const stopWatching = queue.onChange(showWithWrites)
			void answers.then((loaded) => {
				if (gone) return
				withdraw = loaded.subscribe(descriptor, {
					deliver(records, handoff) {
						heldAnswers.push(handoff)
						// Past the open the subscription already has the store's result, but the
						// seeds still fill in what the store has not received yet.
						if (opened) void seedHeldAnswers()
						answered = records
						deliver(
							opened
								? records
								: withQueuedInserts(
										descriptor,
										records,
										queue.pendingInserts(descriptor.collection),
									),
						)
					},
				})
			})
			return () => {
				gone = true
				stopWatching()
				withdraw?.()
			}
		},
		trackEarly(descriptor: import('@korajs/store').QueryDescriptor) {
			earlyQueries.add(descriptor)
			return () => {
				earlyQueries.delete(descriptor)
				maybeReleaseEarlyQueries()
			}
		},
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
	for (const collectionName of Object.keys(config.schema?.collections ?? {})) {
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

	const isJournalNode = (nodeId: string): boolean => nodeId.startsWith('journal:')
	const sync = config.sync ? createSyncFacade() : null
	const encryption = createEncryptionFacade()
	const offline = createOfflineFacade()
	const storage = createStorageFacade()

	function createSyncFacade(): SyncControl {
		const statusListeners = new LateSubscriptions()
		notices.push(statusListeners)
		// Writes made before the store opened show up as pending while they wait in memory, and as
		// held writes when they wait for their owner (the held-writes contract: assignHeld /
		// discardHeld / heldNodes). The merged object is reused until something changes.
		let memo: {
			base: SyncStatusInfo
			size: number
			held: readonly unknown[]
			out: SyncStatusInfo
		} | null = null
		const withJournal = (base: SyncStatusInfo): SyncStatusInfo => {
			const size = queue.size
			const held = queue.heldNodes
			if (size === 0 && held.length === 0) return base
			if (memo && memo.base === base && memo.size === size && memo.held === held) return memo.out
			const heldCount = held.reduce((total, node) => total + node.operationCount, 0)
			const out = Object.freeze({
				...base,
				pendingOperations: base.pendingOperations + size,
				heldOperations: (base.heldOperations ?? 0) + heldCount,
				heldNodes: [...(base.heldNodes ?? []), ...held],
			}) as SyncStatusInfo
			memo = { base, size, held, out }
			return out
		}
		const status = (): SyncStatusInfo =>
			withJournal(opened && runtime?.sync ? runtime.sync.status : OFFLINE_SYNC_STATUS)
		stopQueueWatch = queue.onChange(() => statusListeners.flush(true))
		const control: SyncControl = {
			get status() {
				return status()
			},
			getStatus: () =>
				withJournal(opened && runtime?.sync ? runtime.sync.getStatus() : OFFLINE_SYNC_STATUS),
			subscribeStatus: (listener) => {
				const changes = onlyChanges(listener)
				return statusListeners.add(
					() => changes(status()),
					() =>
						opened && runtime?.sync
							? runtime.sync.subscribeStatus((next) => changes(withJournal(next)))
							: null,
				)
			},
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
				const engineHeld = (await (await rt()).sync?.getHeldOperations()) ?? []
				return [...engineHeld, ...queue.heldNodes.map((node) => ({ ...node }))]
			},
			async assignHeld(nodeId, to) {
				const app = await rt()
				if (!app.sync) throwNoSync()
				if (isJournalNode(nodeId)) return queue.assignHeld(nodeId, to)
				await app.sync.assignHeld(nodeId, to)
			},
			async discardHeld(nodeId) {
				const app = await rt()
				if (!app.sync) throwNoSync()
				if (isJournalNode(nodeId)) return queue.discardHeld(nodeId)
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
			onStatusChange: (listener) => {
				const changes = onlyChanges(listener)
				return listeners.add(
					() => changes(runtime?.encryption?.getStatus() ?? lockedStatus),
					() => runtime?.encryption?.onStatusChange(changes) ?? null,
				)
			},
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
			subscribe: (listener) => {
				const changes = onlyChanges(listener)
				return listeners.add(
					() => changes(runtime?.offline.status() ?? OFFLINE_STATUS_UNKNOWN),
					() => runtime?.offline.subscribe(changes) ?? null,
				)
			},
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
				writeListeners.add(null, () => runtime?.storage.writes.subscribe(callback) ?? null),
			// The instant-updates extras (see InternalStorageWritesApi) read through to the
			// runtime once it exists; before it there is nothing pending to roll back.
			get pending(): number {
				return internalWrites()?.pending ?? 0
			},
			onRollback: (callback) =>
				rollbackListeners.add(null, () => internalWrites()?.onRollback(callback) ?? null),
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
			deleteDatabase: async (name, options) => {
				const deleted = await (await rt()).storage.deleteDatabase(name, options)
				// The journal holds plaintext writes meant for the database that was just wiped.
				if (deleted && (name === baseName || name.startsWith(`${baseName}__user_`))) {
					await queue.discardJournal(name)
				}
				return deleted
			},
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
			abortReload?.()
			stopAuthWatch?.()
			stopQueueWatch?.()
			stopJournalPolicy?.()
			stopQueueWatch = null
			stopAuthWatch = null
			if (inert || !started) {
				// Hook writes still waiting for a start that will not come must hear about it.
				await queue.close()
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
	warnShadowedCollections(Object.keys(config.schema?.collections ?? {}), reservedProperties)
	for (const collectionName of Object.keys(config.schema?.collections ?? {})) {
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

/**
 * Reloads the page once for a chunk that failed to load. A second failure within the window
 * (the chunk really is gone, or the server is down) is not reloaded again, so there is no loop.
 *
 * @returns Whether a reload was started
 */
function reloadOnceForChunk(name: string): boolean {
	if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') return false
	const key = `kora:chunk-reload:${name}`
	try {
		const last = Number(window.sessionStorage.getItem(key) ?? '0')
		if (Date.now() - last < 30_000) return false
		window.sessionStorage.setItem(key, String(Date.now()))
	} catch {
		// No session storage: a reload could loop, so none is attempted.
		return false
	}
	window.location.reload()
	return true
}

/**
 * The pre-ready answer service when `sync.firstVisit.readThrough` is on, loaded on demand so
 * an app that does not use it downloads none of it. A failed load is not an error: the store
 * answers every query when it opens, as without read-through.
 */
function loadPreReadyAnswers(
	config: KoraConfig,
): Promise<import('./pre-ready-answers').PreReadyAnswers> | null {
	const sync = config.sync
	if (sync?.firstVisit?.readThrough !== true || !config.schema) return null
	if (sync.auth === undefined && sync.authClient !== undefined) return null
	const schema = config.schema
	const url = readEndpointUrl(sync.url)
	return Promise.all([import('./pre-ready-answers'), import('@korajs/sync/read')]).then(
		([answers, lite]) =>
			new answers.PreReadyAnswers({
				schema,
				source: new lite.ReadThroughClient({
					url,
					schemaVersion: sync.schemaVersion ?? schema.version,
					...(sync.auth !== undefined ? { auth: sync.auth } : {}),
				}),
			}),
	)
}

/** `<syncPath>/read` over http(s) for a sync URL that may be ws(s) and may carry a query. */
function readEndpointUrl(syncUrl: string): string {
	const http = syncUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/[?#].*$/, '')
	return `${http.replace(/\/+$/, '')}/read`
}

/**
 * The answer plus the rows of inserts the store has not received yet that the query's plain
 * equality filter admits, after the answered rows (the order the store will give once it has
 * them is not known here). Returns the answer itself when nothing is added.
 */
function withQueuedInserts(
	descriptor: import('@korajs/store').QueryDescriptor,
	records: import('@korajs/store').CollectionRecord[],
	inserts: Array<{ id: string; data: Record<string, unknown> }>,
): import('@korajs/store').CollectionRecord[] {
	if (inserts.length === 0) return records
	const where = descriptor.where as Record<string, unknown>
	const plain = Object.values(where).every(
		(value) => value === null || (typeof value !== 'object' && typeof value !== 'function'),
	)
	if (!plain || descriptor.limit !== undefined || descriptor.offset !== undefined) return records
	const known = new Set(records.map((record) => record.id))
	const added = inserts
		.filter(
			(row) =>
				!known.has(row.id) &&
				Object.entries(where).every(([field, value]) => row.data[field] === value),
		)
		.map((row) => ({ ...row.data, id: row.id }) as import('@korajs/store').CollectionRecord)
	return added.length === 0 ? records : [...records, ...added]
}
