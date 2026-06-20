import type { KoraEventEmitter, Operation, SchemaInput } from '@korajs/core'
import { buildScopeMap } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { Instrumenter } from '@korajs/devtools'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import type {
	AuditExportOptions,
	BackupOptions,
	CollectionAccessor,
	QueryBuilder,
	ReplaySnapshot,
	RestoreOptions,
	RestoreResult,
	StorageAdapter,
} from '@korajs/store'
import {
	ConnectionMonitor,
	HttpLongPollingTransport,
	ReconnectionManager,
	SyncEncryptor,
	SyncEngine,
	WebSocketTransport,
} from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
import type { SyncStatusInfo } from '@korajs/sync'
import { createAdapter, detectAdapterType } from './adapter-resolver'
import { AppNotReadyError } from './app-not-ready-error'
import { ApplyPipeline } from './apply-pipeline'
import { wireAuditPersistence } from './audit-bridge'
import { MergeAwareSyncStore } from './merge-aware-sync-store'
import { StoreQueueStorage } from './store-queue-storage'
import { StoreSyncStatePersistence } from './store-sync-state'
import { createSyncQuerySubscriptionHook } from './sync-query-bridge'
import { createSyncStatusBridge } from './sync-status-bridge'
import type {
	AuthSyncBinding,
	KoraApp,
	KoraConfig,
	KoraSyncEvent,
	SequenceAccessor,
	SyncControl,
	TransactionProxy,
	TypedKoraApp,
	TypedKoraConfig,
} from './types'
import { validateCreateAppConfig } from './validate-config'

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
export function createApp<const S extends SchemaInput>(
	config: TypedKoraConfig<S> | KoraConfig,
): TypedKoraApp<S> | KoraApp {
	validateCreateAppConfig(config)

	const emitter: KoraEventEmitter & { clear(): void } = new SimpleEventEmitter()
	const mergeEngine = new MergeEngine()

	if (config.onSyncEvent) {
		const handler = config.onSyncEvent
		const syncTypes = [
			'sync:connected',
			'sync:disconnected',
			'sync:schema-mismatch',
			'sync:auth-failed',
			'sync:sent',
			'sync:received',
			'sync:acknowledged',
			'sync:apply-failed',
			'sync:diagnostics',
			'sync:bandwidth',
			'sync:initial-sync-progress',
		] as const
		for (const type of syncTypes) {
			emitter.on(type, (event) => {
				handler(event as KoraSyncEvent)
			})
		}
	}

	let store: Store | null = null
	let syncEngine: SyncEngine | null = null
	let unsubscribeSync: (() => void) | null = null
	let unsubscribeAudit: (() => void) | null = null
	let reconnectionManager: ReconnectionManager | null = null
	let connectionMonitor: ConnectionMonitor | null = null
	let instrumenter: Instrumenter | null = null
	let intentionalDisconnect = false
	let qualityInterval: ReturnType<typeof setInterval> | null = null
	let syncStatusBridge: ReturnType<typeof createSyncStatusBridge> | null = null
	let destroyDevtoolsOverlay: (() => void) | null = null

	// Wire DevTools instrumentation immediately (emitter exists synchronously)
	if (config.devtools) {
		instrumenter = new Instrumenter(emitter, {
			bridgeEnabled: typeof globalThis !== 'undefined' && 'window' in globalThis,
		})
		if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
			void import('@korajs/devtools/overlay')
				.then(({ mountKoraDevtoolsOverlay }) => {
					if (instrumenter) {
						destroyDevtoolsOverlay = mountKoraDevtoolsOverlay(instrumenter)
					}
				})
				.catch(() => {
					// Overlay is optional; extension bridge still works.
				})
		}
	}

	// Build the ready promise — resolves when the store is open and wired
	const ready = initializeAsync(config, emitter, mergeEngine).then((result) => {
		store = result.store
		syncEngine = result.syncEngine
		unsubscribeSync = result.unsubscribeSync
		unsubscribeAudit = result.unsubscribeAudit
		const authBinding = result.authBinding

		if (config.sync) {
			syncStatusBridge = createSyncStatusBridge(emitter, () => syncEngine)
			syncStatusBridge.refresh()
		}

		if (config.sync && syncEngine && authBinding?.subscribe) {
			authBinding.subscribe(() => {
				const engine = syncEngine
				if (!engine) {
					return
				}

				void (async () => {
					const headers = await authBinding.auth()
					if (!headers.token) {
						await engine.stop()
						return
					}

					if (authBinding.resolveScopeMap) {
						const nextScope = await authBinding.resolveScopeMap()
						engine.updateScope(nextScope)
					}

					const status = engine.getStatus().status
					if (status !== 'offline') {
						await engine.stop()
					}
					await engine.start()
				})()
			})
		}

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
			const browserGlobal = globalThis as typeof globalThis & {
				addEventListener?: (type: string, listener: () => void) => void
			}
			if (typeof browserGlobal.addEventListener === 'function') {
				const engine = syncEngine
				browserGlobal.addEventListener('online', () => {
					if (intentionalDisconnect || config.sync?.autoReconnect === false) return
					reconnectionManager?.wake()
					reconnectionManager?.reset()
					void engine.retryNow()
				})
			}

			emitter.on('sync:schema-mismatch', () => {
				reconnectionManager?.stop()
				intentionalDisconnect = true
			})

			// Auto-reconnect on unexpected disconnect
			if (config.sync.autoReconnect !== false) {
				const engine = syncEngine
				emitter.on('sync:disconnected', () => {
					if (intentionalDisconnect || engine.isSchemaBlocked()) return
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

			if (config.sync.autoConnect === true && syncEngine) {
				void syncEngine.start().catch(() => {
					// Errors surface via sync:disconnected / sync events; avoid unhandled rejection.
				})
			}
		}
	})

	const offlineSyncStatus = (): SyncStatusInfo => ({
		status: 'offline',
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
	})

	// Build sync control
	const syncControl: SyncControl | null = config.sync
		? {
				get status(): SyncStatusInfo {
					return syncStatusBridge?.status ?? offlineSyncStatus()
				},
				subscribeStatus(listener: (status: SyncStatusInfo) => void): () => void {
					if (syncStatusBridge) {
						return syncStatusBridge.subscribe(listener)
					}
					listener(offlineSyncStatus())
					return () => {}
				},
				async connect(): Promise<void> {
					await ready
					if (syncEngine) {
						intentionalDisconnect = false
						reconnectionManager?.stop()
						reconnectionManager?.reset()
						await syncEngine.start()
						syncStatusBridge?.refresh()
					}
				},
				async disconnect(): Promise<void> {
					await ready
					if (syncEngine) {
						intentionalDisconnect = true
						reconnectionManager?.stop()
						await syncEngine.stop()
						syncStatusBridge?.refresh()
					}
				},
				getStatus(): SyncStatusInfo {
					if (syncEngine) {
						return syncEngine.getStatus()
					}
					return offlineSyncStatus()
				},
				async retryNow(): Promise<void> {
					await ready
					if (syncEngine) {
						await syncEngine.retryNow()
					}
				},
				clearSchemaBlock(): void {
					syncEngine?.clearSchemaBlock()
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
		const collectionNames = Object.keys(config.schema.collections)

		return store.transaction(async (tx) => {
			if (mutationName !== undefined) {
				tx.setMutationName(mutationName)
			}
			const proxy: TransactionProxy = {} as TransactionProxy
			for (const name of collectionNames) {
				Object.defineProperty(proxy, name, {
					get() {
						return tx.collection(name)
					},
					enumerable: true,
					configurable: false,
				})
			}
			await fn(proxy)
		})
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
			if (destroyDevtoolsOverlay) {
				destroyDevtoolsOverlay()
				destroyDevtoolsOverlay = null
			}
			if (instrumenter) {
				instrumenter.destroy()
				instrumenter = null
			}
			if (unsubscribeSync) {
				unsubscribeSync()
				unsubscribeSync = null
			}
			if (unsubscribeAudit) {
				unsubscribeAudit()
				unsubscribeAudit = null
			}
			if (syncEngine) {
				await syncEngine.stop()
				syncEngine = null
			}
			if (syncStatusBridge) {
				syncStatusBridge.destroy()
				syncStatusBridge = null
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
		async replayTo(operationId: string): Promise<ReplaySnapshot> {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before replaying operations.')
			}
			return store.replayTo(operationId)
		},
		async exportAudit(options?: AuditExportOptions): Promise<Uint8Array> {
			await ready
			if (!store) {
				throw new Error('Store not initialized. Await app.ready before exporting audit data.')
			}
			return store.exportAudit(options)
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
	unsubscribeAudit: (() => void) | null
	authBinding: AuthSyncBinding | null
}> {
	// Resolve adapter
	const adapterType = config.store?.adapter ?? detectAdapterType()
	const dbName = config.store?.name ?? 'kora-db'
	const adapter: StorageAdapter = await createAdapter(
		adapterType,
		dbName,
		config.store?.workerUrl,
		emitter,
		config.store?.workerResponseTimeoutMs,
		config.store?.sharedWorkerUrl,
	)

	// Device-bound sync node id from auth token (`dev` claim), separate from user id (`sub`).
	const authBinding = config.sync?.authClient
	const authNodeId = authBinding?.resolveNodeId ? await authBinding.resolveNodeId() : undefined

	// Create and open the store (sync query hook uses a ref filled after SyncEngine is created)
	let syncEngine: SyncEngine | null = null

	const store = new Store({
		schema: config.schema,
		adapter,
		emitter,
		dbName,
		nodeId: authNodeId,
		isolation: authNodeId ? 'shared' : config.store?.isolation,
		...(config.sync
			? { onQuerySubscribed: createSyncQuerySubscriptionHook(() => syncEngine) }
			: {}),
	})
	await store.open()

	let recordConflict: (() => void) | undefined
	const applyPipeline = new ApplyPipeline({
		store,
		mergeEngine,
		emitter,
		onMergeConflict: () => recordConflict?.(),
	})
	store.setLocalMutationHandler(applyPipeline)
	const unsubscribeAudit = wireAuditPersistence(store, emitter)

	// Wire sync if configured
	let unsubscribeSync: (() => void) | null = null

	if (config.sync) {
		const transport = createSyncTransport(config.sync)
		const mergeAwareStore = new MergeAwareSyncStore(store, mergeEngine, emitter, {
			onMergeConflict: () => recordConflict?.(),
		})

		// Build scope map from auth binding, flat scope values, or static config
		let scopeMap = config.sync.scope ? buildScopeMap(config.schema, config.sync.scope) : undefined
		if (authBinding?.resolveScopeMap) {
			scopeMap = (await authBinding.resolveScopeMap()) ?? scopeMap
		}

		const syncAuth = authBinding?.auth ?? config.sync.auth

		const encryptor =
			config.sync.encryption?.enabled === true
				? await SyncEncryptor.create(config.sync.encryption)
				: undefined

		syncEngine = new SyncEngine({
			transport,
			store: mergeAwareStore,
			config: {
				url: config.sync.url,
				transport: config.sync.transport,
				auth: syncAuth,
				batchSize: config.sync.batchSize,
				schemaVersion: config.sync.schemaVersion ?? config.schema.version,
				scopeMap,
				encryption: config.sync.encryption,
				strictHandshake: config.sync.strictHandshake,
				operationTransforms: config.sync.operationTransforms,
			},
			emitter,
			queueStorage: new StoreQueueStorage(adapter),
			syncState: new StoreSyncStatePersistence(store, scopeMap),
			encryptor,
		})
		recordConflict = () => syncEngine?.recordConflict()

		// Wire local mutations → sync outbound queue
		unsubscribeSync = emitter.on('operation:created', (event) => {
			if (syncEngine) {
				syncEngine.pushOperation(event.operation)
			}
		})
	}

	return {
		store,
		syncEngine,
		unsubscribeSync,
		unsubscribeAudit,
		authBinding: config.sync?.authClient ?? null,
	}
}

function createSyncTransport(sync: NonNullable<KoraConfig['sync']>): SyncTransport {
	if (sync.transport === 'http') {
		return new HttpLongPollingTransport()
	}
	return new WebSocketTransport()
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
			throw new AppNotReadyError(
				'Cannot execute a query before app.ready. Await app.ready or use <KoraProvider app={app}>.',
			)
		},
		async count() {
			throw new AppNotReadyError(
				'Cannot count query results before app.ready. Await app.ready or use <KoraProvider app={app}>.',
			)
		},
		subscribe(_callback: (results: Array<Record<string, unknown>>) => void) {
			throw new AppNotReadyError(
				'Cannot subscribe to a query before app.ready. Await app.ready or use <KoraProvider app={app}>.',
			)
		},
		getDescriptor() {
			return { ...descriptor, where: { ...descriptor.where }, orderBy: [...descriptor.orderBy] }
		},
	}

	return builder as unknown as QueryBuilder
}
