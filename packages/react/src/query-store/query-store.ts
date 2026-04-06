import type { CollectionRecord, QueryBuilder } from '@korajs/store'

/**
 * Frozen empty array returned as the initial snapshot before any data loads.
 * Same reference every time prevents infinite re-render loops with useSyncExternalStore.
 */
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

/**
 * Bridges the async QueryBuilder.subscribe() API with the synchronous
 * getSnapshot() required by React's useSyncExternalStore.
 *
 * Uses a lazy subscription model: the underlying query subscription starts
 * when the first listener attaches (via useSyncExternalStore's subscribe)
 * and stops when the last listener detaches. This makes QueryStore resilient
 * to React StrictMode's double-mount cycle, where useEffect cleanup fires
 * between mount and remount.
 *
 * Generic parameter `T` defaults to `CollectionRecord` for backward compatibility.
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
	 * Subscribe to snapshot changes. Compatible with useSyncExternalStore.
	 *
	 * Lazily starts the underlying query subscription when the first listener
	 * attaches, and stops it when the last listener detaches. This allows
	 * React StrictMode to unmount/remount without permanently killing the subscription.
	 *
	 * @returns Unsubscribe function
	 */
	subscribe = (onStoreChange: () => void): (() => void) => {
		this.listeners.add(onStoreChange)

		// Start the underlying query subscription when the first listener attaches
		if (!this.active) {
			this.startSubscription()
		}

		return () => {
			this.listeners.delete(onStoreChange)
			// Stop the underlying subscription when the last listener detaches.
			// This ensures cleanup on unmount without needing a useEffect.
			if (this.listeners.size === 0) {
				this.stopSubscription()
			}
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
	 * Called by useMemo when the query descriptor changes.
	 */
	destroy(): void {
		this.stopSubscription()
		this.listeners.clear()
		this.snapshot = EMPTY_ARRAY as readonly T[]
	}

	private startSubscription(): void {
		this.active = true
		this.unsubscribeQuery = this.queryBuilder.subscribe((results) => {
			if (!this.active) return
			const newSnapshot = Object.freeze([...results])
			this.snapshot = newSnapshot
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
