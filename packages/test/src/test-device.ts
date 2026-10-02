import type { OperationTransform, SchemaDefinition } from '@korajs/core'
import type { VersionVector } from '@korajs/core'
import type { KoraEventEmitter } from '@korajs/core'
import type { BlobRef } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import {
	MemoryBlobStore,
	Store,
	createRemoteChunkProvider,
	prepareBlobForSend,
	putBlobForTransfer,
	receiveBlob,
	resolveBlobManifest,
	serveBlobChunks,
} from '@korajs/store'
import type {
	BlobManifest,
	ChunkProvider,
	CollectionAccessor,
	ReceiveBlobResult,
	StorageAdapter,
} from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEncryptor, SyncEngine } from '@korajs/sync'
import type { SyncEncryptionConfig, SyncTransport } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
	createSyncEngineChunkPort,
	wireAuditPersistence,
	wireBlobUpload,
} from 'korajs/testing'

/** What a device needs from its server: a way to open a session on it. */
export interface TestDeviceServer {
	handleConnection(transport: import('@korajs/server').ServerTransport): string
}

/**
 * End-to-end encryption of a test device's sync traffic. Devices that must read each
 * other's operations share the passphrase AND the key-derivation salt (shared key
 * distribution, ENC-1, is not built yet).
 */
export interface TestDeviceEncryption {
	config: SyncEncryptionConfig
	salt: Uint8Array
	/** PBKDF2 iterations (lower in tests for speed). */
	iterations?: number
}

/**
 * Options for creating a TestDevice.
 */
export interface TestDeviceOptions {
	/** Unique device name (used for DB file naming) */
	name: string
	/** Schema definition */
	schema: SchemaDefinition
	/** Test server to connect to */
	server: TestDeviceServer
	/** Transport factory — creates a linked client/server transport pair */
	createTransportPair: () => {
		client: SyncTransport
		serverTransport: import('@korajs/server').ServerTransport
	}
	/** Optional directory for temp DB files */
	tmpDir: string
	/** Client handshake schema version. Defaults to `schema.version`. */
	syncSchemaVersion?: number
	/** Transforms applied to inbound operations before local apply. */
	operationTransforms?: OperationTransform[]
	/** What the device does with records that leave its scope. Defaults to the engine default ('retain'). */
	scopeExit?: 'retain' | 'retract'
	/**
	 * The signed-in user, as an auth-aware app knows it (RT-42). When set, the store binds
	 * its node to that user at open and on {@link TestDevice.authChanged}, and the sync
	 * engine never uploads another user's node on this user's session.
	 */
	principal?: () => string | null
	/**
	 * Let the sync engine reconnect on its own, as over a real WebSocket: a `connect()`
	 * after the session closed opens a new transport pair to the server. Off by default
	 * (a closed pair stays closed until the next {@link TestDevice.sync}).
	 */
	reconnectable?: boolean
	/**
	 * Run the device on the beta.13 pairwise pipeline (`experimental.legacyMerge`)
	 * instead of the W7 fold. Used by the comparison harness.
	 */
	legacyMerge?: boolean
	/** Encrypt sync traffic end to end (protocol v2 envelope). */
	encryption?: TestDeviceEncryption
	/** Upload batch size of the sync engine (default: the engine's). */
	batchSize?: number
}

type TransportPairFactory = TestDeviceOptions['createTransportPair']

/**
 * A client transport that opens a fresh pair to the test server whenever it connects
 * after its current pair closed (a real socket reconnecting). Handlers move with it.
 */
class ReconnectingClientTransport implements SyncTransport {
	private messageHandler: Parameters<SyncTransport['onMessage']>[0] | null = null
	private closeHandler: Parameters<SyncTransport['onClose']>[0] | null = null
	private errorHandler: Parameters<SyncTransport['onError']>[0] | null = null
	private connectedOnce = false

	constructor(
		private inner: SyncTransport,
		private readonly createPair: TransportPairFactory,
		private readonly server: TestDeviceServer,
	) {}

	async connect(url: string, options?: Parameters<SyncTransport['connect']>[1]): Promise<void> {
		if (this.connectedOnce && !this.inner.isConnected()) {
			const previous = this.inner
			previous.onMessage(() => {})
			previous.onClose(() => {})
			previous.onError(() => {})
			const { client, serverTransport } = this.createPair()
			this.inner = client
			this.wire()
			this.server.handleConnection(serverTransport)
		}
		this.connectedOnce = true
		await this.inner.connect(url, options)
	}

