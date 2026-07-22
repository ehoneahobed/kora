import type { KoraEventEmitter } from '@korajs/core'
import { buildScopeMap } from '@korajs/core'
import type { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import type { ChunkProvider, ContentAddressedBlobStore, StorageAdapter } from '@korajs/store'
import { createRemoteChunkProvider, serveBlobChunks } from '@korajs/store'
import { SyncEncryptor, SyncEngine } from '@korajs/sync'
import { createAdapter, detectAdapterType } from './adapter-resolver'
import { ApplyPipeline } from './apply-pipeline'
import { wireAuditPersistence } from './audit-bridge'
import { wireBlobUpload } from './blob/blob-upload-coordinator'
import { resolveBlobStore } from './blob/resolve-blob-store'
import { createSyncEngineChunkPort } from './blob/sync-chunk-port'
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
	/** Content-addressed store for blob bytes (OPFS in browser, memory otherwise). */
	blobStore: ContentAddressedBlobStore
	/** Chunk provider bound to the sync connection, or null when sync is disabled. */
	blobChunkProvider: ChunkProvider | null
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

	// Encrypted `secret` fields reuse the sync encryption key. A string is used
	// directly; a provider function is called on demand. Present whenever a key is
	// configured, independent of whether wire encryption is enabled.
	const encryptionKey = config.sync?.encryption?.key
	const secretKeyProvider = encryptionKey
		? typeof encryptionKey === 'string'
			? () => encryptionKey
			: () => encryptionKey()
		: undefined

	const store = new Store({
		schema: config.schema,
		adapter,
		emitter,
		dbName,
		nodeId: authNodeId,
		isolation: authNodeId ? 'shared' : config.store?.isolation,
		...(secretKeyProvider ? { secretKeyProvider } : {}),
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

	// Blob byte storage is useful offline (local reads/writes) independent of sync.
	const blobStore = await resolveBlobStore(config.blob, dbName)
	let blobChunkProvider: ChunkProvider | null = null

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

		// Bind blob transfer to the sync connection: automatically serve chunks this
		// device holds, and prepare a provider to pull chunks it needs. Zero developer
		// wiring — a blob authored on one device becomes pullable on another.
		const chunkPort = createSyncEngineChunkPort(syncEngine)
		serveBlobChunks(chunkPort, blobStore)
		blobChunkProvider = createRemoteChunkProvider(chunkPort)

		// Auto-upload blob bytes to the server (when it advertises blob storage) as
		// their operations sync, so blobs survive the authoring device going offline.
		const unsubscribeBlobUpload = wireBlobUpload(emitter, syncEngine, blobStore)

		const unsubscribePush = emitter.on('operation:created', (event) => {
			if (syncEngine) {
				syncEngine.pushOperation(event.operation)
			}
		})
		unsubscribeSync = () => {
			unsubscribePush()
			unsubscribeBlobUpload()
		}
	}

	return {
		store,
		syncEngine,
		unsubscribeSync,
		unsubscribeAudit,
		authBinding,
		blobStore,
		blobChunkProvider,
	}
}
