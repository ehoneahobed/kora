import type { Operation } from '@kora/core'
import type {
	CollectionRecord,
	QueryDescriptor,
	Subscription,
	SubscriptionCallback,
} from '../types'

let nextSubId = 0

/**
 * Manages reactive subscriptions. When a mutation occurs on a collection,
 * affected subscriptions are re-evaluated in a microtask batch and callbacks
 * are invoked only if results actually changed.
 */
export class SubscriptionManager {
	private subscriptions = new Map<string, Subscription>()
	private pendingCollections = new Set<string>()
	private flushScheduled = false

	/**
	 * Register a new subscription.
	 *
	 * @param descriptor - The query descriptor defining what this subscription watches
	 * @param callback - Called with results whenever they change
	 * @param executeFn - Function to re-execute the query and get current results
	 * @returns An unsubscribe function
	 */
	register(
		descriptor: QueryDescriptor,
		callback: SubscriptionCallback<CollectionRecord>,
		executeFn: () => Promise<CollectionRecord[]>,
	): () => void {
		const id = `sub_${++nextSubId}`
		const subscription: Subscription = {
			id,
			descriptor,
			callback,
			executeFn,
			lastResults: [],
		}
		this.subscriptions.set(id, subscription)

		return () => {
			this.subscriptions.delete(id)
		}
	}

	/**
	 * Register a subscription and immediately execute the query.
	 * The initial results are stored as lastResults so subsequent flushes
	 * correctly diff against the initial state.
	 *
	 * @returns An unsubscribe function
	 */
	registerAndFetch(
		descriptor: QueryDescriptor,
		callback: SubscriptionCallback<CollectionRecord>,
		executeFn: () => Promise<CollectionRecord[]>,
	): () => void {
		const id = `sub_${++nextSubId}`
		const subscription: Subscription = {
			id,
			descriptor,
			callback,
			executeFn,
			lastResults: [],
		}
		this.subscriptions.set(id, subscription)

		// Execute immediately, set lastResults, and call callback
		executeFn().then((results) => {
			// Guard: subscription may have been removed before the async fetch completes
			if (this.subscriptions.has(id)) {
				subscription.lastResults = results
				callback(results)
			}
		})

		return () => {
			this.subscriptions.delete(id)
		}
	}

	/**
	 * Notify the manager that a mutation occurred on a collection.
	 * Schedules a microtask flush to batch multiple mutations in the same tick.
	 */
	notify(collection: string, _operation: Operation): void {
		this.pendingCollections.add(collection)
		this.scheduleFlush()
	}

	/**
	 * Immediately flush all pending notifications.
	 * Useful for testing. In production, flushing happens via microtask.
	 */
	async flush(): Promise<void> {
		if (this.pendingCollections.size === 0) return

		const collections = new Set(this.pendingCollections)
		this.pendingCollections.clear()
		this.flushScheduled = false

		// Find affected subscriptions
		const affected: Subscription[] = []
		for (const sub of this.subscriptions.values()) {
			if (collections.has(sub.descriptor.collection)) {
				affected.push(sub)
			}
		}

		// Re-execute and diff
		for (const sub of affected) {
			try {
				const newResults = await sub.executeFn()
				if (!this.resultsEqual(sub.lastResults, newResults)) {
					sub.lastResults = newResults
					sub.callback(newResults)
				}
			} catch {
				// Subscription re-execution failed — skip silently for now.
				// In future, we could emit an error event for DevTools.
			}
		}
	}

	/**
	 * Remove all subscriptions. Called on store close.
	 */
	clear(): void {
		this.subscriptions.clear()
		this.pendingCollections.clear()
		this.flushScheduled = false
	}

	/** Number of active subscriptions (for testing/debugging) */
	get size(): number {
		return this.subscriptions.size
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return
		this.flushScheduled = true
		queueMicrotask(() => {
			this.flush()
		})
	}

	/**
	 * Compare two result sets. Uses length check + JSON comparison as pragmatic approach.
	 * Sufficient for typical query results. Can be optimized to id-based diffing if profiling shows need.
	 */
	private resultsEqual(prev: CollectionRecord[], next: CollectionRecord[]): boolean {
		if (prev.length !== next.length) return false
		// Fast path: both empty
		if (prev.length === 0) return true
		return JSON.stringify(prev) === JSON.stringify(next)
	}
}