	disconnect(): Promise<void> {
		return this.inner.disconnect()
	}

	send(message: Parameters<SyncTransport['send']>[0]): void {
		this.inner.send(message)
	}

	onMessage(handler: Parameters<SyncTransport['onMessage']>[0]): void {
		this.messageHandler = handler
		this.wire()
	}

	onClose(handler: Parameters<SyncTransport['onClose']>[0]): void {
		this.closeHandler = handler
		this.wire()
	}

	onError(handler: Parameters<SyncTransport['onError']>[0]): void {
		this.errorHandler = handler
		this.wire()
	}

	isConnected(): boolean {
		return this.inner.isConnected()
	}

	private wire(): void {
		this.inner.onMessage((message) => this.messageHandler?.(message))
		this.inner.onClose((reason) => this.closeHandler?.(reason))
		this.inner.onError((error) => this.errorHandler?.(error))
	}
}

/**
 * A virtual device in a test network.
 * Each device has its own Store (with real SQLite), SyncEngine, and MergeEngine.
 * Provides high-level methods for syncing, disconnecting, and inspecting state.
 */
export class TestDevice {
	readonly name: string
	readonly store: Store
	readonly emitter: KoraEventEmitter & { clear(): void }
	/** Content-addressed blob store for out-of-band blob bytes (chunks + full blobs). */
	readonly blobStore = new MemoryBlobStore()

	private readonly schema: SchemaDefinition
	private readonly server: TestDeviceServer
	private readonly encryption: TestDeviceEncryption | undefined
	private readonly batchSize: number | undefined
	private encryptor: SyncEncryptor | null = null
	private readonly mergeEngine: MergeEngine
	private readonly createTransportPair: TestDeviceOptions['createTransportPair']
	private readonly adapter: StorageAdapter
	private readonly dbPath: string
	private readonly syncSchemaVersion: number
	private readonly operationTransforms: OperationTransform[]
	private readonly scopeExit: 'retain' | 'retract' | undefined
	private readonly principal: (() => string | null) | undefined
	private readonly reconnectable: boolean

	private applyPipeline: ApplyPipeline | null = null
	private syncEngine: SyncEngine | null = null
	private blobChunkProvider: ChunkProvider | null = null
	private currentTransport: SyncTransport | null = null
	private unsubscribeSync: (() => void) | null = null
	private unsubscribeAudit: (() => void) | null = null
	private closing = false

	constructor(options: TestDeviceOptions) {
		this.name = options.name
		this.schema = options.schema
		this.server = options.server
		this.createTransportPair = options.createTransportPair
		this.dbPath = `${options.tmpDir}/test-device-${options.name}.db`
		this.syncSchemaVersion = options.syncSchemaVersion ?? options.schema.version
		this.operationTransforms = options.operationTransforms ?? []
		this.scopeExit = options.scopeExit
		this.principal = options.principal
		this.reconnectable = options.reconnectable === true
		this.encryption = options.encryption
		this.batchSize = options.batchSize

		this.emitter = new SimpleEventEmitter()
		this.mergeEngine = new MergeEngine()
		this.adapter = new BetterSqlite3Adapter(this.dbPath)
		this.store = new Store({
			schema: options.schema,
			adapter: this.adapter,
			emitter: this.emitter,
			materialization: options.legacyMerge === true ? 'legacy' : 'fold',
		})
	}

	/**
	 * Open the store (must be called before sync or collection operations).
	 */
	async open(): Promise<void> {
		await this.store.open()
		this.applyPipeline = new ApplyPipeline({
			store: this.store,
			mergeEngine: this.mergeEngine,
			emitter: this.emitter,
		})
		this.store.setLocalMutationHandler(this.applyPipeline)
		// Match production wiring (createApp): merge/constraint traces persist to
		// `_kora_audit_traces`. Without this, harness devices emit merge events
		// but the durable audit trail every real app has stays empty — a fidelity
		// gap that hid from tests until Studio's Merges view made it visible.
		this.unsubscribeAudit = wireAuditPersistence(this.store, this.emitter)
		// Like createApp with an auth binding: the node is bound to the signed-in user
		// before the first local write (RT-42).
		const principal = this.principal?.()
		if (principal) await this.store.bindPrincipal(principal)
	}

