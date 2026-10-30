import type { CollectionDefinition, Operation } from '@korajs/core'
import { QueryError } from '../errors'
import { activePhaseTimers } from '../instrumentation/phase-timers'
import { applyOverlayReport } from '../overlay/apply'
import type { PendingEntry, PendingWrites, RegistryChange } from '../overlay/pending-writes'
import { isPatchable } from '../overlay/query-eval'
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

	/**
	 * Instant-UI overlay (S3, internal): the registry of pending writes to patch
	 * subscriptions with, or null. Read each time it is needed, so an overlay installed
	 * after the manager was created is picked up. Omitted or null: the manager behaves
	 * exactly as it did before the overlay existed (every code path below is gated on it).
	 */
	pendingWrites?: () => PendingWrites | null

	/** The collection definition a query reads (decides whether it may be patched). */
	getDefinition?: (collection: string) => CollectionDefinition | undefined

	/** Monotonic milliseconds for the pass budget. Default `performance.now`. Injected by tests. */
	now?: () => number

	/**
	 * Longest a patch pass may run before the remaining subscriptions fall back to the
	 * commit path (design section 11). Default {@link DEFAULT_OVERLAY_PASS_BUDGET_MS}.
	 */
	overlayPassBudgetMs?: number
}

/** Default budget of one patch pass, in milliseconds (design section 11). */
export const DEFAULT_OVERLAY_PASS_BUDGET_MS = 8

/** The entries that apply to one (collection, base epoch), reused across a patch pass. */
interface ApplicableCache {
	collection: string
	issuedAt: number
	entries: PendingEntry[]
}

/** Counters of the overlay's work, for tests and DevTools (S3). */
export interface OverlayStats {
	/** Patch passes run. */
	passes: number
	/** Callbacks delivered by a patch pass (not by a SQL result). */
	patchedDeliveries: number
	/** Subscriptions a pass left to the commit path because it ran out of budget. */
	budgetSkips: number
	/** Entries the evaluator declined to apply (limit pages, ties, ...). */
	skippedEntries: number
	/** Duration of the most recent pass, in milliseconds (by the manager's clock). */
	lastPassMs: number
}

/**
 * A committed change to the rows of one collection that can affect query results
 * (RT-98). Every invalidation the store makes produces one: local writes and remote
 * applies (with the operation), and changes made without a new operation (rejection
 * re-folds, scope retraction, cascade settling, rematerialization, backup restore,
 * held/discarded writes).
 */
export interface RecordsChange {
	/** Collection whose rows changed */
	readonly collection: string
	/** Changed record ids, or null when unknown (treat the whole collection as changed) */
	readonly ids: readonly string[] | null
	/** The operation that caused the change, when there is one */
	readonly operation?: Operation
}

