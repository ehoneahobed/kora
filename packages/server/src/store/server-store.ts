import type { SyncStore } from '@korajs/sync'

/**
 * A materialized record reconstructed from the operation log.
 */
export interface MaterializedRecord {
	id: string
	[key: string]: unknown
}

/**
 * Server-side store interface. Extends SyncStore with lifecycle
 * and introspection methods needed by the sync server.
 */
export interface ServerStore extends SyncStore {
	/** Close the store and release resources */
	close(): Promise<void>

	/** Get the total number of stored operations */
	getOperationCount(): Promise<number>

	/**
	 * Reconstruct current records for a collection by replaying the operation log.
	 * Returns an array of materialized records with their current field values.
	 * Deleted records are excluded.
	 *
	 * @param collection - The collection name to materialize
	 * @returns Array of records with their current state
	 */
	materializeCollection(collection: string): Promise<MaterializedRecord[]>
}