	/**
	 * The signed-in user changed (RT-42), as an auth binding reports it: like createApp,
	 * end the live session and bind the store to the new user before the next write.
	 */
	async authChanged(): Promise<void> {
		if (this.syncEngine) {
			await this.syncEngine.refreshPrincipal()
			return
		}
		const principal = this.principal?.()
		if (principal) await this.store.bindPrincipal(principal)
	}

	/**
	 * Connect to the test server and perform initial sync.
	 * If already connected, flushes any pending operations.
	 */
	async sync(): Promise<void> {
		if (this.syncEngine && this.currentTransport?.isConnected()) {
			// Already connected — flush outbound ops, then allow inbound relay to settle
			await this.waitForPendingOps()
			await this.waitForSettled()
			return
		}

		// Create a new transport pair and connect
		const created = this.createTransportPair()
		const { serverTransport } = created
		const client = this.reconnectable
			? new ReconnectingClientTransport(created.client, this.createTransportPair, this.server)
			: created.client
		this.currentTransport = client

		if (this.encryption && !this.encryptor) {
			this.encryptor = await SyncEncryptor.create(
				this.encryption.config,
				this.encryption.salt,
				this.encryption.iterations,
			)
		}

		const conflictHandler: { fn?: () => void } = {}
		const syncStore = new MergeAwareSyncStore(this.store, this.mergeEngine, this.emitter, {
			onMergeConflict: () => conflictHandler.fn?.(),
		})

		this.syncEngine = new SyncEngine({
			transport: client,
			store: syncStore,
			queueStorage: new StoreQueueStorage(this.adapter),
			syncState: new StoreSyncStatePersistence(this.store),
			config: {
				url: 'ws://test-network',
				schemaVersion: this.syncSchemaVersion,
				operationTransforms:
					this.operationTransforms.length > 0 ? this.operationTransforms : undefined,
				...(this.scopeExit ? { scopeExit: this.scopeExit } : {}),
				...(this.principal
					? { principal: async () => (this.principal ? this.principal() : null) }
					: {}),
				...(this.encryption ? { encryption: this.encryption.config } : {}),
				...(this.batchSize !== undefined ? { batchSize: this.batchSize } : {}),
			},
			emitter: this.emitter,
			...(this.encryptor ? { encryptor: this.encryptor } : {}),
		})
		conflictHandler.fn = () => this.syncEngine?.recordConflict()

		// Bind the blob chunk channel to this connection: serve chunks this device
		// holds, and prepare a provider to pull chunks it needs. Both ride the same
		// sync socket; the request/response handlers are disjoint by message type.
		const chunkPort = createSyncEngineChunkPort(this.syncEngine)
		serveBlobChunks(chunkPort, this.blobStore)
		this.blobChunkProvider = createRemoteChunkProvider(chunkPort)
		// Mirror createApp: auto-upload blob bytes to the server as ops sync, so
		// blobs stay available after this device disconnects.
		wireBlobUpload(this.emitter, this.syncEngine, this.blobStore)

		// Wire local mutations to sync outbound queue
		const engine = this.syncEngine
		this.unsubscribeSync = this.emitter.on('operation:created', (event) => {
			if (!this.closing && this.syncEngine === engine && this.currentTransport?.isConnected()) {
				// Catch async errors from push racing with disconnect during teardown
				this.syncEngine.pushOperation(event.operation).catch(() => {})
			}
		})

		// Register server-side connection
		this.server.handleConnection(serverTransport)

		// Start sync engine (connects, handshakes, exchanges deltas)
		await this.syncEngine.start()

		// Wait for sync messages to propagate (in-memory transport is synchronous
		// but some processing is async)
		await this.waitForSettled()
	}

	/**
	 * Disconnect from the test server.
	 */
	async disconnect(): Promise<void> {
		if (this.unsubscribeSync) {
			this.unsubscribeSync()
			this.unsubscribeSync = null
		}
		if (this.syncEngine) {
			await this.syncEngine.stop()
			this.syncEngine = null
		}
		this.blobChunkProvider = null
		this.currentTransport = null
	}

	/**
	 * Reconnect to the test server after a disconnect.
	 */
	async reconnect(): Promise<void> {
		await this.sync()
	}

	/**
	 * Get a collection accessor for performing CRUD operations.
	 */
	collection(name: string): CollectionAccessor {
		return this.store.collection(name)
	}

	/**
	 * Get all records from a collection (convenience method).
	 */
	async getState(collectionName: string): Promise<Record<string, unknown>[]> {
		const accessor = this.store.collection(collectionName)
		return accessor.where({}).exec()
	}

