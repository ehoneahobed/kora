import type { Operation } from '@korajs/core'
import type {
	CollectionRecord,
	QueryDescriptor,
	Subscription,
	SubscriptionCallback,
} from '../types'
import { SubscriptionBloomFilter } from './bloom-filter'

let nextSubId = 0

/**
 * Default threshold for activating bloom filter-based dependency tracking.
 * Below this count, linear scanning is faster due to bloom filter rebuild overhead.
 */
const DEFAULT_BLOOM_THRESHOLD = 100

/**
 * Default expected items for bloom filter sizing.
 * Sized to handle typical subscription dependency counts with headroom.
 */
const DEFAULT_BLOOM_EXPECTED_ITEMS = 500

/**
 * Default false positive rate for bloom filter.
 * 1% provides a good balance between filter size and accuracy.
 */
const DEFAULT_BLOOM_FALSE_POSITIVE_RATE = 0.01

/**
 * Configuration options for the SubscriptionManager.
 */
export interface SubscriptionManagerOptions {
	/**
	 * Minimum number of subscriptions before activating bloom filter.
	 * Below this threshold, linear scanning is used (bloom filter overhead not worth it).
	 * @default 100
	 */
	bloomThreshold?: number

	/**
	 * Expected number of unique collection+field dependencies for bloom filter sizing.
	 * @default 500
	 */
	bloomExpectedItems?: number

	/**
	 * Target false positive rate for the bloom filter.
	 * Lower values require more memory but reduce unnecessary precise checks.
	 * @default 0.01
	 */
	bloomFalsePositiveRate?: number
}

/**
 * Performance statistics for monitoring subscription checking efficiency.
 */
export interface SubscriptionStats {
	/** Total number of mutation notifications processed */
	totalChecks: number
	/** Number of times bloom filter said "maybe" (proceeded to precise check) */
	bloomFilterHits: number
	/** Number of times bloom filter said "definitely not" (skipped all subscriptions) */
	bloomFilterMisses: number
	/** Number of times bloom filter said "maybe" but precise check found no match */
	falsePositives: number
	/** Average time per check in milliseconds */
	averageCheckTimeMs: number
	/** Whether bloom filter is currently active */
	bloomFilterActive: boolean
	/** Current subscription count */
	subscriptionCount: number
}

/**
 * Manages reactive subscriptions with two-level dependency checking.
 *
 * When a mutation occurs on a collection, affected subscriptions are re-evaluated
 * in a microtask batch and callbacks are invoked only if results actually changed.
 *
 * For large subscription counts (>= bloomThreshold), a bloom filter provides O(k)
 * pre-filtering to avoid scanning all subscriptions on every mutation:
 *
 * Level 1 (Bloom filter): Fast O(k) check -- does this mutation potentially affect
 * any subscription? If NO: skip all subscriptions (guaranteed correct).
 * If MAYBE: proceed to Level 2.
 *
 * Level 2 (Precise check): Only evaluate subscriptions that match the mutated
 * collection, including included (related) collection tracking.
 */
export class SubscriptionManager {
	private subscriptions = new Map<string, Subscription>()
	private pendingCollections = new Set<string>()
	private flushScheduled = false

	// Bloom filter state
	private bloomFilter: SubscriptionBloomFilter | null = null
	private bloomDirty = false
	private readonly bloomThreshold: number
	private readonly bloomExpectedItems: number
	private readonly bloomFalsePositiveRate: number

	// Performance stats
	private totalChecks = 0
	private bloomFilterHits = 0
	private bloomFilterMisses = 0
	private falsePositives = 0
	private totalCheckTimeMs = 0

	constructor(options?: SubscriptionManagerOptions) {
		this.bloomThreshold = options?.bloomThreshold ?? DEFAULT_BLOOM_THRESHOLD
		this.bloomExpectedItems = options?.bloomExpectedItems ?? DEFAULT_BLOOM_EXPECTED_ITEMS
		this.bloomFalsePositiveRate =
			options?.bloomFalsePositiveRate ?? DEFAULT_BLOOM_FALSE_POSITIVE_RATE
	}

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

		// Mark bloom filter as needing rebuild since dependencies changed
		this.bloomDirty = true

