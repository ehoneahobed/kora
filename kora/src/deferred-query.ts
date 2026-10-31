import type {
	CollectionRecord,
	OrderByDirection,
	QueryBuilder,
	QueryDescriptor,
	QuerySubscriptionError,
	SubscribeOptions,
	SubscriptionCallback,
	WhereClause,
} from '@korajs/store'
import { normalizeWhere } from '@korajs/store/lite'

/** What a deferred query needs from the app that created it. */
export interface DeferredQueryHost {
	/** Resolves once the store is open (and the writes queued before it were applied). */
	whenReady(): Promise<void>
	/** The real query builder for a descriptor, or null while the store is not open. */
	resolve(descriptor: QueryDescriptor): QueryBuilder<CollectionRecord> | null
}

/**
 * A query built before `app.ready`, with the same fluent API as the store's
 * `QueryBuilder`.
 *
 * `KoraProvider` renders before the database opens (first-visit parity, S4a), so
 * `app.todos.where(...)` runs during the first render, when there is no store to build a
 * query on. This object records the query (`where`, `orderBy`, `limit`, `offset`,
 * `include`) and runs it on the real store once it is open: `subscribe` delivers its
 * first result then, `exec` and `count` wait for it. It reports the same descriptor and so
 * the same `queryKey`, which is how the hooks tell a deferred query and its real
 * counterpart apart from a different query: they do not.
 */
export class DeferredQueryBuilder<T = CollectionRecord> {
	private descriptor: QueryDescriptor

	constructor(
		collection: string,
		private readonly host: DeferredQueryHost,
		initialWhere: WhereClause = {},
	) {
		this.descriptor = {
			collection,
			where: normalizeWhere(initialWhere),
			orderBy: [],
		}
	}

	/** Add WHERE conditions (AND semantics), like `QueryBuilder.where`. */
	where(conditions: WhereClause): DeferredQueryBuilder<T> {
		return this.with({ where: { ...this.descriptor.where, ...normalizeWhere(conditions) } })
	}

	/** Add an ORDER BY clause. */
	orderBy(field: string, direction: OrderByDirection = 'asc'): DeferredQueryBuilder<T> {
		return this.with({ orderBy: [...this.descriptor.orderBy, { field, direction }] })
	}

	/** Set the result limit. */
	limit(n: number): DeferredQueryBuilder<T> {
		return this.with({ limit: n })
	}

	/** Set the result offset. */
	offset(n: number): DeferredQueryBuilder<T> {
		return this.with({ offset: n })
	}

	/** Include related records, like `QueryBuilder.include`. */
	include(...targets: string[]): DeferredQueryBuilder<T> {
		return this.with({ include: [...(this.descriptor.include ?? []), ...targets] })
	}

	/** Run the query once the store is open. */
	async exec(): Promise<T[]> {
		return (await this.real()).exec() as Promise<T[]>
	}

	/** Count once the store is open. */
	async count(): Promise<number> {
		return (await this.real()).count()
	}

	/**
	 * Subscribe now; the first result arrives once the store is open. The returned function
	 * cancels the subscription whether or not the store opened yet. A store that fails to
	 * open is reported through `options.onError` (phase `initial`), not thrown.
	 */
	subscribe(callback: SubscriptionCallback<T>, options?: SubscribeOptions): () => void {
		let cancelled = false
		let unsubscribe: (() => void) | null = null
		const start = (): void => {
			if (cancelled) return
			const builder = this.host.resolve(this.descriptor)
			if (!builder) {
				this.fail(options, new Error(NOT_OPEN))
				return
			}
			unsubscribe = builder.subscribe(callback as SubscriptionCallback<CollectionRecord>, options)
		}
		if (this.host.resolve(this.descriptor)) {
			start()
		} else {
			this.host.whenReady().then(start, (error: unknown) => {
				if (cancelled) return
				this.fail(options, error instanceof Error ? error : new Error(String(error)))
			})
		}
		return () => {
			cancelled = true
			unsubscribe?.()
			unsubscribe = null
		}
	}

	/** The descriptor, identical to what the real builder will report. */
	getDescriptor(): QueryDescriptor {
		return {
			...this.descriptor,
			where: { ...this.descriptor.where },
			orderBy: [...this.descriptor.orderBy],
			...(this.descriptor.include ? { include: [...this.descriptor.include] } : {}),
		}
	}

	private async real(): Promise<QueryBuilder<CollectionRecord>> {
		let builder = this.host.resolve(this.descriptor)
		if (!builder) {
			await this.host.whenReady()
			builder = this.host.resolve(this.descriptor)
		}
		if (!builder) throw new Error(NOT_OPEN)
		return builder
	}

	private fail(options: SubscribeOptions | undefined, error: Error): void {
		const failure: QuerySubscriptionError = {
			error,
			phase: 'initial',
			collection: this.descriptor.collection,
			queryId: `deferred:${this.descriptor.collection}`,
		}
		if (options?.onError) options.onError(failure)
		else console.error('[kora] A query could not start because the store did not open:', error)
	}

	private with(change: Partial<QueryDescriptor>): DeferredQueryBuilder<T> {
		const next = new DeferredQueryBuilder<T>(this.descriptor.collection, this.host)
		next.descriptor = { ...this.getDescriptor(), ...change }
		return next
	}
}

const NOT_OPEN = 'The store did not open, so this query cannot run. See the app.ready error.'

/**
 * Rebuild a descriptor on a real query builder: the same `where`, order, window and
 * includes, so the real builder reports the descriptor the deferred one did.
 */
export function applyDescriptor<T>(
	builder: QueryBuilder<T>,
	descriptor: QueryDescriptor,
): QueryBuilder<T> {
	let next = builder
	for (const clause of descriptor.orderBy) next = next.orderBy(clause.field, clause.direction)
	if (descriptor.limit !== undefined) next = next.limit(descriptor.limit)
	if (descriptor.offset !== undefined) next = next.offset(descriptor.offset)
	if (descriptor.include && descriptor.include.length > 0)
		next = next.include(...descriptor.include)
	return next
}