	/**
	 * Get the device's node ID.
	 */
	getNodeId(): string {
		return this.store.getNodeId()
	}

	/** Exposes the sync engine for integration tests (e.g. doc channel, chaos). */
	getSyncEngine(): SyncEngine | null {
		return this.syncEngine
	}

	/**
	 * Operations the server rejected for this device that have not been reconciled.
	 * Empty when the device has never connected.
	 */
	async getRejectedOperations(): Promise<import('@korajs/sync').RejectedOperation[]> {
		if (!this.syncEngine) return []
		return this.syncEngine.getRejectedOperations()
	}

	/**
	 * Stage a blob's bytes into this device's blob store, splitting them into
	 * content-addressed chunks this device can then serve to peers over the sync
	 * connection. Returns the manifest (blob hash + ordered chunk hashes) needed
	 * to pull the blob elsewhere.
	 */
	async stageBlob(bytes: Uint8Array, options?: { chunkSize?: number }): Promise<BlobManifest> {
		const { manifest } = await prepareBlobForSend(bytes, this.blobStore, options)
		return manifest
	}

	/**
	 * Store a blob for transfer the way `app.blobs.put` does: stage chunks, store
	 * the full blob, and store the manifest as its own content-addressed object.
	 * The returned reference carries a `manifestHash`, so a peer can pull the bytes
	 * knowing only the reference.
	 */
	async putBlob(
		bytes: Uint8Array,
		options?: { chunkSize?: number; mimeType?: string; filename?: string },
	): Promise<{ ref: BlobRef; manifest: BlobManifest }> {
		return putBlobForTransfer(this.blobStore, bytes, options)
	}

	/**
	 * Pull a blob's bytes over the live connection knowing only its reference: the
	 * manifest is resolved by `ref.manifestHash` first, then the chunks are fetched.
	 */
	async pullBlobByRef(ref: BlobRef): Promise<ReceiveBlobResult> {
		if (!this.blobChunkProvider) {
			throw new Error('Cannot pull a blob before the device has connected (call sync() first)')
		}
		const manifest = await resolveBlobManifest(this.blobChunkProvider, ref)
		return receiveBlob(manifest, this.blobChunkProvider, {
			chunkStore: this.blobStore,
			blobStore: this.blobStore,
		})
	}

	/**
	 * Pull a blob's bytes from peers over the live sync connection. Requests only
	 * the chunks this device is missing, reassembles them, and verifies integrity
	 * against the manifest's blob hash before storing the full blob locally.
	 */
	async pullBlob(manifest: BlobManifest): Promise<ReceiveBlobResult> {
		if (!this.blobChunkProvider) {
			throw new Error('Cannot pull a blob before the device has connected (call sync() first)')
		}
		return receiveBlob(manifest, this.blobChunkProvider, {
			chunkStore: this.blobStore,
			blobStore: this.blobStore,
		})
	}

	/** Read fully-assembled blob bytes from this device's store, or null if absent. */
	async getBlobBytes(hash: string): Promise<Uint8Array | null> {
		return this.blobStore.get(hash)
	}

	/**
	 * Get the device's version vector.
	 */
	getVersionVector(): VersionVector {
		return this.store.getVersionVector()
	}

	/**
	 * Check if the device is currently connected to the server.
	 */
	isConnected(): boolean {
		return this.currentTransport?.isConnected() ?? false
	}

	/**
	 * Close the device, releasing all resources.
	 */
	async close(): Promise<void> {
		this.closing = true
		if (this.unsubscribeAudit) {
			this.unsubscribeAudit()
			this.unsubscribeAudit = null
		}
		await this.disconnect()
		await this.store.close()
		this.emitter.clear()
	}

	/**
	 * Wait for in-flight sync operations to settle.
	 * In-memory transports are near-synchronous, but apply/relay work is async.
	 */
	private async waitForSettled(): Promise<void> {
		for (let i = 0; i < 15; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 20))
		}
	}

	/**
	 * Wait for all pending outbound operations to be acknowledged.
	 */
	private async waitForPendingOps(): Promise<void> {
		if (!this.syncEngine) return
		const maxWait = 2000
		const start = Date.now()
		while (Date.now() - start < maxWait) {
			const status = this.syncEngine.getStatus()
			if (status.pendingOperations === 0) return
			await new Promise<void>((resolve) => setTimeout(resolve, 10))
		}
	}
}