		return () => {
			this.subscriptions.delete(id)
			this.bloomDirty = true
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

		// Mark bloom filter as needing rebuild since dependencies changed
		this.bloomDirty = true

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
			this.bloomDirty = true
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

		const affected = this.findAffectedSubscriptions(collections)

		// Re-execute and diff
		for (const sub of affected) {
			try {
				const newResults = await sub.executeFn()
				if (!this.resultsEqual(sub.lastResults, newResults)) {
					sub.lastResults = newResults
					sub.callback(newResults)
				}
			} catch {
				// Subscription re-execution failed -- skip silently for now.
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
		this.bloomFilter = null
		this.bloomDirty = false
		this.totalChecks = 0
		this.bloomFilterHits = 0
		this.bloomFilterMisses = 0
		this.falsePositives = 0
		this.totalCheckTimeMs = 0
	}

	/** Number of active subscriptions (for testing/debugging) */
	get size(): number {
		return this.subscriptions.size
	}

	/**
	 * Get performance statistics for monitoring subscription checking efficiency.
	 * Useful for DevTools integration and performance tuning.
	 */
	getStats(): SubscriptionStats {
		return {
			totalChecks: this.totalChecks,
			bloomFilterHits: this.bloomFilterHits,
			bloomFilterMisses: this.bloomFilterMisses,
			falsePositives: this.falsePositives,
			averageCheckTimeMs:
				this.totalChecks > 0 ? this.totalCheckTimeMs / this.totalChecks : 0,
			bloomFilterActive: this.isBloomActive(),
			subscriptionCount: this.subscriptions.size,
		}
	}

	/**
	 * Check if bloom filter is currently active.
	 * Active when subscription count meets or exceeds the threshold.
	 */
	isBloomActive(): boolean {
		return this.subscriptions.size >= this.bloomThreshold
	}

	/**
	 * Find subscriptions affected by mutations to the given collections.
	 * Uses two-level checking when bloom filter is active:
	 *
	 * Level 1: Bloom filter pre-check -- if no subscription depends on any
	 * of the mutated collections, skip everything (O(k) per collection).
	 *
	 * Level 2: Precise check -- linear scan of subscriptions, matching
	 * against the mutated collections.
	 */
	private findAffectedSubscriptions(collections: Set<string>): Subscription[] {
		const startTime = performance.now()
		this.totalChecks++

		const useBloom = this.isBloomActive()

		if (useBloom) {
			// Rebuild bloom filter if dependencies have changed
			if (this.bloomDirty || this.bloomFilter === null) {
				this.rebuildBloomFilter()
			}

			const filter = this.bloomFilter
			if (filter !== null) {
				// Level 1: Bloom filter pre-check
				let anyPossibleMatch = false
				for (const col of collections) {
					if (filter.mightContain(col)) {
						anyPossibleMatch = true
						break
					}
				}

				if (!anyPossibleMatch) {
					// Bloom filter guarantees no subscription depends on these collections
					this.bloomFilterMisses++
					this.totalCheckTimeMs += performance.now() - startTime
					return []
				}

				this.bloomFilterHits++
			}
		}

		// Level 2: Precise check (or only check when bloom is not active)
		const affected: Subscription[] = []
		let anyPreciseMatch = false

		for (const sub of this.subscriptions.values()) {
			if (collections.has(sub.descriptor.collection)) {
				affected.push(sub)
				anyPreciseMatch = true
			} else if (sub.descriptor.includeCollections) {
				// Re-evaluate if a mutation affects an included (related) collection
				for (const incCol of sub.descriptor.includeCollections) {
					if (collections.has(incCol)) {
						affected.push(sub)
						anyPreciseMatch = true
						break
					}
				}
			}
		}

		// Track false positives: bloom said "maybe" but precise check found nothing
		if (useBloom && !anyPreciseMatch) {
			this.falsePositives++
		}

		this.totalCheckTimeMs += performance.now() - startTime
		return affected
	}

	/**
	 * Rebuild the bloom filter from all current subscriptions.
	 * Adds collection-level dependencies for every subscription, plus
	 * any included collection dependencies.
	 */
	private rebuildBloomFilter(): void {
		const filter = new SubscriptionBloomFilter(
			this.bloomExpectedItems,
			this.bloomFalsePositiveRate,
		)

		for (const sub of this.subscriptions.values()) {
			// Add the primary collection dependency
			filter.add(sub.descriptor.collection)

			// Add included (related) collection dependencies
			if (sub.descriptor.includeCollections) {
				for (const incCol of sub.descriptor.includeCollections) {
					filter.add(incCol)
				}
			}
		}

		this.bloomFilter = filter
		this.bloomDirty = false
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
