import type { BlobRef, Operation, SchemaDefinition } from '@korajs/core'
import { MemoryServerStore } from '@korajs/server'
import { KoraSyncServer } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { type ContentAddressedBlobStore, createMemoryServerBlobStore } from '@korajs/store'

/**
 * In-memory test server wrapping KoraSyncServer with MemoryServerStore.
 * Handles client connections via memory transports.
 */
export interface TestServerOptions {
	/** Handshake schema version advertised by the server. Defaults to `schema.version`. */
	schemaVersion?: number
	/** Inclusive client schema versions accepted at handshake. */
	supportedSchemaVersions?: { min: number; max: number }
	/** Enable central blob storage: the server persists and serves uploaded blob bytes. */
	blobStorage?: boolean
}

export class TestServer {
	readonly store: MemoryServerStore
	/** The server's central blob store, present when `blobStorage` was enabled. */
	readonly blobStore: ContentAddressedBlobStore | null
	private readonly syncServer: KoraSyncServer

	constructor(schema: SchemaDefinition, options?: TestServerOptions) {
		this.store = new MemoryServerStore()
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
			...(blob ? blob.callbacks : {}),
		})
		void this.store.setSchema(schema)
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
		return this.store.getAllOperations()
	}

	/**
	 * Get the number of connected clients.
	 */
	getConnectionCount(): number {
		return this.syncServer.getConnectionCount()
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
