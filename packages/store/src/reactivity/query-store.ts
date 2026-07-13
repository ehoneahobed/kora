import type { CollectionRecord } from '../types'
import type { QueryBuilder } from '../query/query-builder'

/**
 * Frozen empty array returned as the initial snapshot before any data loads.
 * Same reference every time prevents infinite update loops in UI bindings.
 */
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/**
 * Bridges the async QueryBuilder.subscribe() API with synchronous snapshot reads
 * required by React useSyncExternalStore, Vue composables, and Svelte stores.
 *
 * Uses lazy subscription: the underlying query subscription starts when the first
 * listener attaches and stops when the last listener detaches.
 */
export class QueryStore<T = CollectionRecord> {
	private snapshot: readonly T[] = EMPTY_ARRAY as readonly T[]
	private listeners = new Set<() => void>()
	private unsubscribeQuery: (() => void) | null = null
	private active = false
	private readonly queryBuilder: QueryBuilder<T>

	constructor(queryBuilder: QueryBuilder<T>) {
		this.queryBuilder = queryBuilder
	}

	/**
	 * Subscribe to snapshot changes.
	 *
	 * @returns Unsubscribe function
	 */
	subscribe = (onStoreChange: () => void): (() => void) => {
		this.listeners.add(onStoreChange)

		if (!this.active) {
			this.startSubscription()
		}

		return () => {
			this.listeners.delete(onStoreChange)
			if (this.listeners.size === 0) {
				this.stopSubscription()
			}
		}
	}

	/** Synchronous read of the latest query results. */
	getSnapshot = (): readonly T[] => {
		return this.snapshot
	}

	/** Tear down listeners and the underlying query subscription. */
	destroy(): void {
		this.stopSubscription()
		this.listeners.clear()
		this.snapshot = EMPTY_ARRAY as readonly T[]
	}

	private startSubscription(): void {
		this.active = true
		this.unsubscribeQuery = this.queryBuilder.subscribe((results: readonly T[]) => {
			if (!this.active) return
			this.snapshot = Object.freeze([...results])
			this.notifyListeners()
		})
	}

	private stopSubscription(): void {
		this.active = false
		if (this.unsubscribeQuery) {
			this.unsubscribeQuery()
			this.unsubscribeQuery = null
		}
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			listener()
		}
	}
}
