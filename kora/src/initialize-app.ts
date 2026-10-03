import type { KoraEventEmitter, SchemaDefinition } from '@korajs/core'
import { buildScopeMap, hasSchemaSyncRules, isCollectionSyncScoped } from '@korajs/core'
import type { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import type {
	ChunkProvider,
	ContentAddressedBlobStore,
	StorageAdapter,
	StorageFallbackReason,
} from '@korajs/store'
import { createRemoteChunkProvider, serveBlobChunks } from '@korajs/store'
import type { EncryptionKeyring } from '@korajs/sync'
import { SyncEngine } from '@korajs/sync'
import { createAdapter, detectAdapterType } from './adapter-resolver'
import { ApplyPipeline } from './apply-pipeline'
import { wireAuditPersistence } from './audit-bridge'
import { authPrincipal, transportAuthState } from './auth-sync-coordinator'
import { wireBlobUpload } from './blob/blob-upload-coordinator'
import { resolveBlobStore } from './blob/resolve-blob-store'
import { createSyncEngineChunkPort } from './blob/sync-chunk-port'
import { createSyncTransport } from './create-sync-transport'
import { wireLocalOperationBus } from './local-operation-bus'
import { MergeAwareSyncStore } from './merge-aware-sync-store'
import { StoreQueueStorage } from './store-queue-storage'
import { StoreRejectedOperationStorage } from './store-rejected-storage'
import { StoreSyncStatePersistence } from './store-sync-state'
import { createSyncQuerySubscriptionHook } from './sync-query-bridge'
import type { AuthSyncBinding, KoraConfig } from './types'

/** Result of opening the local store and optionally constructing a sync engine. */
export interface InitializeAppResult {
	store: Store
	/** The local apply pipeline; its `applyRemote` is the path backups replay through. */
	applyPipeline: ApplyPipeline
	syncEngine: SyncEngine | null
	unsubscribeSync: (() => void) | null
	unsubscribeAudit: (() => void) | null
	unsubscribeLocalOperations: (() => void) | null
	authBinding: AuthSyncBinding | null
	/** Content-addressed store for blob bytes (OPFS in browser, memory otherwise). */
	blobStore: ContentAddressedBlobStore
	/** Chunk provider bound to the sync connection, or null when sync is disabled. */
	blobChunkProvider: ChunkProvider | null
	storeInfo: import('./types').StoreInfo
}

/**
 * Opens the local store, wires apply/audit pipelines, and optionally constructs sync.
 */
export async function initializeApp(
	config: KoraConfig,
	emitter: KoraEventEmitter,
	mergeEngine: MergeEngine,
	keyring: EncryptionKeyring | null = null,
): Promise<InitializeAppResult> {
	const adapterType = config.store?.adapter ?? detectAdapterType()
	let effectiveAdapterType = adapterType
	const baseDbName = config.store?.name ?? 'kora-db'
	const authBinding = config.sync?.authClient ?? null
	const authUserId =
		config.store?.namespaceByAuthUser && authBinding?.resolveUserId
			? await authBinding.resolveUserId()
			: undefined
	const dbName = resolveLocalDbName(baseDbName, authUserId, config.store?.namespaceByAuthUser)
	let adapter: StorageAdapter = await createAdapter(
		adapterType,
		dbName,
		config.store?.workerUrl,
		emitter,
		config.store?.workerResponseTimeoutMs,
		config.store?.sharedWorkerUrl,
		adapterType === 'sqlite-wasm',
		// createApp inspects the open state below and moves to durable IndexedDB
		// itself; a later leader promotion that loses durability is still refused.
		{ allowNonDurable: config.store?.allowNonDurable === true, deferOpenCheck: true },
	)

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

	const buildStore = (storeAdapter: StorageAdapter): Store =>
		new Store({
			schema: config.schema,
			adapter: storeAdapter,
			emitter,
			dbName,
			nodeId: authNodeId,
			isolation: authNodeId ? 'shared' : config.store?.isolation,
			materialization: config.experimental?.legacyMerge === true ? 'legacy' : 'fold',
			...(config.store?.maxOperationBytes !== undefined
				? { maxOperationBytes: config.store.maxOperationBytes }
				: {}),
			...(secretKeyProvider ? { secretKeyProvider } : {}),
			// The store folds every operation through the schema transforms (transforms at
			// fold time, RT-84): the same list the sync engine judges views with.
			...(config.sync?.operationTransforms
				? { operationTransforms: config.sync.operationTransforms }
				: {}),
			...(config.sync
				? { onQuerySubscribed: createSyncQuerySubscriptionHook(() => syncEngine) }
				: {}),
		})

	let store = buildStore(adapter)
	await store.open()

	if (adapterType === 'sqlite-wasm' && adapter.getStorageOpenState?.()?.persistent === false) {
		const fallbackReason = adapter.getStorageOpenState()?.fallbackReason ?? 'unsupported'
		await store.close()

		try {
			adapter = await createAdapter(
				'indexeddb',
				dbName,
				config.store?.workerUrl,
				emitter,
				config.store?.workerResponseTimeoutMs,
			)
			effectiveAdapterType = 'indexeddb'
			store = buildStore(adapter)
			await store.open()
			emitter.emit({
				type: 'store:storage-fallback',
				dbName,
				from: 'opfs',
				to: 'indexeddb',
				reason: fallbackReason,
				message: `OPFS persistence is unavailable (${fallbackReason}) for database "${dbName}"; Kora is using durable IndexedDB instead.`,
			})
		} catch {
			effectiveAdapterType = 'sqlite-wasm'
			adapter = await createAdapter(
				'sqlite-wasm',
				dbName,
				config.store?.workerUrl,
				emitter,
				config.store?.workerResponseTimeoutMs,
				config.store?.sharedWorkerUrl,
				true,
				// Neither OPFS nor IndexedDB is durable here. Without an explicit
				// opt-in the adapter emits store:durability-lost and refuses writes
				// (NEW-STORE-6) instead of running silently in memory.
				{ allowNonDurable: config.store?.allowNonDurable === true },
			)
			store = buildStore(adapter)
			await store.open()
			emitOpfsUnavailable(emitter, dbName, fallbackReason)
		}
	}

	// Bind local writes to the signed-in user before the app can write (RT-42): a node
	// that belongs to another user is never written under, uploaded or adopted for this
	// user. Later user changes rebind through the auth binding's subscription.
	const principal = config.sync ? authPrincipal(authBinding) : undefined
	let initialPrincipal: string | null = null
	if (principal) {
		const userId = await principal()
		if (userId) await store.bindPrincipal(userId)
		initialPrincipal = userId ?? null
	}
	// Open the signed-in user's cached keyring (ENC-1): a device that unlocked before
	// starts unlocked, offline.
	await keyring?.load(initialPrincipal)

	let recordConflict: (() => void) | undefined
	const applyPipeline = new ApplyPipeline({
		store,
		mergeEngine,
		emitter,
		onMergeConflict: () => recordConflict?.(),
	})
	store.setLocalMutationHandler(applyPipeline)
	const unsubscribeAudit = wireAuditPersistence(store, emitter)
	const unsubscribeLocalOperations = wireLocalOperationBus(dbName, store, emitter)

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

		syncEngine = new SyncEngine({
			transport,
			store: mergeAwareStore,
			config: {
				url: config.sync.url,
				transport: config.sync.transport,
				auth: syncAuth,
				authState: transportAuthState(authBinding),
				...(principal ? { principal } : {}),
				querySubsets: config.sync.querySubsets,
				scopeExit: config.sync.scopeExit,
				batchSize: config.sync.batchSize,
				schemaVersion: config.sync.schemaVersion ?? config.schema.version,
				scopeMap,
				syncedCollections: schemaSyncedCollections(config.schema),
				encryption: config.sync.encryption,
				strictHandshake: config.sync.strictHandshake,
				operationTransforms: config.sync.operationTransforms,
			},
			emitter,
			queueStorage: new StoreQueueStorage(adapter),
			rejectedStorage: new StoreRejectedOperationStorage(adapter),
			syncState: new StoreSyncStatePersistence(store, scopeMap),
			// End-to-end encryption uses the user's shared keyring, opened at each
			// handshake from the server-stored wrapped record (ENC-1, D4b).
			...(keyring ? { keyring } : {}),
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
		applyPipeline,
		syncEngine,
		unsubscribeSync,
		unsubscribeAudit,
		unsubscribeLocalOperations,
		authBinding,
		blobStore,
		blobChunkProvider,
		storeInfo: {
			baseName: baseDbName,
			databaseName: dbName,
			authUserId: authUserId ?? null,
			persistence: effectiveAdapterType,
			durable: adapter.getStorageOpenState?.()?.persistent ?? adapterType !== 'sqlite-wasm',
			isolationState: 'ready',
		},
	}
}

function emitOpfsUnavailable(
	emitter: KoraEventEmitter,
	dbName: string,
	reason: StorageFallbackReason,
): void {
	emitter.emit({
		type: 'store:opfs-unavailable',
		dbName,
		reason,
		message: `OPFS persistence is unavailable (${reason}) for database "${dbName}", and IndexedDB fallback could not open; the store is running in memory and data will not survive a reload.`,
	})
}

function resolveLocalDbName(
	baseName: string,
	authUserId: string | undefined,
	namespaceByAuthUser: boolean | undefined,
): string {
	if (!namespaceByAuthUser) {
		return baseName
	}
	return `${baseName}__user_${encodeDbNameComponent(authUserId ?? 'signed-out')}`
}

function encodeDbNameComponent(value: string): string {
	let encoded = ''
	for (const char of value) {
		if (/^[A-Za-z0-9._-]$/.test(char)) {
			encoded += char
			continue
		}
		encoded += `_${char.codePointAt(0)?.toString(16) ?? '0'}`
	}
	return encoded || 'empty'
}

/**
 * The collections a schema syncs: every collection, or only the sync-scoped ones when
 * the schema declares partial sync rules (the others are local-only).
 */
function schemaSyncedCollections(schema: SchemaDefinition): string[] {
	const names = Object.keys(schema.collections)
	return hasSchemaSyncRules(schema)
		? names.filter((name) => isCollectionSyncScoped(schema, name))
		: names
}
