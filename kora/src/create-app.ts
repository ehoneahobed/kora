import type { KoraEventEmitter, Operation, SchemaInput } from '@korajs/core'
import { buildScopeMap } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { Instrumenter } from '@korajs/devtools'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import type {
	BackupOptions,
	CollectionAccessor,
	QueryBuilder,
	RestoreOptions,
	RestoreResult,
	StorageAdapter,
} from '@korajs/store'
import {
	ConnectionMonitor,
	ReconnectionManager,
	SyncEngine,
	WebSocketTransport,
} from '@korajs/sync'
import type { SyncStatusInfo } from '@korajs/sync'
import { createAdapter, detectAdapterType } from './adapter-resolver'
import { MergeAwareSyncStore } from './merge-aware-sync-store'
import type {
	KoraApp,
	KoraConfig,
	SequenceAccessor,
	SyncControl,
	TransactionProxy,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'

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
/**
 * Creates a new typed Kora application instance.
 * When the schema is created with `defineSchema()`, full type inference flows through
 * to collection accessors, providing autocomplete and type checking for all CRUD operations.
 */
export function createApp<const S extends SchemaInput>(config: TypedKoraConfig<S>): TypedKoraApp<S>
/**
 * Creates a new Kora application instance (untyped fallback).
 */
export function createApp(config: KoraConfig): KoraApp
export function createApp(config: KoraConfig): KoraApp {
	const emitter: KoraEventEmitter & { clear(): void } = new SimpleEventEmitter()
	const mergeEngine = new MergeEngine()

	let store: Store | null = null
	let syncEngine: SyncEngine | null = null
	let unsubscribeSync: (() => void) | null = null
	let reconnectionManager: ReconnectionManager | null = null
	let connectionMonitor: ConnectionMonitor | null = null
	let instrumenter: Instrumenter | null = null
	let intentionalDisconnect = false
	let qualityInterval: ReturnType<typeof setInterval> | null = null

	// Wire DevTools instrumentation immediately (emitter exists synchronously)
	if (config.devtools) {
		instrumenter = new Instrumenter(emitter, {
			bridgeEnabled: typeof globalThis !== 'undefined' && 'window' in globalThis,
		})
	}

	// Build the ready promise — resolves when the store is open and wired
	const ready = initializeAsync(config, emitter, mergeEngine).then((result) => {
		store = result.store
		syncEngine = result.syncEngine
		unsubscribeSync = result.unsubscribeSync

		// Wire reconnection and connection quality after sync engine is ready
		if (config.sync && syncEngine) {
			connectionMonitor = new ConnectionMonitor()
			reconnectionManager = new ReconnectionManager({
				initialDelay: config.sync.reconnectInterval,
				maxDelay: config.sync.maxReconnectInterval,
			})

			// Track activity for connection quality
			emitter.on('sync:sent', () => connectionMonitor?.recordActivity())
			emitter.on('sync:received', () => connectionMonitor?.recordActivity())
			emitter.on('sync:acknowledged', () => connectionMonitor?.recordActivity())

			// Emit quality on timer while connected
			emitter.on('sync:connected', () => {
				if (qualityInterval !== null) clearInterval(qualityInterval)
				qualityInterval = setInterval(() => {
					if (connectionMonitor) {
						emitter.emit({ type: 'connection:quality', quality: connectionMonitor.getQuality() })
					}
				}, 5000)
			})

			// Reset monitor and clear timer on disconnect
			emitter.on('sync:disconnected', () => {
				connectionMonitor?.reset()
				if (qualityInterval !== null) {
					clearInterval(qualityInterval)
					qualityInterval = null
				}
			})

			// Reconnect immediately when the browser reports connectivity restored
			if (typeof globalThis !== 'undefined' && 'addEventListener' in globalThis) {
				const engine = syncEngine
				globalThis.addEventListener('online', () => {
					if (intentionalDisconnect || config.sync?.autoReconnect === false) return
					reconnectionManager?.wake()
					reconnectionManager?.reset()
					void engine.retryNow()
				})
			}

			// Auto-reconnect on unexpected disconnect
			if (config.sync.autoReconnect !== false) {
				const engine = syncEngine
				emitter.on('sync:disconnected', () => {
					if (intentionalDisconnect) return
					// Ignore cascading disconnect events from failed reconnection attempts.
					// The reconnection manager is already retrying — don't restart it.
					if (reconnectionManager?.isRunning()) return

					engine.setReconnecting(true)
					reconnectionManager?.stop()
					reconnectionManager
						?.start(async () => {
							try {
								await engine.start()
								engine.setReconnecting(false)
								return true
							} catch {
								return false
							}
						})
						.then(() => {
							// If reconnection exhausted max attempts without success, clear flag
							engine.setReconnecting(false)
						})
				})
			}
		}
	})

	// Build sync control
	const syncControl: SyncControl | null = config.sync
		? {
				async connect(): Promise<void> {
					await ready
					if (syncEngine) {
						intentionalDisconnect = false
						reconnectionManager?.stop()
						reconnectionManager?.reset()
						await syncEngine.start()
					}
				},
				async disconnect(): Promise<void> {
					await ready
					if (syncEngine) {
						intentionalDisconnect = true
						reconnectionManager?.stop()
						await syncEngine.stop()
					}
				},
				getStatus(): SyncStatusInfo {
					if (syncEngine) {
						return syncEngine.getStatus()
					}
					return {
						status: 'offline',
						pendingOperations: 0,
						lastSyncedAt: null,
						lastSuccessfulPush: null,
						lastSuccessfulPull: null,
						conflicts: 0,
					}
				},
				async retryNow(): Promise<void> {
					await ready
					if (syncEngine) {
						await syncEngine.retryNow()
					}
				},
				exportDiagnostics() {
					if (syncEngine) {
						return syncEngine.exportDiagnostics()
					}
					return {
						state: 'disconnected' as const,
						status: {
							status: 'offline' as const,
							pendingOperations: 0,
							lastSyncedAt: null,
							lastSuccessfulPush: null,
							lastSuccessfulPull: null,
							conflicts: 0,
						},
						nodeId: '',
						url: config.sync?.url ?? '',
						schemaVersion: config.schema.version,
						lastSyncedAt: null,
						lastSuccessfulPush: null,
						lastSuccessfulPull: null,
						conflicts: 0,
						pendingOperations: 0,
						hasInFlightBatch: false,
						reconnecting: false,
						timestamp: Date.now(),
					}
				},
			}
		: null

	// Shared transaction executor for both transaction() and mutation()
	async function executeTransaction(
		fn: (tx: TransactionProxy) => Promise<void>,
		mutationName?: string,
	): Promise<Operation[]> {
		await ready
		if (!store) {
			throw new Error('Store not initialized. Await app.ready before using transactions.')
		}
		const txContext = store.createTransaction()
		if (mutationName !== undefined) {
			txContext.setMutationName(mutationName)
		}
		const collectionNames = Object.keys(config.schema.collections)

		// Build proxy with collection accessors as direct properties
		const proxy: TransactionProxy = {} as TransactionProxy
		for (const name of collectionNames) {
			Object.defineProperty(proxy, name, {
				get() {
					return txContext.collection(name)
				},
				enumerable: true,
				configurable: false,
			})
		}

		try {
			await fn(proxy)
			const { operations } = await txContext.commit()

			// Notify subscriptions and emit events after commit
			for (const op of operations) {
				store.getSubscriptionManager().notify(op.collection, op)
				emitter.emit({ type: 'operation:created', operation: op })
			}

			return operations
		} catch (error) {
			txContext.rollback()
			throw error
		}
	}

	// Build sequences accessor (delegates to SequenceManager after ready)
	const sequences: SequenceAccessor = {
		async next(name, config) {
			await ready
			if (!store) throw new Error('Store not initialized. Await app.ready before using sequences.')
			return store.getSequenceManager().next(name, config)
		},
		async current(name, config) {
			await ready
			if (!store) throw new Error('Store not initialized. Await app.ready before using sequences.')
			return store.getSequenceManager().current(name, config)
		},
		async reset(name, config) {
			await ready
			if (!store) throw new Error('Store not initialized. Await app.ready before using sequences.')
			return store.getSequenceManager().reset(name, config)
		},
	}

	// Build the KoraApp object
	const app: KoraApp = {
		ready,
		events: emitter,
		sync: syncControl,
		sequences,
		getStore(): Store {
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before accessing the store.')
			}
			return store
		},
		getSyncEngine(): SyncEngine | null {
			return syncEngine
		},
		async transaction(fn: (tx: TransactionProxy) => Promise<void>): Promise<Operation[]> {
			return executeTransaction(fn)
		},
		async mutation(
			name: string,
			fn: (tx: TransactionProxy) => Promise<void>,
		): Promise<Operation[]> {
			return executeTransaction(fn, name)
		},
		async close(): Promise<void> {
			await ready
			intentionalDisconnect = true
			if (qualityInterval !== null) {
				clearInterval(qualityInterval)
				qualityInterval = null
			}
			reconnectionManager?.stop()
			if (instrumenter) {
				instrumenter.destroy()
				instrumenter = null
			}
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
		async exportBackup(options?: BackupOptions): Promise<Uint8Array> {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before exporting backup.')
			}
			return store.exportBackup(options)
		},
		async importBackup(data: Uint8Array, options?: RestoreOptions): Promise<RestoreResult> {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before importing backup.')
			}
			return store.importBackup(data, options)
		},
	}

	// Define collection accessors via Object.defineProperty.
	// Before ready resolves, query methods return empty results.
	for (const collectionName of Object.keys(config.schema.collections)) {
		Object.defineProperty(app, collectionName, {
			get(): CollectionAccessor {
				return createCollectionAccessor(collectionName, () => store)
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
	const adapter: StorageAdapter = await createAdapter(adapterType, dbName, config.store?.workerUrl)

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

		// Build scope map from schema scope declarations + flat scope values
		const scopeMap = config.sync.scope ? buildScopeMap(config.schema, config.sync.scope) : undefined

		syncEngine = new SyncEngine({
			transport,
			store: mergeAwareStore,
			config: {
				url: config.sync.url,
				transport: config.sync.transport,
				auth: config.sync.auth,
				batchSize: config.sync.batchSize,
				schemaVersion: config.sync.schemaVersion ?? config.schema.version,
				scopeMap,
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

function createCollectionAccessor(
	collectionName: string,
	getStore: () => Store | null,
): CollectionAccessor {
	return {
		async insert(data: Record<string, unknown>) {
			const currentStore = getStore()
			if (!currentStore) {
				throw new Error(`Cannot mutate collection "${collectionName}" before app.ready resolves.`)
			}
			return currentStore.collection(collectionName).insert(data)
		},
		async findById(id: string) {
			const currentStore = getStore()
			if (!currentStore) return null
			return currentStore.collection(collectionName).findById(id)
		},
		async update(id: string, data: Record<string, unknown>) {
			const currentStore = getStore()
			if (!currentStore) {
				throw new Error(`Cannot mutate collection "${collectionName}" before app.ready resolves.`)
			}
			return currentStore.collection(collectionName).update(id, data)
		},
		async delete(id: string) {
			const currentStore = getStore()
			if (!currentStore) {
				throw new Error(`Cannot mutate collection "${collectionName}" before app.ready resolves.`)
			}
			return currentStore.collection(collectionName).delete(id)
		},
		where(conditions: Record<string, unknown>) {
			const currentStore = getStore()
			if (!currentStore) {
				return createPendingQueryBuilder(conditions)
			}
			return currentStore.collection(collectionName).where(conditions)
		},
	}
}

function createPendingQueryBuilder(initialWhere: Record<string, unknown>): QueryBuilder {
	const descriptor = {
		collection: '__pending__',
		where: { ...initialWhere },
		orderBy: [] as Array<{ field: string; direction: 'asc' | 'desc' }>,
		limit: undefined as number | undefined,
		offset: undefined as number | undefined,
	}

	const builder = {
		where(conditions: Record<string, unknown>) {
			descriptor.where = { ...descriptor.where, ...conditions }
			return this
		},
		orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
			descriptor.orderBy.push({ field, direction })
			return this
		},
		limit(n: number) {
			descriptor.limit = n
			return this
		},
		offset(n: number) {
			descriptor.offset = n
			return this
		},
		async exec() {
			return []
		},
		async count() {
			return 0
		},
		subscribe(callback: (results: Array<Record<string, unknown>>) => void) {
			void callback([])
			return () => {}
		},
		getDescriptor() {
			return { ...descriptor, where: { ...descriptor.where }, orderBy: [...descriptor.orderBy] }
		},
	}

	return builder as unknown as QueryBuilder
}
