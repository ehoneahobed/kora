import type { KoraEventEmitter, Operation } from '@kora/core'
import { SimpleEventEmitter } from '@kora/core/internal'
import { MergeEngine } from '@kora/merge'
import { Store } from '@kora/store'
import type { CollectionAccessor, StorageAdapter } from '@kora/store'
import { SyncEngine, WebSocketTransport } from '@kora/sync'
import type { SyncStatusInfo } from '@kora/sync'
import { createAdapter, detectAdapterType } from './adapter-resolver'
import { MergeAwareSyncStore } from './merge-aware-sync-store'
import type { KoraApp, KoraConfig, SyncControl } from './types'

/**
 * Creates a new Kora application instance.
 *
 * Wires together store, merge engine, event emitter, and optionally sync
 * into a single developer-facing `KoraApp` object. Collection accessors
 * (e.g. `app.todos`) are defined as properties for immediate use after `await app.ready`.
 *
 * @param config - Application configuration including schema and optional sync settings
 * @returns A KoraApp instance with reactive collections ready for use
 *
 * @example
 * ```typescript
 * const app = createApp({
 *   schema: defineSchema({
 *     version: 1,
 *     collections: {
 *       todos: {
 *         fields: {
 *           title: t.string(),
 *           completed: t.boolean().default(false)
 *         }
 *       }
 *     }
 *   })
 * })
 *
 * await app.ready
 * const todo = await app.todos.insert({ title: 'Hello' })
 * ```
 */
export function createApp(config: KoraConfig): KoraApp {
	const emitter: KoraEventEmitter & { clear(): void } = new SimpleEventEmitter()
	const mergeEngine = new MergeEngine()

	let store: Store | null = null
	let syncEngine: SyncEngine | null = null
	let unsubscribeSync: (() => void) | null = null

	// Build the ready promise — resolves when the store is open and wired
	const ready = initializeAsync(config, emitter, mergeEngine).then((result) => {
		store = result.store
		syncEngine = result.syncEngine
		unsubscribeSync = result.unsubscribeSync
	})

	// Build sync control
	const syncControl: SyncControl | null = config.sync
		? {
				async connect(): Promise<void> {
					await ready
					if (syncEngine) {
						await syncEngine.start()
					}
				},
				async disconnect(): Promise<void> {
					await ready
					if (syncEngine) {
						await syncEngine.stop()
					}
				},
				getStatus(): SyncStatusInfo {
					if (syncEngine) {
						return syncEngine.getStatus()
					}
					return { status: 'offline', pendingOperations: 0, lastSyncedAt: null }
				},
			}
		: null

	// Build the KoraApp object
	const app: KoraApp = {
		ready,
		events: emitter,
		sync: syncControl,
		getStore(): Store {
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before accessing the store.')
			}
			return store
		},
		getSyncEngine(): SyncEngine | null {
			return syncEngine
		},
		async close(): Promise<void> {
			await ready
			if (unsubscribeSync) {
				unsubscribeSync()
				unsubscribeSync = null
			}
			if (syncEngine) {
				await syncEngine.stop()
				syncEngine = null
			}
			if (store) {
				await store.close()
				store = null
			}
			emitter.clear()
		},
	}

	// Define collection accessors via Object.defineProperty
	// Before ready resolves, accessing a collection throws a helpful error.
	for (const collectionName of Object.keys(config.schema.collections)) {
		Object.defineProperty(app, collectionName, {
			get(): CollectionAccessor {
				if (!store) {
					throw new Error(
						`Cannot access collection "${collectionName}" before app.ready resolves. Use: await app.ready`,
					)
				}
				return store.collection(collectionName)
			},
			enumerable: true,
			configurable: false,
		})
	}

	return app
}

/**
 * Asynchronous initialization: create adapter, open store, wire sync.
 */
async function initializeAsync(
	config: KoraConfig,
	emitter: KoraEventEmitter,
	mergeEngine: MergeEngine,
): Promise<{
	store: Store
	syncEngine: SyncEngine | null
	unsubscribeSync: (() => void) | null
}> {
	// Resolve adapter
	const adapterType = config.store?.adapter ?? detectAdapterType()
	const dbName = config.store?.name ?? 'kora-db'
	const adapter: StorageAdapter = await createAdapter(adapterType, dbName)

	// Create and open the store
	const store = new Store({
		schema: config.schema,
		adapter,
		emitter,
	})
	await store.open()

	// Wire sync if configured
	let syncEngine: SyncEngine | null = null
	let unsubscribeSync: (() => void) | null = null

	if (config.sync) {
		const transport = new WebSocketTransport()
		const mergeAwareStore = new MergeAwareSyncStore(store, mergeEngine, emitter)

		syncEngine = new SyncEngine({
			transport,
			store: mergeAwareStore,
			config: {
				url: config.sync.url,
				transport: config.sync.transport,
				auth: config.sync.auth,
				batchSize: config.sync.batchSize,
				schemaVersion: config.sync.schemaVersion ?? config.schema.version,
			},
			emitter,
		})

		// Wire local mutations → sync outbound queue
		unsubscribeSync = emitter.on('operation:created', (event) => {
			if (syncEngine) {
				syncEngine.pushOperation(event.operation)
			}
		})
	}

	return { store, syncEngine, unsubscribeSync }
}
