import type { Operation, SchemaDefinition } from '@korajs/core'
import { MemoryServerStore } from '@korajs/server'
import { KoraSyncServer } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'

/**
 * In-memory test server wrapping KoraSyncServer with MemoryServerStore.
 * Handles client connections via memory transports.
 */
export class TestServer {
	readonly store: MemoryServerStore
	private readonly syncServer: KoraSyncServer

	constructor(schema: SchemaDefinition) {
		this.store = new MemoryServerStore()
		this.syncServer = new KoraSyncServer({
			store: this.store,
			schemaVersion: schema.version,
		})
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

	/**
	 * Shut down the server and close all sessions.
	 */
	async close(): Promise<void> {
		await this.syncServer.stop()
		await this.store.close()
	}
}
