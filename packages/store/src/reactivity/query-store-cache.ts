import type { CollectionRecord } from '../types'
import type { QueryBuilder } from '../query/query-builder'
import { QueryStore } from './query-store'

interface CacheEntry {
	queryStore: QueryStore<CollectionRecord>
	refCount: number
}

/**
 * Reference-counted cache of {@link QueryStore} instances keyed by query descriptor.
 * Identical queries from different components share one underlying subscription.
 */
export class QueryStoreCache {
	private entries = new Map<string, CacheEntry>()

	constructor(private readonly scopeKey = 'default') {}

	getOrCreate<T>(queryBuilder: QueryBuilder<T>): QueryStore<T> {
		const key = this.getKey(queryBuilder)
		const existing = this.entries.get(key)

		if (existing) {
			existing.refCount++
			return existing.queryStore as QueryStore<T>
		}

		const queryStore = new QueryStore<T>(queryBuilder)
		this.entries.set(key, {
			queryStore: queryStore as QueryStore<CollectionRecord>,
			refCount: 1,
		})
		return queryStore
	}

	release(queryBuilder: QueryBuilder<unknown>): void {
		const key = this.getKey(queryBuilder)
		const entry = this.entries.get(key)
		if (!entry) {
			return
		}

		entry.refCount--
		if (entry.refCount <= 0) {
			entry.queryStore.destroy()
			this.entries.delete(key)
		}
	}

	clear(): void {
		for (const entry of this.entries.values()) {
			entry.queryStore.destroy()
		}
		this.entries.clear()
	}

	get size(): number {
		return this.entries.size
	}

	private getKey(queryBuilder: QueryBuilder<unknown>): string {
		return `${this.scopeKey}:${JSON.stringify(queryBuilder.getDescriptor())}`
	}
}

let sharedCache: QueryStoreCache | null = null

/**
 * Process-wide shared query store cache for framework bindings.
 *
 * @deprecated Prefer {@link KoraApp.getQueryStoreCache} via `KoraProvider` context
 * so each app instance owns an isolated cache.
 */
export function getSharedQueryStoreCache(): QueryStoreCache {
	if (!sharedCache) {
		sharedCache = new QueryStoreCache()
	}
	return sharedCache
}
