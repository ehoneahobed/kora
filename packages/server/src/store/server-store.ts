import type { SyncStore } from '@kora/sync'

/**
 * Server-side store interface. Extends SyncStore with lifecycle
 * and introspection methods needed by the sync server.
 */
export interface ServerStore extends SyncStore {
	/** Close the store and release resources */
	close(): Promise<void>

	/** Get the total number of stored operations */
	getOperationCount(): Promise<number>
}
