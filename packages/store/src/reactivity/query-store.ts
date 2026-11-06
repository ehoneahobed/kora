import type { QueryBuilder } from '../query/query-builder'
import type { CollectionRecord, QueryCoverage } from '../types'

/**
 * Frozen empty array returned as the initial snapshot before any data loads.
 * Same reference every time prevents infinite update loops in UI bindings.
 */
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([])

const PENDING_COVERAGE: QueryCoverage = { source: 'pending', complete: false }
const LOCAL_COMPLETE: QueryCoverage = { source: 'local', complete: true }

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
	private hasEmittedSnapshot = false
	private error: Error | null = null
	private coverage: QueryCoverage = PENDING_COVERAGE
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

	/**
	 * Whether the underlying query subscription has delivered at least one
	 * authoritative result for the current subscription lifecycle.
	 */
	hasSnapshot = (): boolean => {
		return this.hasEmittedSnapshot
	}

	/**
	 * The latest query failure, or null. Set when the query (or a re-run after a
	 * write) fails; cleared by the next successful delivery. Listeners are notified
	 * on both transitions, so bindings read it next to `getSnapshot()`.
	 */
	getError = (): Error | null => {
		return this.error
	}

	/**
	 * Where the snapshot's rows come from and whether they are complete. The same object until
	 * it changes. A query that reports nothing is a plain local one: pending until its first
	 * result, then local and complete.
	 */
	getCoverage(): QueryCoverage {
		return this.coverage
	}

	/** Tear down listeners and the underlying query subscription. */
	destroy(): void {
		this.stopSubscription()
		this.listeners.clear()
		this.snapshot = EMPTY_ARRAY as readonly T[]
		this.hasEmittedSnapshot = false
		this.error = null
		this.coverage = PENDING_COVERAGE
	}

	private startSubscription(): void {
		this.active = true
		this.unsubscribeQuery = this.queryBuilder.subscribe(
			(results: readonly T[]) => {
				if (!this.active) return
				this.hasEmittedSnapshot = true
				this.error = null
				if (this.coverage === PENDING_COVERAGE) this.coverage = LOCAL_COMPLETE
				this.snapshot = Object.freeze([...results])
				this.notifyListeners()
			},
			{
				onCoverage: (coverage) => {
					if (
						!this.active ||
						(this.coverage.source === coverage.source &&
							this.coverage.complete === coverage.complete)
					) {
						return
					}
					this.coverage = coverage
					this.notifyListeners()
				},
				// STORE-12: the failure reaches bindings as error state; the last
				// snapshot stays readable and the next success clears the error.
				onError: (failure) => {
					if (!this.active) return
					this.error = failure.error
					this.notifyListeners()
				},
			},
		)
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
