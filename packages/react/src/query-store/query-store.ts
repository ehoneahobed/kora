import type { CollectionRecord, QueryBuilder } from '@kora/store'

/**
 * Frozen empty array returned as the initial snapshot before any data loads.
 * Same reference every time prevents infinite re-render loops with useSyncExternalStore.
 */
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/**
 * Bridges the async QueryBuilder.subscribe() API with the synchronous
 * getSnapshot() required by React's useSyncExternalStore.
 *
 * Starts the underlying subscription eagerly on construction, so that
 * the snapshot is populated by the time useSyncExternalStore reads it.
 *
 * Generic parameter `T` defaults to `CollectionRecord` for backward compatibility.
 */
export class QueryStore<T = CollectionRecord> {
	private snapshot: readonly T[] = EMPTY_ARRAY as readonly T[]
	private listeners = new Set<() => void>()
	private unsubscribeQuery: (() => void) | null = null
	private destroyed = false

	constructor(queryBuilder: QueryBuilder<T>) {
		// Start subscription eagerly so snapshot is populated before first getSnapshot() call
		this.unsubscribeQuery = queryBuilder.subscribe((results) => {
			if (this.destroyed) return

			const newSnapshot = Object.freeze([...results])
			this.snapshot = newSnapshot
			this.notifyListeners()
		})
	}

	/**
	 * Subscribe to snapshot changes. Compatible with useSyncExternalStore.
	 *
	 * @returns Unsubscribe function
	 */
	subscribe = (onStoreChange: () => void): (() => void) => {
		this.listeners.add(onStoreChange)

		return () => {
			this.listeners.delete(onStoreChange)
		}
	}

	/**
	 * Get the current snapshot synchronously. Compatible with useSyncExternalStore.
	 * Returns EMPTY_ARRAY before the first async fetch completes.
	 */
	getSnapshot = (): readonly T[] => {
		return this.snapshot
	}

	/**
	 * Clean up the underlying subscription and release resources.
	 */
	destroy(): void {
		this.destroyed = true
		if (this.unsubscribeQuery) {
			this.unsubscribeQuery()
			this.unsubscribeQuery = null
		}
		this.listeners.clear()
		this.snapshot = EMPTY_ARRAY as readonly T[]
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			listener()
		}
	}
}
