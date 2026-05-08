import type { SchemaDefinition } from '@korajs/core'
import type { SyncStore } from '@korajs/sync'

/**
 * A materialized record reconstructed from the operation log
 * or read from a materialized collection table.
 */
export interface MaterializedRecord {
	id: string
	[key: string]: unknown
}

/**
 * Options for querying a materialized collection table.
 */
export interface CollectionQueryOptions {
	/** Exact-match filters on field values */
	where?: Record<string, unknown>
	/** Field name to order results by */
	orderBy?: string
	/** Sort direction (default: 'asc') */
	orderDirection?: 'asc' | 'desc'
	/** Maximum number of records to return */
	limit?: number
	/** Number of records to skip (for pagination) */
	offset?: number
	/** Include soft-deleted records (default: false) */
	includeDeleted?: boolean
}

/**
 * Server-side store interface. Extends SyncStore with lifecycle,
 * introspection, and materialization methods needed by the sync server.
 */
export interface ServerStore extends SyncStore {
	/** Close the store and release resources */
	close(): Promise<void>

	/** Get the total number of stored operations */
	getOperationCount(): Promise<number>

	/**
	 * Set the schema for materialized collection tables.
	 * Creates collection tables and indexes based on the schema definition.
	 * If operations already exist in the store, backfills the materialized
	 * tables from the operation log.
	 *
	 * @param schema - The schema definition describing all collections
	 */
	setSchema(schema: SchemaDefinition): Promise<void>

	/**
	 * Get all records from a materialized collection.
	 * When schema is set, reads directly from the collection table (O(1) indexed).
	 * When schema is not set, falls back to replaying the operation log.
	 * Deleted records are excluded.
	 *
	 * @param collection - The collection name to query
	 * @returns Array of records with their current state
	 */
	materializeCollection(collection: string): Promise<MaterializedRecord[]>

	/**
	 * Query records from a materialized collection with filtering, ordering,
	 * and pagination. Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name to query
	 * @param options - Query options (where, orderBy, limit, offset)
	 * @returns Array of matching records
	 */
	queryCollection(
		collection: string,
		options?: CollectionQueryOptions,
	): Promise<MaterializedRecord[]>

	/**
	 * Find a single record by ID from a materialized collection.
	 * Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name
	 * @param id - The record ID
	 * @returns The record or null if not found (or deleted)
	 */
	findRecord(collection: string, id: string): Promise<MaterializedRecord | null>

	/**
	 * Count records in a materialized collection, optionally filtered.
	 * Requires schema to be set via setSchema().
	 *
	 * @param collection - The collection name
	 * @param where - Optional exact-match filters
	 * @returns Number of matching records
	 */
	countCollection(collection: string, where?: Record<string, unknown>): Promise<number>
}
