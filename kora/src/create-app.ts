import { KoraError, type SchemaInput } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import type { Store, VersionGate } from '@korajs/store'
import { QueryStoreCache, StoragePersistence } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import type { ApplyPipeline } from './apply-pipeline'
import { createBlobApi } from './blob/create-blob-api'
import { enumerateLiveBlobRefs } from './blob/enumerate-live-refs'
import { createCollectionAccessor } from './collection-accessor'
import {
	createAppKeyring,
	createEncryptionControl,
	createInertEncryptionControl,
} from './encryption-control'
import { importBackupIntoApp } from './import-backup'
import { initializeApp } from './initialize-app'
import { createOfflineController } from './offline-controller'
import { type OfflineKeep, createOfflineKeep } from './offline-keep'
import { createTabCoordination } from './offline-tab-coordination'
import { warnShadowedCollections } from './reserved-app-properties'
import { createSequencesAccessor } from './sequences-accessor'
import { setupDevtools } from './setup-devtools'
import { ServerRenderingAppError, isServerRenderingInert } from './ssr'
import {
	createStorageApi,
	createStorageWritesApi,
	wireStoragePersistence,
} from './storage-accessor'
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
import { validateCreateAppConfig } from './validate-config'
import {
	gatedBlobStore,
	recordPageServiceWorkers,
	reloadIntoNewestBuild,
	wireAppVersionGate,
} from './version-gate'
import { wireSyncEventForwarding } from './wire-sync-event-forwarding'

/**
 * Creates a new Kora application instance.
 *
 * Wires together store, merge engine, event emitter, and optionally sync
 * into a single developer-facing `KoraApp` object. Collection accessors
 * are always available through `app.collections`. Non-reserved names also retain
 * the convenient direct form (for example, `app.todos`). A collection named after a
 * framework property (`ready`, `events`, `sync`, `storage`, ... see
 * `RESERVED_APP_PROPERTIES`) is only reachable as `app.collections.<name>`; createApp
 * warns about it in development.
 *
 * During a server render (no `window`, see {@link KoraConfig.ssr}) the app is inert:
 * it opens no storage and starts no sync, and `app.ready` rejects with
 * `ServerRenderingAppError` (handled, so it never surfaces as an unhandled rejection).
 */
export function createApp<const S extends SchemaInput>(config: TypedKoraConfig<S>): TypedKoraApp<S>
export function createApp(config: KoraConfig): KoraApp
export function createApp<const S extends SchemaInput>(
	config: TypedKoraConfig<S> | KoraConfig,
): TypedKoraApp<S> | KoraApp {
	validateCreateAppConfig(config)

	const emitter = new SimpleEventEmitter()
	const mergeEngine = new MergeEngine()

	if (config.onSyncEvent) {
		wireSyncEventForwarding(emitter, config.onSyncEvent)
	}

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

	// DX-6: a module-scope createApp evaluated by a server renderer must not open a
	// database (or start sync) in the server process.
	const inert = isServerRenderingInert(config)
	// Which service worker served this page's build: a reload for a newer build never goes
	// back through it (version gate).
	if (!inert && typeof window !== 'undefined') void recordPageServiceWorkers()
	const devtools = inert
		? { instrumenter: null, destroyOverlay: null }
		: setupDevtools(config, emitter)
	const queryStoreCache = new QueryStoreCache(config.store?.name ?? 'kora-db')
	const storagePersistence = new StoragePersistence({ emitter })
	let unwirePersistence: (() => void) | null = null

	// End-to-end encryption keyring (ENC-1): created up front so its status is
	// observable (and unlock() callable) before the store opens. Never during a
	// server render (DX-6): the inert app opens nothing.
	const keyring = inert ? null : createAppKeyring(config, emitter)

	let offlineKeep: OfflineKeep | null = null
	const offlineController = createOfflineController({
		config,
		emitter,
		persistence: storagePersistence,
		inert,
		runtime: () => ({
			store,
			engine: syncState.syncEngine,
			durable: currentStoreInfo.durable,
			backend: storageBackend,
			keep: offlineKeep,
		}),
	})

	const ready = inert
		? inertReady()
		: initializeApp(config, emitter, mergeEngine, keyring, {
				onVersionGate: (gate) =>
					wireAppVersionGate(gate, { config, emitter, syncState, reloadForNewBuild }),
				onOfflineMetaChanged: () => {
					void offlineController.refreshFromDatabase()
				},
			}).then(async (init) => {
				store = init.store
				releaseVersionGate = init.releaseVersionGate
				versionGateActive = init.versionGate !== null
				activeVersionGate = init.versionGate
				applyPipeline = init.applyPipeline
				unsubscribeSync = init.unsubscribeSync
				unsubscribeAudit = init.unsubscribeAudit
				unsubscribeLocalOperations = init.unsubscribeLocalOperations
				blobApi = createBlobApi(
					init.blobStore,
					init.blobChunkProvider,
					config.blob?.chunkSize,
					() => enumerateLiveBlobRefs(init.store, config.schema),
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
	const collections: Record<string, ReturnType<typeof createCollectionAccessor>> = Object.create(
		null,
	)
	for (const collectionName of Object.keys(config.schema.collections)) {
		Object.defineProperty(collections, collectionName, {
			get() {
				return createCollectionAccessor(collectionName, getStore)
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
		encryption: inert
			? createInertEncryptionControl(config, ready)
			: createEncryptionControl({ keyring, ready, state: syncState }),
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
			if (inert) {
				queryStoreCache.clear()
				emitter.clear()
				return
			}
			await ready
			// Retiring for a newer build (from the moment retirement starts): closing would hand
			// the database over, so every admitted write is saved first, or the close is refused
			// (UNSAVED_WRITES) before anything is torn down. The prompt's Retry and Export keep
			// working; a later close succeeds once they are saved.
			await store?.prepareClose()
			await activeVersionGate?.assertClosable()
			syncState.intentionalDisconnect = true
			teardownSyncLifecycle(syncState)
			devtools.destroyOverlay?.()
			devtools.instrumenter?.destroy()
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
				return createCollectionAccessor(collectionName, getStore)
			},
			enumerable: true,
			configurable: false,
		})
	}

	return app
}

/**
 * `app.ready` of an inert (server-rendered) app: rejected with a clear error for
 * anyone who awaits it, but marked handled so a module-scope app that nobody awaits
 * never crashes the server with an unhandled rejection.
 */
function inertReady(): Promise<void> {
	const ready = Promise.reject(new ServerRenderingAppError())
	ready.catch(() => {})
	return ready
}
