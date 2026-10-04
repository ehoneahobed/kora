/**
 * Schema-typed views of the collection, query and transaction APIs (W11: DX-1, DX-2).
 *
 * Everything here is type-only. At runtime the app hands out the ordinary store objects
 * (`QueryBuilder`, transaction collection accessors); these types narrow what the
 * compiler accepts to what the schema declares, so unknown fields, wrong value types,
 * unknown sort keys, unknown relations and unknown collections are compile errors.
 */
import type {
	FieldBuilder,
	InferInsertInput,
	InferRecord,
	InferUpdateInput,
	SchemaInput,
} from '@korajs/core'
import type { OrderByDirection, QueryBuilder } from '@korajs/store'

// === Where ===

/** A value a comparison operator (`$gt`, `$lt`, ...) accepts: only numbers and strings compare. */
type Comparable<V> = Extract<NonNullable<V>, number | string>

/**
 * What a field can be compared to in `where()`. Object-valued fields (`t.object`,
 * object-shaped `t.json`) cannot be matched by value (an object in `where` is read as an
 * operator map), so they can only be tested against `null`.
 */
type WhereComparand<V> = V extends readonly unknown[] | Uint8Array ? V : V extends object ? null : V

/** Operators accepted for one field in `where()`. */
export interface WhereOperatorsFor<V> {
	/** Equal to (`null` matches a missing value). */
	$eq?: WhereComparand<V> | null
	/** Not equal to (`null` matches any present value). */
	$ne?: WhereComparand<V> | null
	/** Greater than (numbers and strings, including timestamps). */
	$gt?: Comparable<V>
	/** Greater than or equal to. */
	$gte?: Comparable<V>
	/** Less than. */
	$lt?: Comparable<V>
	/** Less than or equal to. */
	$lte?: Comparable<V>
	/** One of the listed values. */
	$in?: readonly NonNullable<WhereComparand<V>>[]
}

/**
 * The conditions `where()` accepts for a record type `R`: each key is a field of `R`
 * (including `id`, `createdAt` and `updatedAt`), matched by value or by operators.
 * Conditions combine with AND.
 *
 * @example
 * ```typescript
 * app.todos.where({ completed: false, priority: { $in: ['high', 'medium'] } })
 * ```
 */
export type TypedWhere<R> = {
	[K in keyof R & string]?: WhereComparand<R[K]> | WhereOperatorsFor<R[K]>
}

// === Include (relations) ===

type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'A' | 'E' | 'I' | 'O' | 'U'
type EndsWithVowel<S extends string> = S extends `${string}${Vowel}` ? true : false

/** Type-level twin of the store's `singularize()` (packages/store/src/query/pluralize.ts). */
export type Singularize<W extends string> = W extends `${infer S}ies`
	? EndsWithVowel<S> extends true
		? SingularizeAfterIes<W>
		: `${S}y`
	: SingularizeAfterIes<W>

type SingularizeAfterIes<W extends string> = W extends `${infer S}${'sh' | 'ch' | 'x' | 'z'}es`
	? W extends `${infer T}es`
		? T
		: W
	: W extends `${infer S}ses`
		? `${S}s`
		: W extends `${string}ss`
			? W
			: W extends `${infer S}s`
				? S
				: W

/** Type-level twin of the store's `pluralize()`. */
export type Pluralize<W extends string> = W extends `${string}s`
	? W
	: W extends `${infer S}y`
		? EndsWithVowel<S> extends true
			? `${W}s`
			: `${S}ies`
		: W extends `${string}${'sh' | 'ch' | 'x' | 'z'}`
			? `${W}es`
			: `${W}s`

type RelationsOf<S extends SchemaInput> = S['relations'] extends Record<string, unknown>
	? S['relations']
	: Record<never, never>

type FieldsOf<S extends SchemaInput, C> = C extends keyof S['collections']
	? S['collections'][C] extends { fields: infer F extends Record<string, FieldBuilder> }
		? F
		: never
	: never

/** The record type of collection `C` in schema `S`. */
export type RecordOf<S extends SchemaInput, C extends keyof S['collections']> = InferRecord<
	FieldsOf<S, C>
>

/**
 * For collection `C`, every `include()` target and what it adds to each result row:
 * - a relation from `C` to `P` (many-to-one / one-to-one) is included as `P` or its
 *   singular, and adds the singular property holding the parent record or `null`;
 * - a relation from `X` to `C` (one-to-many) is included as `X` or its singular, and adds
 *   the plural property holding the child records.
 */
export type IncludeMap<S extends SchemaInput, C extends string> = UnionToIntersection<
	{
		[N in keyof RelationsOf<S>]: RelationsOf<S>[N] extends {
			from: infer From extends string
			to: infer To extends string
		}
			?
					| (From extends C
							? {
									[T in To | Singularize<To>]: {
										[P in Singularize<T>]: RecordOf<S, To> | null
									}
								}
							: never)
					| (To extends C
							? From extends C
								? never
								: {
										[T in From | Singularize<From>]: {
											[P in Pluralize<T>]: RecordOf<S, From>[]
										}
									}
							: never)
			: never
	}[keyof RelationsOf<S>]
> extends infer M
	? [M] extends [never]
		? Record<never, never>
		: M
	: never

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
	i: infer I,
) => void
	? I
	: never

