import type { FieldDescriptor, FieldKind } from '@korajs/core'
import type { CollectionRecord } from '../types'

/** Compares two query result sets; true means subscribers need not be notified. */
export type ResultsEqual = (
	prev: readonly CollectionRecord[],
	next: readonly CollectionRecord[],
) => boolean

type ValueEqual = (a: unknown, b: unknown) => boolean

/**
 * Structural equality for any value a deserialized record can hold: primitives
 * (with `Object.is`, so NaN equals NaN), arrays, byte views (richtext and blob
 * state), Dates and plain objects (own enumerable keys, order-insensitive).
 *
 * Deserialization builds fresh arrays and objects on every query run, so a
 * reference comparison reports every structured field as changed (STORE-12) and
 * every subscriber re-renders on every unrelated write to the collection.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false

	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
		return bytesEqual(a, b)
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) {
			if (!structurallyEqual(a[i], b[i])) return false
		}
		return true
	}
	if (a instanceof Date || b instanceof Date) {
		return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime())
	}

	const objA = a as Record<string, unknown>
	const objB = b as Record<string, unknown>
	const keysA = Object.keys(objA)
	if (keysA.length !== Object.keys(objB).length) return false
	for (const key of keysA) {
		if (!Object.hasOwn(objB, key)) return false
		if (!structurallyEqual(objA[key], objB[key])) return false
	}
	return true
}

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
	if (a.byteLength !== b.byteLength) return false
	const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
	const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
	for (let i = 0; i < x.length; i++) {
		if (x[i] !== y[i]) return false
	}
	return true
}

function scalarEqual(a: unknown, b: unknown): boolean {
	return Object.is(a, b)
}

/**
 * The comparator for one field kind. Scalars deserialize to primitives, so
 * identity is exact for them; structured kinds deserialize to fresh containers
 * and need a structural comparison.
 */
function equalityForKind(kind: FieldKind): ValueEqual {
	switch (kind) {
		case 'string':
		case 'number':
		case 'boolean':
		case 'timestamp':
		case 'enum':
			return scalarEqual
		case 'array':
		case 'object':
		case 'json':
		case 'blob':
		case 'richtext':
		case 'secret':
			return structurallyEqual
		default:
			return structurallyEqual
	}
}

/**
 * Build the result-set comparator for a collection's records: per schema field,
 * the comparator for its kind; for every other key (id, createdAt, updatedAt and
 * included relations) a structural comparison.
 *
 * @param fields - The collection's field descriptors
 * @returns A comparator that is true when both result sets hold the same records,
 *   in the same order, with structurally equal values
 */
export function createResultsEqual(fields: Record<string, FieldDescriptor>): ResultsEqual {
	const perField = new Map<string, ValueEqual>()
	for (const [name, descriptor] of Object.entries(fields)) {
		perField.set(name, equalityForKind(descriptor.kind))
	}

	const recordEqual = (a: CollectionRecord, b: CollectionRecord): boolean => {
		const recA = a as Record<string, unknown>
		const recB = b as Record<string, unknown>
		const keysA = Object.keys(recA)
		if (keysA.length !== Object.keys(recB).length) return false
		for (const key of keysA) {
			if (!Object.hasOwn(recB, key)) return false
			const eq = perField.get(key) ?? structurallyEqual
			if (!eq(recA[key], recB[key])) return false
		}
		return true
	}

	return (prev, next) => {
		if (prev === next) return true
		if (prev.length !== next.length) return false
		// Cheap pass first: a different id at any position means the set changed.
		for (let i = 0; i < prev.length; i++) {
			if (prev[i]?.id !== next[i]?.id) return false
		}
		for (let i = 0; i < prev.length; i++) {
			const a = prev[i]
			const b = next[i]
			if (a === undefined || b === undefined) return a === b
			if (!recordEqual(a, b)) return false
		}
		return true
	}
}

/**
 * Comparator used when the collection's schema is unknown (a subscription
 * registered directly on the manager): structural comparison of every value.
 */
export const defaultResultsEqual: ResultsEqual = createResultsEqual({})
