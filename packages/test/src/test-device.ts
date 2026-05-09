import type { Operation, SchemaDefinition, VersionVector } from '@korajs/core'
import type { KoraEventEmitter } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import type { CollectionAccessor, StorageAdapter } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEngine } from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
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

	private readonly schema: SchemaDefinition
	private readonly server: TestServer
	private readonly mergeEngine: MergeEngine
	private readonly createTransportPair: TestDeviceOptions['createTransportPair']
	private readonly adapter: StorageAdapter
	private readonly dbPath: string

	private syncEngine: SyncEngine | null = null
	private currentTransport: SyncTransport | null = null
	private unsubscribeSync: (() => void) | null = null
	private closing = false

	constructor(options: TestDeviceOptions) {
		this.name = options.name
		this.schema = options.schema
		this.server = options.server
		this.createTransportPair = options.createTransportPair
		this.dbPath = `${options.tmpDir}/test-device-${options.name}.db`

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
	}

	/**
	 * Connect to the test server and perform initial sync.
	 * If already connected, flushes any pending operations.
	 */
	async sync(): Promise<void> {
		if (this.syncEngine && this.currentTransport?.isConnected()) {
			// Already connected — wait for pending operations to flush
			await this.waitForPendingOps()
			return
		}

		// Create a new transport pair and connect
		const { client, serverTransport } = this.createTransportPair()
		this.currentTransport = client

		// Create a MergeAwareSyncStore wrapper
		const syncStore = this.createMergeAwareSyncStore()

		this.syncEngine = new SyncEngine({
			transport: client,
			store: syncStore,
			config: { url: 'ws://test-network' },
			emitter: this.emitter,
		})

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
		await this.disconnect()
		await this.store.close()
		this.emitter.clear()
	}

	/**
	 * Create a SyncStore wrapper that interposes merge resolution.
	 * Simplified version of MergeAwareSyncStore from the kora meta-package.
	 */
	private createMergeAwareSyncStore(): import('@korajs/sync').SyncStore {
		const store = this.store
		const mergeEngine = this.mergeEngine
		const emitter = this.emitter

		return {
			getVersionVector(): VersionVector {
				return store.getVersionVector()
			},
			getNodeId(): string {
				return store.getNodeId()
			},
			async getOperationRange(
				nodeId: string,
				fromSeq: number,
				toSeq: number,
			): Promise<Operation[]> {
				return store.getOperationRange(nodeId, fromSeq, toSeq)
			},
			async applyRemoteOperation(op: Operation): Promise<import('@korajs/sync').ApplyResult> {
				// For the test harness, delegate directly to store.
				// Merge resolution happens inside the store's applyRemoteOperation.
				return store.applyRemoteOperation(op)
			},
		}
	}

	/**
	 * Wait for in-flight sync operations to settle.
	 * In-memory transports are near-synchronous, so a microtask flush suffices.
	 */
	private async waitForSettled(): Promise<void> {
		// Multiple microtask flushes to allow async message processing to complete
		for (let i = 0; i < 5; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 10))
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
