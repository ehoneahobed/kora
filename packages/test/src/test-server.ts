import type { BlobRef, Operation, OperationTransform, SchemaDefinition } from '@korajs/core'
import { MemoryServerStore } from '@korajs/server'
import { KoraSyncServer } from '@korajs/server'
import type {
	KoraSyncServerConfig,
	OperationValidator,
	ServerStore,
	ServerTransport,
} from '@korajs/server'
import { type ContentAddressedBlobStore, createMemoryServerBlobStore } from '@korajs/store'

/**
 * In-memory test server wrapping KoraSyncServer with MemoryServerStore.
 * Handles client connections via memory transports.
 */
export interface TestServerOptions<S extends ServerStore = MemoryServerStore> {
	/**
	 * The server store (SQLite, Postgres, a memory store with options). Defaults to a
	 * fresh {@link MemoryServerStore}. Await {@link TestServer.ready} before use: the
	 * schema is set asynchronously.
	 */
	store?: S
	/** End-to-end encryption policy of the sync server (protocol v2). */
	encryption?: KoraSyncServerConfig['encryption']
	/** Handshake schema version advertised by the server. Defaults to `schema.version`. */
	schemaVersion?: number
	/** Inclusive client schema versions accepted at handshake. */
	supportedSchemaVersions?: { min: number; max: number }
	/** Transform accepted legacy operations into the server schema before validation. */
	operationTransforms?: OperationTransform[]
	/** Enable central blob storage: the server persists and serves uploaded blob bytes. */
	blobStorage?: boolean
	/** Adjudicate untrusted client operations before materialization. */
	validateOperation?: OperationValidator
}

export class TestServer<S extends ServerStore = MemoryServerStore> {
	readonly store: S
	/** Resolves once the store has the schema (needed before a SQL store is used). */
	readonly ready: Promise<void>
	/** The server's central blob store, present when `blobStorage` was enabled. */
	readonly blobStore: ContentAddressedBlobStore | null
	private readonly syncServer: KoraSyncServer

	constructor(schema: SchemaDefinition, options?: TestServerOptions<S>) {
		// Without a store option S is its default, MemoryServerStore.
		this.store = options?.store ?? (new MemoryServerStore() as ServerStore as S)
		const schemaVersion = options?.schemaVersion ?? schema.version
		const blob = options?.blobStorage ? createMemoryServerBlobStore() : null
		this.blobStore = blob?.store ?? null
		this.syncServer = new KoraSyncServer({
			store: this.store,
			schemaVersion,
			supportedSchemaVersions: options?.supportedSchemaVersions ?? {
				min: schemaVersion,
				max: schemaVersion,
			},
			...(options?.operationTransforms ? { operationTransforms: options.operationTransforms } : {}),
			...(blob ? blob.callbacks : {}),
			...(options?.validateOperation ? { validateOperation: options.validateOperation } : {}),
			...(options?.encryption ? { encryption: options.encryption } : {}),
		})
		this.ready = this.store.setSchema(schema)
		this.ready.catch(() => {})
	}

	/**
	 * Register a client connection transport with the server.
	 * Returns the session ID assigned by the server.
	 */
	handleConnection(transport: ServerTransport): string {
		return this.syncServer.handleConnection(transport)
	}

	/**
	 * Get all operations stored on the server.
	 */
	getAllOperations(): Operation[] {
		if (!(this.store instanceof MemoryServerStore)) {
			throw new Error(
				'TestServer.getAllOperations() reads the memory store synchronously; use store.getOperationsAfterDelivery() with a SQL store',
			)
		}
		return this.store.getAllOperations()
	}

	/** The trusted server-side write API (route context): writes authored by the server node. */
	getKoraContext(): ReturnType<KoraSyncServer['getKoraContext']> {
		return this.syncServer.getKoraContext()
	}

	/** The node ids the server's stores fold with and advertise in the handshake. */
	get authoritativeNodeIds(): string[] {
		return this.syncServer.authoritativeNodeIds
	}

	/**
	 * Get the number of connected clients.
	 */
	getConnectionCount(): number {
		return this.syncServer.getConnectionCount()
	}

	/**
	 * Retransmit relay batches connected clients have not acknowledged. Lets a test
	 * deterministically trigger the redelivery that the server also runs on a timer,
	 * without depending on wall-clock time. `staleMs` of 0 resends every pending relay.
	 */
	retransmitPendingRelays(staleMs = 0): void {
		this.syncServer.retransmitPendingRelays(staleMs)
	}

	/** Every blob reference still reachable from live records on the server. */
	getLiveBlobRefs(): Promise<BlobRef[]> {
		return this.syncServer.getLiveBlobRefs()
	}

	/**
	 * Shut down the server and close all sessions.
	 */
	async close(): Promise<void> {
		await this.syncServer.stop()
		await this.store.close()
	}
}
