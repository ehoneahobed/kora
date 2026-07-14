import type { KoraEventEmitter } from '@korajs/core'
import { buildScopeMap } from '@korajs/core'
import type { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import type { StorageAdapter } from '@korajs/store'
import { SyncEncryptor, SyncEngine } from '@korajs/sync'
import { createAdapter, detectAdapterType } from './adapter-resolver'
import { ApplyPipeline } from './apply-pipeline'
import { wireAuditPersistence } from './audit-bridge'
import { createSyncTransport } from './create-sync-transport'
import { MergeAwareSyncStore } from './merge-aware-sync-store'
import { StoreQueueStorage } from './store-queue-storage'
import { StoreSyncStatePersistence } from './store-sync-state'
import { createSyncQuerySubscriptionHook } from './sync-query-bridge'
import type { AuthSyncBinding, KoraConfig } from './types'

/** Result of opening the local store and optionally constructing a sync engine. */
export interface InitializeAppResult {
	store: Store
	syncEngine: SyncEngine | null
	unsubscribeSync: (() => void) | null
	unsubscribeAudit: (() => void) | null
	authBinding: AuthSyncBinding | null
}

/**
 * Opens the local store, wires apply/audit pipelines, and optionally constructs sync.
 */
export async function initializeApp(
	config: KoraConfig,
	emitter: KoraEventEmitter,
	mergeEngine: MergeEngine,
): Promise<InitializeAppResult> {
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

	const authBinding = config.sync?.authClient ?? null
	const authNodeId = authBinding?.resolveNodeId ? await authBinding.resolveNodeId() : undefined

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

	let unsubscribeSync: (() => void) | null = null

	if (config.sync) {
		const transport = createSyncTransport(config.sync)
		const mergeAwareStore = new MergeAwareSyncStore(store, mergeEngine, emitter, {
			onMergeConflict: () => recordConflict?.(),
		})

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
		authBinding,
	}
}
