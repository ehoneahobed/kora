import { KoraError, type SchemaInput } from '@korajs/core'
import type { SimpleEventEmitter } from '@korajs/core/internal'
import type { Store, VersionGate } from '@korajs/store'
import { type QueryStoreCache, StoragePersistence } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import type { ApplyPipeline } from './apply-pipeline'
import { createBlobApi } from './blob/create-blob-api'
import { enumerateLiveBlobRefs } from './blob/enumerate-live-refs'
import { createAppKeyring, createEncryptionControl } from './encryption-control'
import { importBackupIntoApp } from './import-backup'
import { initializeApp } from './initialize-app'
import { createOfflineController } from './offline-controller'
import { type OfflineKeep, createOfflineKeep } from './offline-keep'
import { createTabCoordination } from './offline-tab-coordination'
import { warnShadowedCollections } from './reserved-app-properties'
import { createSequencesAccessor } from './sequences-accessor'
import { setupDevtools } from './setup-devtools'
import {
	createStorageApi,
	createStorageWritesApi,
	wireStoragePersistence,
} from './storage-accessor'
import { createStrictCollectionAccessor } from './strict-collection-accessor'
import { createSyncControl } from './sync-control'
import {
	type SyncRuntimeState,
	teardownSyncLifecycle,
	wireSyncLifecycleAfterReady,
} from './sync-lifecycle'
import { createTransactionExecutor } from './transaction-executor'
import type {
	BlobApi,
	KoraApp,
	KoraConfig,
	StoreInfo,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'
import { wireUnsyncedTracking } from './unsynced-tracker'
import {
	gatedBlobStore,
	recordPageServiceWorkers,
	reloadIntoNewestBuild,
	wireAppVersionGate,
} from './version-gate'

/** What the lite `createApp` passes to the runtime it loaded after first paint. */
export interface RuntimeAppOptions {
	/** The cache the lite app already handed to hooks; one cache per app, closed with it. */
	queryStoreCache: QueryStoreCache
	/**
	 * Whether the sync transport should open its socket while the store is still opening
	 * (the app asked to connect, or `sync.autoConnect` is on).
	 */
	warmTransport: () => boolean
	/**
	 * Applies the writes queued (and journaled) before the store opened. Called once, with the
	 * open store, as the last step before `ready` resolves.
	 */
	applyPreReadyWrites?: (store: Store) => Promise<void>
}

/**
 * The full Kora application: store, merge, sync, offline readiness, storage and blobs.
 *
 * This is the "runtime chunk" of `korajs` (first-visit parity, stage S4a). The lite
 * `createApp` returns the app's shell at once and loads this module with a dynamic
 * `import()` after the first paint, so the store, the sync engine and the SQLite glue
 * are not part of the critical path. It is never loaded during a server render.
 *
 * @param config - The validated application configuration
 * @param emitter - The app's event emitter, shared with the lite shell so listeners added
 *   before this module loaded keep working
 * @param options - Pieces the shell already owns (see {@link RuntimeAppOptions})
 * @returns The complete app, whose `ready` opens the store
 */
export function createRuntimeApp(
	config: KoraConfig,
	emitter: SimpleEventEmitter,
	options: RuntimeAppOptions,
): KoraApp {
	let store: Store | null = null
	let applyPipeline: ApplyPipeline | null = null
	let blobApi: BlobApi | null = null
	let unsubscribeSync: (() => void) | null = null
	let unsubscribeAudit: (() => void) | null = null
	let unsubscribeLocalOperations: (() => void) | null = null
	let unsubscribeUnsynced: (() => void) | null = null
	let releaseVersionGate: (() => void) | null = null
	let versionGateActive = false
	let activeVersionGate: VersionGate | null = null
	let gatedBlobs: {
		raw: import('@korajs/store').ContentAddressedBlobStore
		gated: import('@korajs/store').ContentAddressedBlobStore
	} | null = null
	let storageBackend: 'opfs' | 'indexeddb' | 'native' | 'memory' = 'memory'
	let currentStoreInfo: StoreInfo = {
		baseName: config.store?.name ?? 'kora-db',
		databaseName: '',
		authUserId: null,
		persistence: config.store?.adapter ?? 'sqlite-wasm',
		durable: false,
		isolationState: 'closed',
	}

	const syncState: SyncRuntimeState = {
		syncEngine: null,
		syncStatusBridge: null,
		authSyncCoordinator: null,
		reconnectionManager: null,
		connectionMonitor: null,
		qualityInterval: null,
		intentionalDisconnect: false,
		removeOnlineListener: null,
		supersededBy: null,
	}

	// Version gate: reload into the newer build after saving what forms need. Under the
	// offline shell the newer build's waiting service worker is activated first, so the
	// reload never brings the old build back.
	let reloading: Promise<boolean> | null = null
	const reloadForNewBuild = (): Promise<boolean> => {
		if (reloading) return reloading
		try {
			emitter.emit({ type: 'app:before-build-reload' })
		} catch (error) {
			console.error('[kora] An app:before-build-reload listener failed:', error)
		}
		const attempt = reloadIntoNewestBuild().then((requested) => {
			// Deferred (the new version is not installed yet): a later call tries again.
			if (!requested) reloading = null
			return requested
		})
		reloading = attempt
		return attempt
	}

	// Which service worker served this page's build: a reload for a newer build never goes
	// back through it (version gate).
	if (typeof window !== 'undefined') void recordPageServiceWorkers()
	const devtools = setupDevtools(config, emitter)
	const queryStoreCache = options.queryStoreCache
	const storagePersistence = new StoragePersistence({ emitter })
	let unwirePersistence: (() => void) | null = null

	// End-to-end encryption keyring (ENC-1): created up front so its status is
	// observable (and unlock() callable) before the store opens.
	const keyring = createAppKeyring(config, emitter)

	let offlineKeep: OfflineKeep | null = null
	const offlineController = createOfflineController({
		config,
		emitter,
		persistence: storagePersistence,
		inert: false,
		runtime: () => ({
			store,
			engine: syncState.syncEngine,
			durable: currentStoreInfo.durable,
			backend: storageBackend,
			keep: offlineKeep,
		}),
	})

	const ready = initializeApp(config, emitter, keyring, {
		onVersionGate: (gate) =>
			wireAppVersionGate(gate, { config, emitter, syncState, reloadForNewBuild }),
		onOfflineMetaChanged: () => {
			void offlineController.refreshFromDatabase()
		},
		warmTransport: options.warmTransport,
	}).then(async (init) => {
		store = init.store
		releaseVersionGate = init.releaseVersionGate
		versionGateActive = init.versionGate !== null
		activeVersionGate = init.versionGate
		applyPipeline = init.applyPipeline
		unsubscribeSync = init.unsubscribeSync
		unsubscribeAudit = init.unsubscribeAudit
		unsubscribeLocalOperations = init.unsubscribeLocalOperations
		blobApi = createBlobApi(init.blobStore, init.blobChunkProvider, config.blob?.chunkSize, () =>
			enumerateLiveBlobRefs(init.store, config.schema),
		)
		currentStoreInfo = init.storeInfo
		storageBackend = init.storageBackend
		// Pins join the sync view before the first connection, so their records arrive in
		// the first delivery. A pin table that cannot be read leaves the pins unproven
		// (`ready` is never claimed), and never fails the app.
		const opened = init.store
		const keepBlobApi = blobApi
		const keepRuntime = createOfflineKeep({
			dbName: init.storeInfo.databaseName,
			emitter,
			persistence: storagePersistence,
			coordination: createTabCoordination(init.versionGate, {
				dbName: init.storeInfo.databaseName,
			}),
			runtime: {
				store: () => opened,
				engine: () => syncState.syncEngine,
				blobStore: () => init.blobStore,
				pull: (ref) => trackBlobWrite('blob-pull', () => keepBlobApi.pull(ref)),
				dataComplete: () => {
					const engine = syncState.syncEngine
					if (!engine) return config.sync === undefined
					const state = engine.getOfflineData().state
					return state === 'complete' || state === 'local'
				},
			},
		})
		offlineKeep = keepRuntime
		try {
			await keepRuntime.load()
		} catch (error) {
			console.warn('[kora] Could not read the offline pins:', error)
		}
		if (init.initialUnsyncedCount !== null) {
			const opened = init.store
			unsubscribeUnsynced = wireUnsyncedTracking({
				emitter,
				engine: init.syncEngine,
				initialCount: init.initialUnsyncedCount,
				record: (count, exact) => opened.recordUnsyncedWrites(count, exact),
			})
		}
		wireSyncLifecycleAfterReady(config, emitter, syncState, init)
		// The engine exists only now: the pins read during load join its sync view here.
		keepRuntime.engineReady().catch((error: unknown) => {
			console.warn('[kora] Could not add the offline pins to the sync view:', error)
		})
		offlineController.attach()
		// NEW-STORE-4: durable-storage check and triggers start here, after the store
		// opened, and are never awaited: a pending persist() prompt cannot hold ready.
		unwirePersistence = wireStoragePersistence(
			config,
			emitter,
			storagePersistence,
			init.authBinding,
		)
		// Writes made through a hook before the store opened (journaled by the shell) are
		// applied now, in order, before `ready` resolves and before the shell hands the
		// store to anyone else.
		await options.applyPreReadyWrites?.(init.store)
	})

	const getStore = (): Store | null => store
	const requireOfflineKeep = (): OfflineKeep => {
		if (!offlineKeep) {
			throw new KoraError(
				'Offline keep is not initialized. Await app.ready before app.offline.keep().',
				'APP_NOT_READY',
				{ fix: 'Await app.ready before app.offline.keep().' },
			)
		}
		return offlineKeep
	}
	const requireBlobApi = (): BlobApi => {
		if (!blobApi) {
			throw new Error('Blob subsystem not initialized. Await app.ready before using app.blobs.')
		}
		return blobApi
	}
	// Blob bytes are writes too: a superseded tab must not put, delete or collect them
	// (an old build's gc could delete bytes the newer build still references).
	const trackBlobWrite = <T>(operation: string, fn: () => Promise<T>): Promise<T> =>
		store ? store.trackWrite({ operation }, fn) : fn()
	const executeTransaction = createTransactionExecutor(config, ready, getStore)
	const collections: Record<
		string,
		ReturnType<typeof createStrictCollectionAccessor>
	> = Object.create(null)
	for (const collectionName of Object.keys(config.schema.collections)) {
		Object.defineProperty(collections, collectionName, {
			get() {
				return createStrictCollectionAccessor(collectionName, getStore)
			},
			enumerable: true,
			configurable: false,
		})
	}
	Object.freeze(collections)

	const app: KoraApp = {
		ready,
		events: emitter,
		on: emitter.on.bind(emitter),
		collections,
		sync: createSyncControl({ config, ready, state: syncState }),
		encryption: createEncryptionControl({ keyring, ready, state: syncState }),
		sequences: createSequencesAccessor(ready, getStore),
		blobs: {
			get store() {
				const raw = requireBlobApi().store
				// Gated only where a version gate applies; the same object every time.
				if (!versionGateActive) return raw
				if (gatedBlobs?.raw !== raw) {
					gatedBlobs = { raw, gated: gatedBlobStore(raw, trackBlobWrite) }
				}
				return gatedBlobs.gated
			},
			async put(bytes, metadata) {
				await ready
				return trackBlobWrite('blob-put', () => requireBlobApi().put(bytes, metadata))
			},
			async get(hash) {
				await ready
				return requireBlobApi().get(hash)
			},
			async has(hash) {
				await ready
				return requireBlobApi().has(hash)
			},
			async delete(hash) {
				await ready
				return trackBlobWrite('blob-delete', () => requireBlobApi().delete(hash))
			},
			async pull(manifest) {
				await ready
				return trackBlobWrite('blob-pull', () => requireBlobApi().pull(manifest))
			},
			async gc(options) {
				await ready
				return trackBlobWrite('blob-gc', () => requireBlobApi().gc(options))
			},
		},
		storage: createStorageApi(
			config,
			storagePersistence,
			createStorageWritesApi(() => store, emitter, ready),
			() => store,
		),
		offline: {
			status: () => offlineController.status(),
			subscribe: (listener) => offlineController.subscribe(listener),
			async keep(query, options) {
				await ready
				return requireOfflineKeep().keep(query, options)
			},
			async release(handle) {
				await ready
				await requireOfflineKeep().release(handle)
			},
			async hold(query, options) {
				await ready
				return requireOfflineKeep().hold(query, options)
			},
			list: () => offlineKeep?.list() ?? [],
			async acknowledgeEviction() {
				await ready
				await store?.acknowledgeStorageEviction()
				await offlineController.refreshFromDatabase()
			},
		},
		getStore(): Store {
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before accessing the store.')
			}
			return store
		},
		getSyncEngine(): SyncEngine | null {
			return syncState.syncEngine
		},
		getQueryStoreCache(): QueryStoreCache {
			return queryStoreCache
		},
		storeInfo(): StoreInfo {
			return { ...currentStoreInfo }
		},
		transaction(fn) {
			return executeTransaction(fn)
		},
		mutation(name, fn) {
			return executeTransaction(fn, name)
		},
		reloadForNewBuild,
		async close() {
			await ready
			// Retiring for a newer build (from the moment retirement starts): closing would hand
			// the database over, so every admitted write is saved first, or the close is refused
			// (UNSAVED_WRITES) before anything is torn down. The prompt's Retry and Export keep
			// working; a later close succeeds once they are saved.
			await store?.prepareClose()
			await activeVersionGate?.assertClosable()
			syncState.intentionalDisconnect = true
			teardownSyncLifecycle(syncState)
			devtools.destroy?.()
			if (unwirePersistence) {
				unwirePersistence()
				unwirePersistence = null
			}
			if (unsubscribeSync) {
				unsubscribeSync()
				unsubscribeSync = null
			}
			if (unsubscribeAudit) {
				unsubscribeAudit()
				unsubscribeAudit = null
			}
			if (unsubscribeLocalOperations) {
				unsubscribeLocalOperations()
				unsubscribeLocalOperations = null
			}
			if (unsubscribeUnsynced) {
				unsubscribeUnsynced()
				unsubscribeUnsynced = null
			}
			if (syncState.syncEngine) {
				// destroy(), not stop(): every engine timer is cleared even when the session
				// already ended, and nothing the engine scheduled runs after close (SYNC-10).
				await syncState.syncEngine.destroy()
				syncState.syncEngine = null
			}
			// Stop the pins and the readiness status first, then let what already started finish:
			// a refresh must not meet a closed database.
			offlineController.dispose()
			const closingKeep = offlineKeep
			offlineKeep = null
			closingKeep?.dispose()
			await offlineController.whenIdle()
			await closingKeep?.whenIdle()
			queryStoreCache.clear()
			if (store) {
				await store.close()
				store = null
			}
			releaseVersionGate?.()
			releaseVersionGate = null
			currentStoreInfo = { ...currentStoreInfo, isolationState: 'closed' }
			emitter.clear()
		},
		async exportBackup(options) {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before exporting backup.')
			}
			return store.exportBackup(options)
		},
		async importBackup(data, options) {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before importing backup.')
			}
			return importBackupIntoApp(store, applyPipeline, config, syncState, data, options)
		},
		async replayTo(operationId) {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before replaying operations.')
			}
			return store.replayTo(operationId)
		},
		async exportAudit(options) {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before exporting audit data.')
			}
			return store.exportAudit(options)
		},
	}

	const reservedProperties = new Set(Reflect.ownKeys(app))
	warnShadowedCollections(Object.keys(config.schema.collections), reservedProperties)
	for (const collectionName of Object.keys(config.schema.collections)) {
		if (reservedProperties.has(collectionName)) continue
		Object.defineProperty(app, collectionName, {
			get() {
				return createStrictCollectionAccessor(collectionName, getStore)
			},
			enumerable: true,
			configurable: false,
		})
	}

	return app
}