// === Query builder ===

/**
 * A schema-typed query. At runtime it is the store's `QueryBuilder`, so it can be passed
 * to `useQuery` and the other bindings; the compiler checks field names, value types,
 * sort keys and relation names against the schema.
 *
 * @typeParam R - The row type results have (the record plus any included relations)
 * @typeParam Inc - The `include()` targets this collection has (see {@link IncludeMap})
 * @typeParam Base - The collection's own record: what `where` and `orderBy` accept. An
 *   included relation is a property of the result rows only, never a filterable or
 *   sortable column (RT-100).
 */
export interface TypedQueryBuilder<R, Inc = Record<never, never>, Base = R>
	extends QueryBuilder<R> {
	/** Add WHERE conditions (AND semantics, merged with existing conditions). */
	where(conditions: TypedWhere<Base>): TypedQueryBuilder<R, Inc, Base>
	/** Sort by a field of the record (including `id`, `createdAt` and `updatedAt`). */
	orderBy(field: keyof Base & string, direction?: OrderByDirection): TypedQueryBuilder<R, Inc, Base>
	/** Limit the number of results. */
	limit(n: number): TypedQueryBuilder<R, Inc, Base>
	/** Skip the first `n` results. */
	offset(n: number): TypedQueryBuilder<R, Inc, Base>
	/**
	 * Include related records, following the schema's relations. Each row gains the
	 * relation's property: the parent record (or `null`) for a many-to-one relation, the
	 * child records for a one-to-many relation.
	 */
	include<T extends keyof Inc & string>(
		...targets: T[]
	): TypedQueryBuilder<R & UnionToIntersection<Inc[T]>, Inc, Base>
}

// === Collections ===

/**
 * A typed collection accessor with full type inference.
 * Methods are parameterized by the inferred record, insert, and update types.
 */
export interface TypedCollectionAccessor<TRecord, TInsert, TUpdate, Inc = Record<never, never>> {
	/** Insert a new record. Returns the full record with generated id and metadata. */
	insert(data: TInsert): Promise<TRecord>
	/**
	 * Find a record by its ID; resolves `null` when no live record has that ID.
	 *
	 * @throws {AppNotReadyError} when called before `app.ready` resolves
	 */
	findById(id: string): Promise<TRecord | null>
	/** Update a record by ID with partial data. Returns the updated record. */
	update(id: string, data: TUpdate): Promise<TRecord>
	/** Soft-delete a record by ID. */
	delete(id: string): Promise<void>
	/** Start building a query with WHERE conditions (`{}` matches every record). */
	where(conditions: TypedWhere<TRecord>): TypedQueryBuilder<TRecord, Inc>
}

/** The typed accessor for collection `C` of schema `S`. */
export type TypedCollectionOf<
	S extends SchemaInput,
	C extends keyof S['collections'] & string,
> = TypedCollectionAccessor<
	InferRecord<FieldsOf<S, C>>,
	InferInsertInput<FieldsOf<S, C>>,
	InferUpdateInput<FieldsOf<S, C>>,
	IncludeMap<S, C>
>

/** Every collection of schema `S`, typed. */
export type TypedCollections<S extends SchemaInput> = {
	readonly [C in keyof S['collections'] & string]: TypedCollectionOf<S, C>
}

// === Transactions ===

/** A collection inside a transaction: insert, update, delete and findById, typed. */
export interface TypedTransactionCollection<TRecord, TInsert, TUpdate> {
	/** Insert a record as part of the transaction. */
	insert(data: TInsert): Promise<TRecord>
	/** Update a record as part of the transaction. */
	update(id: string, data: TUpdate): Promise<TRecord>
	/** Delete a record as part of the transaction. */
	delete(id: string): Promise<void>
	/** Read a record inside the transaction (sees the transaction's own writes). */
	findById(id: string): Promise<TRecord | null>
}

/**
 * The transaction proxy passed to `app.transaction()` / `app.mutation()` callbacks for a
 * typed app: one property per schema collection (reserved names such as `events`
 * included, since the proxy has no framework properties).
 */
export type TypedTransactionProxy<S extends SchemaInput> = {
	readonly [C in keyof S['collections'] & string]: TypedTransactionCollection<
		InferRecord<FieldsOf<S, C>>,
		InferInsertInput<FieldsOf<S, C>>,
		InferUpdateInput<FieldsOf<S, C>>
	>
}

// === Helpers for app types ===

/**
 * The record type of collection `C` of a typed app.
 *
 * @example
 * ```typescript
 * type Todo = CollectionRecordOf<typeof app, 'todos'>
 * ```
 */
export type CollectionRecordOf<
	App extends { collections: object },
	C extends keyof App['collections'],
> = App['collections'][C] extends { findById(id: string): Promise<infer R | null> } ? R : never

/** The insert input type of collection `C` of a typed app. */
export type CollectionInsertOf<
	App extends { collections: object },
	C extends keyof App['collections'],
> = App['collections'][C] extends { insert(data: infer I): unknown } ? I : never

/** The update input type of collection `C` of a typed app. */
export type CollectionUpdateOf<
	App extends { collections: object },
	C extends keyof App['collections'],
> = App['collections'][C] extends { update(id: string, data: infer U): unknown } ? U : never
