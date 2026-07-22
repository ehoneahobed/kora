import type { SchemaInput } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import type { Store } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { createBlobApi } from './blob/create-blob-api'
import { enumerateLiveBlobRefs } from './blob/enumerate-live-refs'
import { createCollectionAccessor } from './collection-accessor'
import { initializeApp } from './initialize-app'
import { createSequencesAccessor } from './sequences-accessor'
import { setupDevtools } from './setup-devtools'
import { createSyncControl } from './sync-control'
import {
	type SyncRuntimeState,
	teardownSyncLifecycle,
	wireSyncLifecycleAfterReady,
} from './sync-lifecycle'
import { createTransactionExecutor } from './transaction-executor'
import type { BlobApi, KoraApp, KoraConfig, TypedKoraApp, TypedKoraConfig } from './types'
import { validateCreateAppConfig } from './validate-config'
import { wireSyncEventForwarding } from './wire-sync-event-forwarding'

/**
 * Creates a new Kora application instance.
 *
 * Wires together store, merge engine, event emitter, and optionally sync
 * into a single developer-facing `KoraApp` object. Collection accessors
 * (e.g. `app.todos`) are defined as properties for immediate use after `await app.ready`.
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
	let blobApi: BlobApi | null = null
	let unsubscribeSync: (() => void) | null = null
	let unsubscribeAudit: (() => void) | null = null

	const syncState: SyncRuntimeState = {
		syncEngine: null,
		syncStatusBridge: null,
		authSyncCoordinator: null,
		reconnectionManager: null,
		connectionMonitor: null,
		qualityInterval: null,
		intentionalDisconnect: false,
		removeOnlineListener: null,
	}

	const devtools = setupDevtools(config, emitter)
	const queryStoreCache = new QueryStoreCache(config.store?.name ?? 'kora-db')

	const ready = initializeApp(config, emitter, mergeEngine).then((init) => {
		store = init.store
		unsubscribeSync = init.unsubscribeSync
		unsubscribeAudit = init.unsubscribeAudit
		blobApi = createBlobApi(init.blobStore, init.blobChunkProvider, config.blob?.chunkSize, () =>
			enumerateLiveBlobRefs(init.store, config.schema),
		)
		wireSyncLifecycleAfterReady(config, emitter, syncState, init)
	})

	const getStore = (): Store | null => store
	const requireBlobApi = (): BlobApi => {
		if (!blobApi) {
			throw new Error('Blob subsystem not initialized. Await app.ready before using app.blobs.')
		}
		return blobApi
	}
	const executeTransaction = createTransactionExecutor(config, ready, getStore)

	const app: KoraApp = {
		ready,
		events: emitter,
		sync: createSyncControl({ config, ready, state: syncState }),
		sequences: createSequencesAccessor(ready, getStore),
		blobs: {
			get store() {
				return requireBlobApi().store
			},
			async put(bytes, metadata) {
				await ready
				return requireBlobApi().put(bytes, metadata)
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
				return requireBlobApi().delete(hash)
			},
			async pull(manifest) {
				await ready
				return requireBlobApi().pull(manifest)
			},
			async gc(options) {
				await ready
				return requireBlobApi().gc(options)
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
		transaction(fn) {
			return executeTransaction(fn)
		},
		mutation(name, fn) {
			return executeTransaction(fn, name)
		},
		async close() {
			await ready
			syncState.intentionalDisconnect = true
			teardownSyncLifecycle(syncState)
			devtools.destroyOverlay?.()
			devtools.instrumenter?.destroy()
			if (unsubscribeSync) {
				unsubscribeSync()
				unsubscribeSync = null
			}
			if (unsubscribeAudit) {
				unsubscribeAudit()
				unsubscribeAudit = null
			}
			if (syncState.syncEngine) {
				await syncState.syncEngine.stop()
				syncState.syncEngine = null
			}
			queryStoreCache.clear()
			if (store) {
				await store.close()
				store = null
			}
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
			return store.importBackup(data, options)
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

	for (const collectionName of Object.keys(config.schema.collections)) {
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
