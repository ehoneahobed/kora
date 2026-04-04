import type { CollectionDefinition } from '@kora/core'
import { deserializeRecord } from '../serialization/serializer'
import type { SubscriptionManager } from '../subscription/subscription-manager'
import type {
	CollectionRecord,
	OrderByDirection,
	QueryDescriptor,
	RawCollectionRow,
	StorageAdapter,
	SubscriptionCallback,
	WhereClause,
} from '../types'
import { buildCountQuery, buildSelectQuery } from './sql-builder'

/**
 * Fluent query builder for constructing and executing collection queries.
 * Supports where, orderBy, limit, offset, exec, count, and subscribe.
 *
 * @example
 * ```typescript
 * const todos = await app.todos
 *   .where({ completed: false })
 *   .orderBy('createdAt', 'desc')
 *   .limit(10)
 *   .exec()
 * ```
 */
export class QueryBuilder {
	private descriptor: QueryDescriptor

	constructor(
		private readonly collectionName: string,
		private readonly definition: CollectionDefinition,
		private readonly adapter: StorageAdapter,
		private readonly subscriptionManager: SubscriptionManager,
		initialWhere: WhereClause = {},
	) {
		this.descriptor = {
			collection: collectionName,
			where: { ...initialWhere },
			orderBy: [],
		}
	}

	/**
	 * Add WHERE conditions (AND semantics, merged with existing conditions).
	 */
	where(conditions: WhereClause): QueryBuilder {
		const clone = this.clone()
		clone.descriptor = {
			...clone.descriptor,
			where: { ...clone.descriptor.where, ...conditions },
		}
		return clone
	}

	/**
	 * Add ORDER BY clause.
	 */
	orderBy(field: string, direction: OrderByDirection = 'asc'): QueryBuilder {
		const clone = this.clone()
		clone.descriptor = {
			...clone.descriptor,
			orderBy: [...clone.descriptor.orderBy, { field, direction }],
		}
		return clone
	}

	/**
	 * Set result limit.
	 */
	limit(n: number): QueryBuilder {
		const clone = this.clone()
		clone.descriptor = { ...clone.descriptor, limit: n }
		return clone
	}

	/**
	 * Set result offset.
	 */
	offset(n: number): QueryBuilder {
		const clone = this.clone()
		clone.descriptor = { ...clone.descriptor, offset: n }
		return clone
	}

	/**
	 * Execute the query and return results.
	 */
	async exec(): Promise<CollectionRecord[]> {
		const { sql, params } = buildSelectQuery(this.descriptor, this.definition.fields)
		const rows = await this.adapter.query<RawCollectionRow>(sql, params)
		return rows.map((row) => deserializeRecord(row, this.definition.fields))
	}

	/**
	 * Execute a COUNT query and return the count.
	 */
	async count(): Promise<number> {
		const { sql, params } = buildCountQuery(this.descriptor, this.definition.fields)
		const rows = await this.adapter.query<{ count: number }>(sql, params)
		return rows[0]?.count ?? 0
	}

	/**
	 * Subscribe to query results. Callback is called immediately with current results,
	 * then again whenever the results change due to mutations.
	 *
	 * @returns An unsubscribe function
	 */
	subscribe(callback: SubscriptionCallback<CollectionRecord>): () => void {
		const executeFn = () => this.exec()

		// Use registerAndFetch to execute immediately, set lastResults,
		// and call callback — ensuring subsequent flushes diff correctly.
		return this.subscriptionManager.registerAndFetch({ ...this.descriptor }, callback, executeFn)
	}

	/** Get the internal descriptor (for testing/debugging) */
	getDescriptor(): QueryDescriptor {
		return { ...this.descriptor }
	}

	private clone(): QueryBuilder {
		const qb = new QueryBuilder(
			this.collectionName,
			this.definition,
			this.adapter,
			this.subscriptionManager,
		)
		qb.descriptor = {
			...this.descriptor,
			where: { ...this.descriptor.where },
			orderBy: [...this.descriptor.orderBy],
		}
		return qb
	}
}
