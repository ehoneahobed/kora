import type { CollectionDefinition, SchemaDefinition } from '@kora/core'
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
import { pluralize, singularize } from './pluralize'
import { buildCountQuery, buildSelectQuery } from './sql-builder'

/**
 * Fluent query builder for constructing and executing collection queries.
 * Supports where, orderBy, limit, offset, include, exec, count, and subscribe.
 *
 * The generic parameter `T` defaults to `CollectionRecord` for backward compatibility
 * but can be narrowed to a specific record type for full type inference.
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
export class QueryBuilder<T = CollectionRecord> {
	private descriptor: QueryDescriptor

	constructor(
		private readonly collectionName: string,
		private readonly definition: CollectionDefinition,
		private readonly adapter: StorageAdapter,
		private readonly subscriptionManager: SubscriptionManager,
		initialWhere: WhereClause = {},
		private readonly schema?: SchemaDefinition,
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
	where(conditions: WhereClause): QueryBuilder<T> {
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
	orderBy(field: string, direction: OrderByDirection = 'asc'): QueryBuilder<T> {
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
	limit(n: number): QueryBuilder<T> {
		const clone = this.clone()
		clone.descriptor = { ...clone.descriptor, limit: n }
		return clone
	}

	/**
	 * Set result offset.
	 */
	offset(n: number): QueryBuilder<T> {
		const clone = this.clone()
		clone.descriptor = { ...clone.descriptor, offset: n }
		return clone
	}

	/**
	 * Include related records in the query results.
	 * Follows relations defined in the schema to batch-fetch related data.
	 *
	 * @param targets - Relation target names (collection names or relation names)
	 * @returns A new QueryBuilder with include targets added
	 *
	 * @example
	 * ```typescript
	 * const todosWithProject = await app.todos
	 *   .where({ completed: false })
	 *   .include('project')
	 *   .exec()
	 * ```
	 */
	include(...targets: string[]): QueryBuilder<T> {
		const clone = this.clone()
		const existing = clone.descriptor.include ?? []
		clone.descriptor = {
			...clone.descriptor,
			include: [...existing, ...targets],
		}
		return clone
	}

	/**
	 * Execute the query and return results.
	 */
	async exec(): Promise<T[]> {
		const { sql, params } = buildSelectQuery(this.descriptor, this.definition.fields)
		const rows = await this.adapter.query<RawCollectionRow>(sql, params)
		const records = rows.map((row) => deserializeRecord(row, this.definition.fields))

		// Resolve includes if any
		if (this.descriptor.include && this.descriptor.include.length > 0 && this.schema) {
			await this.resolveIncludes(records)
		}

		return records as T[]
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
	subscribe(callback: SubscriptionCallback<T>): () => void {
		const executeFn = () => this.exec()

		// Resolve includeCollections for subscription tracking
		const descriptorCopy = { ...this.descriptor }
		if (descriptorCopy.include && descriptorCopy.include.length > 0 && this.schema) {
			descriptorCopy.includeCollections = this.resolveIncludeCollections(descriptorCopy.include)
		}

		// Use registerAndFetch to execute immediately, set lastResults,
		// and call callback — ensuring subsequent flushes diff correctly.
		return this.subscriptionManager.registerAndFetch(
			descriptorCopy,
			callback as SubscriptionCallback<CollectionRecord>,
			executeFn as () => Promise<CollectionRecord[]>,
		)
	}

	/** Get the internal descriptor (for testing/debugging) */
	getDescriptor(): QueryDescriptor {
		return { ...this.descriptor }
	}

	private clone(): QueryBuilder<T> {
		const qb = new QueryBuilder<T>(
			this.collectionName,
			this.definition,
			this.adapter,
			this.subscriptionManager,
			{},
			this.schema,
		)
		qb.descriptor = {
			...this.descriptor,
			where: { ...this.descriptor.where },
			orderBy: [...this.descriptor.orderBy],
			include: this.descriptor.include ? [...this.descriptor.include] : undefined,
			includeCollections: this.descriptor.includeCollections
				? [...this.descriptor.includeCollections]
				: undefined,
		}
		return qb
	}

	/**
	 * Resolve include targets to their actual collection names for subscription tracking.
	 */
	private resolveIncludeCollections(targets: string[]): string[] {
		if (!this.schema) return []
		const collections: string[] = []

		for (const target of targets) {
			const relation = this.findRelation(target)
			if (relation) {
				// For many-to-one: the related collection is `relation.to`
				// For one-to-many: the related collection is `relation.from`
				if (relation.from === this.collectionName) {
					collections.push(relation.to)
				} else {
					collections.push(relation.from)
				}
			}
		}

		return collections
	}

	/**
	 * Resolve includes after primary query, batch-fetching related records.
	 */
	private async resolveIncludes(records: CollectionRecord[]): Promise<void> {
		if (!this.schema || !this.descriptor.include || records.length === 0) return

		for (const target of this.descriptor.include) {
			const relation = this.findRelation(target)
			if (!relation) {
				throw new QueryError(
					`No relation found for include target "${target}" on collection "${this.collectionName}". ` +
						`Check that a relation is defined in your schema that connects "${this.collectionName}" to "${target}".`,
				)
			}

			if (relation.from === this.collectionName) {
				// Many-to-one or one-to-one: primary has FK → fetch parent records
				await this.resolveManyToOneInclude(records, relation, target)
			} else {
				// One-to-many: related collection has FK → fetch children
				await this.resolveOneToManyInclude(records, relation, target)
			}
		}
	}

	/**
	 * Many-to-one: collect FK values from primary results, batch-fetch related, attach as singular.
	 */
	private async resolveManyToOneInclude(
		records: CollectionRecord[],
		relation: { from: string; to: string; field: string },
		target: string,
	): Promise<void> {
		const fkField = relation.field
		const fkValues = records
			.map((r) => r[fkField])
			.filter((v): v is string => v !== null && v !== undefined && typeof v === 'string')

		if (fkValues.length === 0) {
			// All null FKs — set property to null on all records
			const propName = singularize(target)
			for (const record of records) {
				;(record as Record<string, unknown>)[propName] = null
			}
			return
		}

		const uniqueFks = [...new Set(fkValues)]
		const relatedCollection = relation.to
		const relatedDef = this.schema?.collections[relatedCollection]
		if (!relatedDef) return

		// Batch fetch: SELECT * FROM <to> WHERE id IN (...) AND _deleted = 0
		const placeholders = uniqueFks.map(() => '?').join(', ')
		const sql = `SELECT * FROM ${relatedCollection} WHERE id IN (${placeholders}) AND _deleted = 0`
		const rows = await this.adapter.query<RawCollectionRow>(sql, uniqueFks)
		const relatedRecords = rows.map((row) => deserializeRecord(row, relatedDef.fields))

		// Build lookup
		const lookup = new Map<string, CollectionRecord>()
		for (const r of relatedRecords) {
			lookup.set(r.id, r)
		}

		// Attach as singular property
		const propName = singularize(target)
		for (const record of records) {
			const fk = record[fkField] as string | null
			;(record as Record<string, unknown>)[propName] = fk ? (lookup.get(fk) ?? null) : null
		}
	}

	/**
	 * One-to-many: collect primary IDs, batch-fetch children, attach as array.
	 */
	private async resolveOneToManyInclude(
		records: CollectionRecord[],
		relation: { from: string; to: string; field: string },
		target: string,
	): Promise<void> {
		const primaryIds = records.map((r) => r.id)
		const relatedCollection = relation.from
		const relatedDef = this.schema?.collections[relatedCollection]
		if (!relatedDef) return

		const fkField = relation.field
		const placeholders = primaryIds.map(() => '?').join(', ')
		const sql = `SELECT * FROM ${relatedCollection} WHERE ${fkField} IN (${placeholders}) AND _deleted = 0`
		const rows = await this.adapter.query<RawCollectionRow>(sql, primaryIds)
		const relatedRecords = rows.map((row) => deserializeRecord(row, relatedDef.fields))

		// Group by FK
		const grouped = new Map<string, CollectionRecord[]>()
		for (const r of relatedRecords) {
			const fk = r[fkField] as string
			if (!grouped.has(fk)) {
				grouped.set(fk, [])
			}
			grouped.get(fk)?.push(r)
		}

		// Attach as array property
		const propName = pluralize(target)
		for (const record of records) {
			;(record as Record<string, unknown>)[propName] = grouped.get(record.id) ?? []
		}
	}

	/**
	 * Find a relation definition matching the include target.
	 * Searches by relation name, target collection name, and singularized/pluralized variants.
	 */
	private findRelation(
		target: string,
	): { from: string; to: string; field: string; type: string } | null {
		if (!this.schema) return null

		for (const [_name, rel] of Object.entries(this.schema.relations)) {
			// Direct match: target is the related collection name
			if (rel.from === this.collectionName && rel.to === target) return rel
			if (rel.to === this.collectionName && rel.from === target) return rel

			// Singularized match: "project" matches relation to "projects"
			if (rel.from === this.collectionName && rel.to === pluralize(target)) return rel
			if (rel.to === this.collectionName && rel.from === pluralize(target)) return rel

			// Pluralized match: "todos" matches relation from "todos"
			if (rel.from === this.collectionName && rel.to === singularize(target)) return rel
			if (rel.to === this.collectionName && rel.from === singularize(target)) return rel
		}

		return null
	}
}

/**
 * Error thrown when a query encounters an invalid state.
 */
class QueryError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'QueryError'
	}
}
