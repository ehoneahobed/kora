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
	richtext: string
	enum: string
	array: unknown[]
}

// === Individual Field Inference ===

/**
 * Infers the TypeScript type for a single field descriptor or builder.
 * Supports both FieldBuilder (class instances) and FieldDescriptor (compiled objects).
 */
export type InferFieldType<F> =
	// EnumFieldBuilder (class instance — preserves literal union)
	F extends EnumFieldBuilder<infer V, any, any>
		? V[number]
		// ArrayFieldBuilder (class instance)
		: F extends ArrayFieldBuilder<infer K, any, any>
			? FieldKindToType[K][]
			// Generic FieldBuilder (class instance — string, number, boolean, timestamp, richtext)
			: F extends FieldBuilder<infer K, any, any>
				? K extends keyof FieldKindToType ? FieldKindToType[K] : unknown
				// FieldDescriptor enum (structural — enumValues should be readonly string[])
				: F extends { kind: 'enum'; enumValues: infer V }
					? V extends readonly (infer S)[] ? S : string
					// FieldDescriptor array (structural)
					: F extends { kind: 'array'; itemKind: infer K extends FieldKind }
						? FieldKindToType[K][]
						// FieldDescriptor generic (structural — string, number, boolean, timestamp, richtext)
						: F extends { kind: infer K extends FieldKind }
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
 * Infers the insert input type using inline key remapping.
 * - Required non-auto fields are required keys
 * - Optional/defaulted non-auto fields are optional keys
 * - Auto fields are excluded entirely
 */
export type InferInsertInput<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in keyof Fields as Fields[K] extends FieldBuilder<any, any, true>
		? never
		: Fields[K] extends FieldBuilder<any, true, false>
			? K
			: never
	]: InferFieldType<Fields[K]>
} & {
	[K in keyof Fields as Fields[K] extends FieldBuilder<any, any, true>
		? never
		: Fields[K] extends FieldBuilder<any, true, false>
			? never
			: K
	]?: InferFieldType<Fields[K]>
}

// === Update Input Inference ===

/**
 * Infers the update input type using inline key remapping.
 * All non-auto fields are optional (partial update semantics).
 */
export type InferUpdateInput<Fields extends Record<string, FieldBuilder<any, any, any>>> = {
	[K in keyof Fields as Fields[K] extends FieldBuilder<any, any, true> ? never : K]?: InferFieldType<Fields[K]>
}
