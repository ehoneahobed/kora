/**
 * Type-level inference utilities for Kora schemas.
 *
 * These mapped types convert FieldBuilder type parameters into concrete
 * TypeScript types, enabling full autocomplete and type checking from
 * defineSchema() through createApp() to collection methods.
 *
 * Zero runtime cost — these are purely compile-time constructs.
 */

import type { FieldKind } from '../types'
import type { ArrayFieldBuilder, EnumFieldBuilder, FieldBuilder } from './types'

// === Field Kind → TypeScript Type Mapping ===

/**
 * Maps a FieldKind string literal to its corresponding TypeScript type.
 */
export interface FieldKindToType {
	string: string
	number: number
	boolean: boolean
	timestamp: number
	richtext: Uint8Array
	enum: string
	array: unknown[]
}

// === Individual Field Inference ===

/**
 * Infers the TypeScript type for a single FieldBuilder.
 * Handles base fields, enums (with literal union), and arrays (with typed items).
 */
export type InferFieldType<F> =
	F extends EnumFieldBuilder<infer V, infer _Req, infer _Auto>
		? V[number]
		: F extends ArrayFieldBuilder<infer K, infer _Req, infer _Auto>
			? FieldKindToType[K][]
			: F extends FieldBuilder<infer K, infer _Req, infer _Auto>
				? FieldKindToType[K]
				: unknown

// === Record Inference (full record type with id, createdAt, updatedAt) ===

/**
 * Infers the full record type returned from queries.
 * Includes `id`, `createdAt`, `updatedAt` metadata fields.
 * Optional/defaulted fields include `| null` in their type.
 */
export type InferRecord<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	readonly id: string
	readonly createdAt: number
	readonly updatedAt: number
} & {
	readonly [K in keyof Fields]: Fields[K] extends FieldBuilder<any, true, any>
		? InferFieldType<Fields[K]>
		: InferFieldType<Fields[K]> | null
}

// === Insert Input Inference ===

/**
 * Helper: extract keys where the field is required and not auto.
 */
type RequiredInsertKeys<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in keyof Fields]: Fields[K] extends FieldBuilder<any, any, true>
		? never // auto fields excluded
		: Fields[K] extends FieldBuilder<any, true, false>
			? K // required, not auto
			: never
}[keyof Fields]

/**
 * Helper: extract keys where the field is optional (not required) and not auto.
 */
type OptionalInsertKeys<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in keyof Fields]: Fields[K] extends FieldBuilder<any, any, true>
		? never // auto fields excluded
		: Fields[K] extends FieldBuilder<any, true, false>
			? never // required, handled above
			: K // optional/defaulted
}[keyof Fields]

/**
 * Infers the insert input type.
 * - Required non-auto fields are required keys
 * - Optional/defaulted non-auto fields are optional keys
 * - Auto fields are excluded entirely
 */
export type InferInsertInput<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in RequiredInsertKeys<Fields> & string]: InferFieldType<Fields[K]>
} & {
	[K in OptionalInsertKeys<Fields> & string]?: InferFieldType<Fields[K]>
}

// === Update Input Inference ===

/**
 * Helper: extract keys where the field is not auto.
 */
type NonAutoKeys<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in keyof Fields]: Fields[K] extends FieldBuilder<any, any, true> ? never : K
}[keyof Fields]

/**
 * Infers the update input type.
 * All non-auto fields are optional (partial update semantics).
 */
export type InferUpdateInput<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in NonAutoKeys<Fields> & string]?: InferFieldType<Fields[K]>
}
