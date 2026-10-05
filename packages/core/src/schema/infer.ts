/**
 * Type-level inference utilities for Kora schemas.
 *
 * These mapped types read the structural `'~field'` brand every FieldBuilder carries
 * (kind, requiredness, auto flag, read and write value types) and turn a collection's
 * builders into record, insert and update types, enabling autocomplete and type checking
 * from defineSchema() through createApp() to collection methods.
 *
 * Nullability rules (they mirror the runtime):
 * - Record (read): a required field is `T`; an auto `timestamp` is `number` (the framework
 *   always fills it); every other field is `T | null` (optional and defaulted fields can be
 *   cleared with `update(id, { field: null })`, and rows written before a field existed
 *   hold null).
 * - Insert: a required field must be provided; optional and defaulted fields may be
 *   omitted (not `null`: insert refuses null); auto fields cannot be provided at all.
 * - Update: every non-auto field is optional; optional and defaulted fields accept `null`
 *   to clear them; number and timestamp fields also accept the numeric `op.*` helpers, and
 *   array fields `op.append` / `op.remove` with an item of the element type.
 *
 * Zero runtime cost — these are purely compile-time constructs.
 */

import type { ArrayAtomicOpSentinel, NumericAtomicOpSentinel } from '../operations/atomic-ops'
import type { BlobRef, FieldKind } from '../types'
import type { FieldBuilder, FieldInput, FieldOutput, RichtextInput, Simplify } from './types'

// === Field Kind → TypeScript Type Mapping ===

/**
 * Maps a FieldKind string literal to the TypeScript type a read returns for it, when
 * nothing more specific is known (a compiled {@link FieldDescriptor} rather than a
 * builder). Builders carry exact types: enum literal unions, array item types, object
 * shapes and json `T`.
 */
export interface FieldKindToType {
	string: string
	number: number
	boolean: boolean
	timestamp: number
	richtext: Uint8Array
	enum: string
	array: unknown[]
	object: Record<string, unknown>
	json: unknown
	blob: BlobRef
	secret: string
}

/** Any field builder. */
type AnyField = FieldBuilder

/** The field map of one collection, as written in `defineSchema({ collections: { x: { fields } } })`. */
export type FieldMap = Record<string, AnyField>

// === Individual Field Inference ===

/**
 * Infers the TypeScript type a read returns for a single field builder or compiled
 * field descriptor (before nullability). For a builder this is exact: enum literal
 * unions, typed array items, object shapes and json `T` are preserved.
 */
export type InferFieldType<F> = F extends { readonly '~field': unknown }
	? FieldOutput<F>
	: // FieldDescriptor enum (structural — enumValues should be readonly string[])
		F extends { kind: 'enum'; enumValues: infer V }
		? V extends readonly (infer S)[]
			? S
			: string
		: // FieldDescriptor array (structural)
			F extends { kind: 'array'; itemKind: infer K extends FieldKind }
			? FieldKindToType[K][]
			: // FieldDescriptor generic (structural)
				F extends { kind: infer K extends FieldKind }
				? FieldKindToType[K]
				: unknown

/**
 * Infers the TypeScript type a write accepts for a single field builder (before
 * optionality). Equal to {@link InferFieldType} except for richtext, which accepts a
 * string or Yjs bytes.
 */
export type InferFieldInput<F> = F extends { readonly '~field': unknown }
	? FieldInput<F>
	: F extends { kind: 'richtext' }
		? RichtextInput
		: InferFieldType<F>

type IsRequired<F> = F extends { readonly '~field': { readonly required: true } } ? true : false
type IsAuto<F> = F extends { readonly '~field': { readonly auto: true } } ? true : false
type KindOf<F> = F extends { readonly '~field': { readonly kind: infer K } } ? K : FieldKind

type RequiredInsertKeys<F extends FieldMap> = {
	[K in keyof F]: IsAuto<F[K]> extends true ? never : IsRequired<F[K]> extends true ? K : never
}[keyof F]

type OptionalInsertKeys<F extends FieldMap> = {
	[K in keyof F]: IsAuto<F[K]> extends true ? never : IsRequired<F[K]> extends true ? never : K
}[keyof F]

type WritableKeys<F extends FieldMap> = {
	[K in keyof F]: IsAuto<F[K]> extends true ? never : K
}[keyof F]

/** The read type of one field in a record, nullability applied. */
export type InferRecordField<F> = IsRequired<F> extends true
	? InferFieldType<F>
	: IsAuto<F> extends true
		? KindOf<F> extends 'timestamp'
			? InferFieldType<F>
			: InferFieldType<F> | null
		: InferFieldType<F> | null

// === Record Inference (full record type with id, createdAt, updatedAt) ===

/**
 * Infers the full record type returned from queries.
 * Includes `id`, `createdAt`, `updatedAt` metadata fields.
 * Optional and defaulted fields include `| null` in their type.
 */
export type InferRecord<Fields extends FieldMap> = Simplify<
	{
		readonly id: string
		readonly createdAt: number
		readonly updatedAt: number
	} & {
		readonly [K in keyof Fields]: InferRecordField<Fields[K]>
	}
>

// === Insert Input Inference ===

/**
 * Infers the insert input type.
 * - Required non-auto fields are required keys
 * - Optional/defaulted non-auto fields are optional keys (omit them; `null` is refused)
 * - Auto fields are excluded entirely
 */
export type InferInsertInput<Fields extends FieldMap> = Simplify<
	{
		[K in RequiredInsertKeys<Fields>]: InferFieldInput<Fields[K]>
	} & {
		[K in OptionalInsertKeys<Fields>]?: InferFieldInput<Fields[K]>
	}
>

/** Alias of {@link InferInsertInput}. */
export type InferInsert<Fields extends FieldMap> = InferInsertInput<Fields>

// === Update Input Inference ===

/** The element type of an array field's value. */
type ArrayItemOf<T> = T extends readonly (infer Item)[] ? Item : never

/**
 * The `op.*` helpers one field accepts (RT-113): the numeric helpers (`increment`,
 * `decrement`, `max`, `min`) on number and timestamp fields, the array helpers (`append`,
 * `remove`) with the field's element type on array fields, none elsewhere. The runtime
 * refuses every other combination, since the resolved value leaves the field's domain.
 */
export type InferAtomicOp<F> = KindOf<F> extends 'number' | 'timestamp'
	? NumericAtomicOpSentinel
	: KindOf<F> extends 'array'
		? ArrayAtomicOpSentinel<ArrayItemOf<InferFieldType<F>>>
		: never

/** The values an update accepts for one field. */
export type InferUpdateField<F> =
	| InferFieldInput<F>
	| (IsRequired<F> extends true ? never : null)
	| InferAtomicOp<F>

/**
 * Infers the update input type.
 * All non-auto fields are optional (partial update semantics). Optional and defaulted
 * fields accept `null`; number and timestamp fields accept the numeric `op.*` helpers and
 * array fields the array helpers with their element type ({@link InferAtomicOp}).
 */
export type InferUpdateInput<Fields extends FieldMap> = Simplify<{
	[K in WritableKeys<Fields>]?: InferUpdateField<Fields[K]>
}>

/** Alias of {@link InferUpdateInput}. */
export type InferUpdate<Fields extends FieldMap> = InferUpdateInput<Fields>
