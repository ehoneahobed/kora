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
import { SyncEngine } from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
	createSyncEngineChunkPort,
	wireAuditPersistence,
	wireBlobUpload,
} from 'korajs/testing'
import type { TestServer } from './test-server'

/**
 * Options for creating a TestDevice.
 */
export interface TestDeviceOptions {
	/** Unique device name (used for DB file naming) */
	name: string
	/** Schema definition */
	schema: SchemaDefinition
	/** Test server to connect to */
	server: TestServer
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
	private readonly server: TestServer
	private readonly mergeEngine: MergeEngine
	private readonly createTransportPair: TestDeviceOptions['createTransportPair']
	private readonly adapter: StorageAdapter
	private readonly dbPath: string
	private readonly syncSchemaVersion: number
	private readonly operationTransforms: OperationTransform[]

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

		this.emitter = new SimpleEventEmitter()
		this.mergeEngine = new MergeEngine()
		this.adapter = new BetterSqlite3Adapter(this.dbPath)
		this.store = new Store({
			schema: options.schema,
			adapter: this.adapter,
			emitter: this.emitter,
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
		const { client, serverTransport } = this.createTransportPair()
		this.currentTransport = client

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
			},
			emitter: this.emitter,
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
