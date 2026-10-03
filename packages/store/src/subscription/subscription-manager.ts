import type { Operation } from '@korajs/core'
import { QueryError } from '../errors'
import type {
	CollectionRecord,
	QueryDescriptor,
	QueryErrorPhase,
	QuerySubscriptionError,
	SubscribeOptions,
	Subscription,
	SubscriptionCallback,
} from '../types'
import { SubscriptionBloomFilter } from './bloom-filter'
import { type ResultsEqual, defaultResultsEqual } from './result-equality'

/**
 * Per-subscription options accepted by `register` / `registerAndFetch`.
 */
export interface RegisterOptions extends SubscribeOptions {
	/** Result-set comparator; defaults to structural comparison of every value. */
	resultsEqual?: ResultsEqual
}

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

	/** Called when a query subscription is registered (e.g. to register sync query subsets). */
	onQuerySubscribed?: (descriptor: QueryDescriptor) => () => void

	/**
	 * Called for every subscription failure (the store emits `query:error`), in
	 * addition to the subscriber's own `onError`.
	 */
	onQueryError?: (failure: QuerySubscriptionError) => void
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
	private readonly onQuerySubscribed?: (descriptor: QueryDescriptor) => () => void
	private readonly onQueryError?: (failure: QuerySubscriptionError) => void

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
		this.onQuerySubscribed = options?.onQuerySubscribed
		this.onQueryError = options?.onQueryError
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
		options?: RegisterOptions,
	): () => void {
		// No initial run: the empty baseline counts as delivered, so a flush only
		// notifies when the results differ from it.
		const subscription = this.createSubscription(descriptor, callback, executeFn, options)
		subscription.delivered = true
		return this.track(subscription)
	}

	/**
	 * Register a subscription and immediately execute the query.
	 * The initial results are stored as lastResults so subsequent flushes
	 * correctly diff against the initial state. A failing initial run is reported
	 * through `options.onError` and the `query:error` hook, never as an unhandled
	 * rejection (STORE-12).
	 *
	 * @returns An unsubscribe function
	 */
	registerAndFetch(
		descriptor: QueryDescriptor,
		callback: SubscriptionCallback<CollectionRecord>,
		executeFn: () => Promise<CollectionRecord[]>,
		options?: RegisterOptions,
	): () => void {
		const subscription = this.createSubscription(descriptor, callback, executeFn, options)
		const unsubscribe = this.track(subscription)
		void this.run(subscription)
		return unsubscribe
	}

	private createSubscription(
		descriptor: QueryDescriptor,
		callback: SubscriptionCallback<CollectionRecord>,
		executeFn: () => Promise<CollectionRecord[]>,
		options: RegisterOptions | undefined,
	): Subscription {
		return {
			id: `sub_${++nextSubId}`,
			descriptor,
			callback,
			executeFn,
			lastResults: [],
			resultsEqual: options?.resultsEqual ?? defaultResultsEqual,
			onError: options?.onError,
			runsStarted: 0,
			lastAppliedRun: 0,
			errored: false,
			delivered: false,
		}
	}

	private track(subscription: Subscription): () => void {
		const id = subscription.id
		this.subscriptions.set(id, subscription)

		// Mark bloom filter as needing rebuild since dependencies changed
		this.bloomDirty = true

		const externalCleanup = this.onQuerySubscribed?.(subscription.descriptor)

		return () => {
			if (!this.subscriptions.delete(id)) return
			this.bloomDirty = true
			externalCleanup?.()
		}
	}

	/**
	 * Run a subscription's query and deliver the result when it changed. Never
	 * throws: failures go to the error channel. Runs are numbered so a slow,
	 * older run never overwrites the result of a newer one.
	 */
	private async run(sub: Subscription): Promise<void> {
		const runNumber = (sub.runsStarted ?? 0) + 1
		sub.runsStarted = runNumber
		let results: CollectionRecord[]
		try {
			results = await sub.executeFn()
		} catch (error) {
			if (!this.isCurrent(sub, runNumber)) return
			sub.lastAppliedRun = runNumber
			sub.errored = true
			this.reportError(sub, error, sub.delivered ? 'refresh' : 'initial')
			return
		}
		if (!this.isCurrent(sub, runNumber)) return
		sub.lastAppliedRun = runNumber

		// After a failure, the next success is always delivered (even when equal to
		// the last results) so bindings can leave their error state.
		const equal = sub.resultsEqual ?? defaultResultsEqual
		if (sub.delivered && !sub.errored && equal(sub.lastResults, results)) return

		sub.lastResults = results
		sub.delivered = true
		sub.errored = false
		try {
			sub.callback(results)
		} catch (error) {
			this.reportError(sub, error, 'callback')
		}
	}

	private isCurrent(sub: Subscription, runNumber: number): boolean {
		return this.subscriptions.get(sub.id) === sub && runNumber > (sub.lastAppliedRun ?? 0)
	}

	private reportError(sub: Subscription, thrown: unknown, phase: QueryErrorPhase): void {
		const error =
			thrown instanceof Error
				? thrown
				: new QueryError(`Query subscription failed: ${String(thrown)}`, {
						collection: sub.descriptor.collection,
					})
		const failure: QuerySubscriptionError = {
			error,
			phase,
			collection: sub.descriptor.collection,
			queryId: sub.id,
		}
		try {
			this.onQueryError?.(failure)
		} catch (hookError) {
			console.error('[kora] query:error listener threw', hookError)
		}
		if (sub.onError) {
			try {
				sub.onError(failure)
			} catch (handlerError) {
				console.error('[kora] subscription onError handler threw', handlerError)
			}
			return
		}
		// No subscriber handler: log so the failure is never silent.
		console.error(
			`[kora] Query subscription ${sub.id} on "${sub.descriptor.collection}" failed (${phase}). Pass subscribe(cb, { onError }) to handle it.`,
			error,
		)
	}

	/**
	 * Notify the manager that a mutation occurred on a collection.
	 * Schedules a microtask flush to batch multiple mutations in the same tick.
	 */
	notify(collection: string, _operation: Operation): void {
		this.invalidate(collection)
	}

	/** Invalidate a collection after a local-view change that has no domain operation. */
	invalidate(collection: string): void {
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

		// Re-execute and diff. run() never throws: failures reach the error channel.
		for (const sub of affected) {
			await this.run(sub)
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
			averageCheckTimeMs: this.totalChecks > 0 ? this.totalCheckTimeMs / this.totalChecks : 0,
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
		const filter = new SubscriptionBloomFilter(this.bloomExpectedItems, this.bloomFalsePositiveRate)

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
			// flush() cannot reject: run() routes every failure to the error channel.
			void this.flush()
		})
	}
}
