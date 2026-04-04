import type { QueryBuilder } from '@kora/store'
import { QueryStore } from './query-store'

interface CacheEntry {
	queryStore: QueryStore
	refCount: number
}

/**
 * Caches QueryStore instances by their QueryDescriptor, with reference counting.
 * Ensures that identical queries from different components share the same subscription.
 */
export class QueryStoreCache {
	private entries = new Map<string, CacheEntry>()

	/**
	 * Get or create a QueryStore for the given QueryBuilder.
	 * Increments the reference count if already cached.
	 */
	getOrCreate(queryBuilder: QueryBuilder): QueryStore {
		const key = this.getKey(queryBuilder)
		const existing = this.entries.get(key)

		if (existing) {
			existing.refCount++
			return existing.queryStore
		}

		const queryStore = new QueryStore(queryBuilder)
		this.entries.set(key, { queryStore, refCount: 1 })
		return queryStore
	}

	/**
	 * Release a reference to the QueryStore for the given QueryBuilder.
	 * Destroys the QueryStore when the reference count reaches zero.
	 */
	release(queryBuilder: QueryBuilder): void {
		const key = this.getKey(queryBuilder)
		const entry = this.entries.get(key)

		if (!entry) return

		entry.refCount--
		if (entry.refCount <= 0) {
			entry.queryStore.destroy()
			this.entries.delete(key)
		}
	}

	/**
	 * Destroy all cached QueryStore instances and clear the cache.
	 */
	clear(): void {
		for (const entry of this.entries.values()) {
			entry.queryStore.destroy()
		}
		this.entries.clear()
	}

	/**
	 * Number of unique QueryStore instances currently cached.
	 */
	get size(): number {
		return this.entries.size
	}

	private getKey(queryBuilder: QueryBuilder): string {
		return JSON.stringify(queryBuilder.getDescriptor())
	}
}