/** Listener for {@link RecordsChange}s made by this runtime (not those relayed from peers). */
export type RecordsChangeListener = (change: RecordsChange) => void

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
	/** Internal S0 phase timer: when the oldest unflushed change was recorded (null when none or timers off). */
	private notifiedAt: number | null = null
	private readonly onQuerySubscribed?: (descriptor: QueryDescriptor) => () => void
	private readonly onQueryError?: (failure: QuerySubscriptionError) => void
	// Instant-UI overlay state (S3). All of it is inert while `getRegistry` yields null.
	private getRegistry: (() => PendingWrites | null) | undefined
	private readonly getDefinition:
		| ((collection: string) => CollectionDefinition | undefined)
		| undefined
	private clock: () => number
	private passBudgetMs: number
	private attachedRegistry: PendingWrites | null = null
	private stopListening: (() => void) | null = null
	private readonly overlayPending = new Set<string>()
	private overlayScheduled = false
	private readonly overlayCounters: OverlayStats = {
		passes: 0,
		patchedDeliveries: 0,
		budgetSkips: 0,
		skippedEntries: 0,
		lastPassMs: 0,
	}
	private readonly changeListeners = new Set<RecordsChangeListener>()
	/**
	 * Collections changed before the first change listener attached (a store's open:
	 * rematerialization, migration backfills). Replayed to that listener, so other tabs
	 * hear about changes made while this tab was still opening. Bounded by the schema.
	 */
	private unheardCollections: Set<string> | null = new Set()

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
		this.getRegistry = options?.pendingWrites
		this.getDefinition = options?.getDefinition
		this.clock = options?.now ?? (() => performance.now())
		this.passBudgetMs = options?.overlayPassBudgetMs ?? DEFAULT_OVERLAY_PASS_BUDGET_MS
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
		this.registry()

		return () => {
			if (!this.subscriptions.delete(id)) return
			this.bloomDirty = true
			if (this.subscriptions.size === 0) this.detachRegistry()
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
		// The epoch when this read is issued: a read issued before a write's commit may not
		// contain it (design 5.5). Taken before `executeFn` starts the query.
		const registry = this.registry()
		const issuedAt = registry ? registry.epoch : 0
		let results: CollectionRecord[]
		const timers = activePhaseTimers()
		const rereadStartedAt = timers ? performance.now() : 0
		try {
			results = await sub.executeFn()
		} catch (error) {
			if (!this.isCurrent(sub, runNumber)) return
			sub.lastAppliedRun = runNumber
			sub.errored = true
			this.reportError(sub, error, sub.delivered ? 'refresh' : 'initial')
			return
		}
		const rereadEndedAt = timers ? performance.now() : 0
		if (timers) {
			timers.add('reread', rereadEndedAt - rereadStartedAt)
			timers.noteReread()
		}
		if (!this.isCurrent(sub, runNumber)) return
		sub.lastAppliedRun = runNumber

		// Overlay on: this SQL result is the new base, and pending writes it may not contain
		// are applied on top (design 5.5). Overlay off: `shown` is `results`.
		const shown = registry ? this.settleRun(sub, results, issuedAt, registry) : results

		// After a failure, the next success is always delivered (even when equal to
		// the last results) so bindings can leave their error state.
		const equal = sub.resultsEqual ?? defaultResultsEqual
		if (sub.delivered && !sub.errored && equal(sub.lastResults, shown)) {
			timers?.add('diffNotify', performance.now() - rereadEndedAt)
			return
		}

		sub.lastResults = shown
		sub.delivered = true
		sub.errored = false
		timers?.noteCallback(performance.now())
		try {
			sub.callback(shown)
		} catch (error) {
			this.reportError(sub, error, 'callback')
		}
		timers?.add('diffNotify', performance.now() - rereadEndedAt)
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
	notify(collection: string, operation: Operation): void {
		this.recordsChanged({ collection, ids: [operation.recordId], operation })
	}

	/**
	 * Invalidate a collection after a local-view change that has no domain operation
	 * (a re-fold, a retraction, a restore). Pass the record ids when known.
	 */
	invalidate(collection: string, ids: readonly string[] | null = null): void {
		this.recordsChanged({ collection, ids })
	}

	/**
	 * The single entry point for a committed change made by this runtime (RT-98): it
	 * schedules the affected queries and tells every change listener (the cross-tab
	 * bus), so no invalidation path can reach this tab's queries without reaching the
	 * other tabs' too.
	 */
	recordsChanged(change: RecordsChange): void {
		this.invalidateCachedRows(change)
		if (this.notifiedAt === null && activePhaseTimers()) this.notifiedAt = performance.now()
		this.pendingCollections.add(change.collection)
		this.scheduleFlush()
		if (this.unheardCollections) this.unheardCollections.add(change.collection)
		for (const listener of this.changeListeners) {
			try {
				listener(change)
			} catch (error) {
				// A failing listener must not stop this tab's queries or other listeners.
				console.error('[kora] records-change listener failed', error)
			}
		}
	}

	/**
	 * Invalidate a collection for a change another runtime made to the shared
	 * database. Not relayed to change listeners (the peer already broadcast it).
	 */
	invalidateFromPeer(collection: string): void {
		this.registry()?.invalidate(collection)
		this.pendingCollections.add(collection)
		this.scheduleFlush()
	}

	/**
	 * Listen to every committed change this runtime makes.
	 *
	 * @returns An unsubscribe function
	 */
	onRecordsChanged(listener: RecordsChangeListener): () => void {
		this.changeListeners.add(listener)
		const unheard = this.unheardCollections
		this.unheardCollections = null
		for (const collection of unheard ?? []) {
			try {
				listener({ collection, ids: null })
			} catch (error) {
				console.error('[kora] records-change listener failed', error)
			}
		}
		return () => {
			this.changeListeners.delete(listener)
		}
	}

	/**
	 * Immediately flush all pending notifications.
	 * Useful for testing. In production, flushing happens via microtask.
	 */
	async flush(): Promise<void> {
		if (this.pendingCollections.size === 0) return

		const timers = activePhaseTimers()
		const flushStartedAt = timers ? performance.now() : 0
		if (timers && this.notifiedAt !== null)
			timers.add('flushDelay', flushStartedAt - this.notifiedAt)
		this.notifiedAt = null

		const collections = new Set(this.pendingCollections)
		this.pendingCollections.clear()
		this.flushScheduled = false

		// A committed write the subscriptions have not re-read for too long: force the
		// re-read (design section 11). Its settle drops the entry.
		const registry = this.registry()
		const forced = new Set<string>()
		if (registry) {
			for (const entry of registry.sweep().lagging) {
				collections.add(entry.collection)
				forced.add(entry.collection)
			}
		}

		const affected = this.findAffectedSubscriptions(collections)
		timers?.add('findAffected', performance.now() - flushStartedAt)

		// Re-execute and diff. run() never throws: failures reach the error channel.
		for (const sub of affected) {
			await this.run(sub)
		}
		// A collection nobody patches has no run() to settle its entries; the forced re-read
		// above is what ends their wait.
		if (registry) for (const collection of forced) this.settleEntries(collection, registry)
	}

	/**
	 * Remove all subscriptions. Called on store close.
	 */
	clear(): void {
		this.subscriptions.clear()
		this.pendingCollections.clear()
		this.flushScheduled = false
		this.overlayPending.clear()
		this.overlayScheduled = false
		this.detachRegistry()
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

	// --- Instant-UI overlay (S3) ---

	/**
	 * A pending write was added, rolled back or cleared for `collection`: recompute what
	 * its patchable subscriptions display. Coalesced: any number of calls in one task
	 * produce one pass per subscription, in a microtask (design 11). Never touches the
	 * worker and never reaches the change listeners (the cross-tab bus, I11, F17).
	 */
	overlayChanged(collection: string): void {
		this.overlayPending.add(collection)
		if (this.overlayScheduled) return
		this.overlayScheduled = true
		queueMicrotask(() => this.flushOverlay())
	}

	/**
	 * Run the scheduled patch pass now. Called by the microtask; tests call it directly.
	 *
	 * Each affected, patchable subscription with a base recomputes
	 * `displayed = applyOverlay(base, applicable entries)` and its callback runs when the
	 * rows changed. A pass that exceeds its budget stops: the remaining subscriptions keep
	 * what they show and catch up at the commit path (their SQL re-run).
	 */
	flushOverlay(): void {
		this.overlayScheduled = false
		if (this.overlayPending.size === 0) return
		const collections = new Set(this.overlayPending)
		this.overlayPending.clear()
		const registry = this.registry()
		if (!registry) return
		this.overlayCounters.passes++

		const startedAt = this.clock()
		const applicable: ApplicableCache = { collection: '', issuedAt: -1, entries: [] }
		let exhausted = false
		for (const sub of this.subscriptions.values()) {
			if (!collections.has(sub.descriptor.collection)) continue
			if (exhausted) {
				this.overlayCounters.budgetSkips++
				continue
			}
			if (this.clock() - startedAt > this.passBudgetMs) {
				exhausted = true
				this.overlayCounters.budgetSkips++
				continue
			}
			this.patch(sub, registry, applicable)
		}
		this.overlayCounters.lastPassMs = this.clock() - startedAt
	}

	/** Counters of the overlay's work. */
	getOverlayStats(): Readonly<OverlayStats> {
		return { ...this.overlayCounters }
	}

	/** Replace the pass clock and budget. For tests and benchmarks (deterministic budgets). */
	configureOverlay(options: {
		now?: () => number
		passBudgetMs?: number
		pendingWrites?: () => PendingWrites | null
	}): void {
		if (options.pendingWrites) this.getRegistry = options.pendingWrites
		if (options.now) this.clock = options.now
		if (options.passBudgetMs !== undefined) this.passBudgetMs = options.passBudgetMs
	}

	/**
	 * What every subscription holds, in registration order: its base (last SQL result),
	 * the epoch that read was issued at, and the rows it last delivered. For tests and
	 * DevTools; the rows are the live arrays, not copies.
	 */
	inspectOverlay(): Array<{
		readonly descriptor: QueryDescriptor
		readonly base: readonly CollectionRecord[] | null
		readonly baseIssuedAt: number | undefined
		readonly displayed: readonly CollectionRecord[]
		readonly patchable: boolean
	}> {
		return [...this.subscriptions.values()].map((sub) => ({
			descriptor: sub.descriptor,
			base: sub.base ?? null,
			baseIssuedAt: sub.baseIssuedAt,
			displayed: sub.lastResults,
			patchable: this.isPatchableSub(sub),
		}))
	}

	/** Whether a subscription's query may be patched (decided once). */
	private isPatchableSub(sub: Subscription): boolean {
		if (sub.patchable !== undefined) return sub.patchable
		const definition = this.getDefinition?.(sub.descriptor.collection)
		const verdict = definition !== undefined && isPatchable(sub.descriptor, definition)
		sub.patchable = verdict
		return verdict
	}

	/** Recompute one subscription's display from its base and deliver it when it changed. */
	private patch(sub: Subscription, registry: PendingWrites, applicable: ApplicableCache): void {
		const base = sub.base
		const issuedAt = sub.baseIssuedAt
		if (!base || issuedAt === undefined || !this.isPatchableSub(sub)) return
		// Subscriptions of one collection nearly always share a base epoch: look the
		// entries up once per (collection, epoch) per pass.
		const collection = sub.descriptor.collection
		if (applicable.collection !== collection || applicable.issuedAt !== issuedAt) {
			applicable.collection = collection
			applicable.issuedAt = issuedAt
			applicable.entries = registry.applicable(collection, issuedAt)
		}
		const shown = this.overlayRows(sub, base, applicable.entries)
		const equal = sub.resultsEqual ?? defaultResultsEqual
		if (sub.delivered && equal(sub.lastResults, shown)) return
		sub.lastResults = shown
		sub.delivered = true
		this.overlayCounters.patchedDeliveries++
		activePhaseTimers()?.noteCallback(performance.now())
		try {
			sub.callback(shown)
		} catch (error) {
			this.reportError(sub, error, 'callback')
		}
	}

	private overlayRows(
		sub: Subscription,
		base: CollectionRecord[],
		entries: readonly PendingEntry[],
	): CollectionRecord[] {
		if (entries.length === 0) return base
		const { rows, skipped } = applyOverlayReport(base, entries, sub.descriptor)
		this.overlayCounters.skippedEntries += skipped.length
		return rows
	}

	/**
	 * A SQL result arrived for `sub`: it becomes the base, the entries it may not contain
	 * are applied on top, and entries every subscription has now read past are dropped.
	 *
	 * @returns The rows to display
	 */
	private settleRun(
		sub: Subscription,
		results: CollectionRecord[],
		issuedAt: number,
		registry: PendingWrites,
	): CollectionRecord[] {
		if (!this.isPatchableSub(sub)) return results
		sub.base = results
		sub.baseIssuedAt = issuedAt
		const collection = sub.descriptor.collection
		const shown = this.overlayRows(sub, results, registry.applicable(collection, issuedAt))
		this.settleEntries(collection, registry)
		return shown
	}

	/**
	 * Drop committed entries that every patchable subscription of `collection` has read
	 * past (its base was issued at or after the entry's commit). A subscription still
	 * waiting for its first result holds them all.
	 */
	private settleEntries(collection: string, registry: PendingWrites): void {
		if (!registry.hasSettling(collection)) return
		let oldest = Number.POSITIVE_INFINITY
		for (const sub of this.subscriptions.values()) {
			if (sub.descriptor.collection !== collection || !this.isPatchableSub(sub)) continue
			oldest = Math.min(oldest, sub.base ? (sub.baseIssuedAt ?? -1) : -1)
		}
		if (oldest >= 0) registry.settleCollection(collection, oldest)
	}

	/**
	 * Forget cached rows a committed change may have made stale (F21). The post-commit
	 * publication of a predicted local write is the exception: the registry cached its
	 * committed row itself.
	 */
	private invalidateCachedRows(change: RecordsChange): void {
		const registry = this.registry()
		if (!registry) return
		if (change.operation && registry.ownsOperation(change.operation.id)) return
		registry.invalidate(change.collection, change.ids)
	}

	/**
	 * The registry in force, attached to while subscriptions exist. Null with the overlay
	 * off, which is the only thing the hot paths ever test.
	 */
	private registry(): PendingWrites | null {
		const registry = this.getRegistry?.() ?? null
		if (registry === this.attachedRegistry) return registry
		this.detachRegistry()
		// A base belongs to the registry whose epochs it was issued under (and a removed
		// overlay no longer keeps it current): forget them, the next result sets them again.
		for (const sub of this.subscriptions.values()) {
			sub.base = null
			sub.baseIssuedAt = undefined
		}
		if (registry !== null && this.subscriptions.size > 0) {
			this.attachedRegistry = registry
			this.stopListening = registry.onChange((change) => this.onRegistryChange(change))
		}
		return registry
	}

	private detachRegistry(): void {
		this.stopListening?.()
		this.stopListening = null
		this.attachedRegistry = null
	}

	private onRegistryChange(change: RegistryChange): void {
		// An unknown outcome changes nothing: the entry stays shown, as it was. A commit
		// keeps the entry applied (no flicker, F3) but replaces its predicted record by the
		// stored one, so the display is recomputed: it always equals f(base, entries).
		if (change.kind === 'unknown') return
		for (const collection of change.collections) this.overlayChanged(collection)
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
