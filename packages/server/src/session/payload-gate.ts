import type { CollectionDefinition, Operation } from '@korajs/core'
import { planField } from '@korajs/core/internal'

/**
 * Pure helpers of the outbound payload gate (see `ClientSession.cutUnprovablePayloads`).
 *
 * `previousData` is the writer's base. The fold reads it for exactly two things: telling
 * an update that restates a field unchanged from a write, and, for the kinds listed in
 * {@link readsBase}, computing what the write changed (the elements an array update added
 * and removed, a counter's delta, a key an object update removed, a custom resolver's
 * `base`). For every other field a base that differs from the new value has no effect on
 * the folded record, so it can be cut without changing what any replica folds.
 */

/** The fold kinds whose result depends on the writer's base value. */
const BASE_READING_KINDS = new Set(['set', 'map', 'ctr', 'res'])

/**
 * True when folding an update of `field` reads the writer's base (`previousData[field]`)
 * beyond telling an unchanged restatement apart.
 *
 * @param collection - The collection definition, if the schema has it
 * @param field - The field name
 */
export function readsBase(collection: CollectionDefinition | undefined, field: string): boolean {
	return BASE_READING_KINDS.has(planField(collection, field).kind)
}

/**
 * Like {@link readsBase}, but a field the schema does not know (and no resolver covers)
 * counts as base-reading. The fold would treat it as a register, but an unknown name is
 * exactly what a schema transform renames, and misjudging it as a register would cut a
 * base the receiving fold reads. Failing closed costs a withheld update, never a leak.
 */
export function readsBaseOrUnknown(
	collection: CollectionDefinition | undefined,
	field: string,
): boolean {
	if (collection === undefined) return true
	const known =
		Object.prototype.hasOwnProperty.call(collection.fields, field) ||
		(collection.resolvers !== undefined &&
			Object.prototype.hasOwnProperty.call(collection.resolvers, field))
	return !known || readsBase(collection, field)
}

/** Structural equality of two operation values (JSON-like values and byte arrays). */
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (a instanceof Uint8Array && b instanceof Uint8Array) {
		return a.length === b.length && a.every((byte, index) => byte === b[index])
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((value, index) => sameValue(value, b[index]))
	}
	if (
		typeof a === 'object' &&
		typeof b === 'object' &&
		a !== null &&
		b !== null &&
		!Array.isArray(a) &&
		!Array.isArray(b)
	) {
		const left = a as Record<string, unknown>
		const right = b as Record<string, unknown>
		const keys = Object.keys(left)
		return (
			keys.length === Object.keys(right).length &&
			keys.every((key) => key in right && sameValue(left[key], right[key]))
		)
	}
	return false
}

/** The outcome of {@link cutPreviousData}. */
export interface PreviousDataCut {
	/** The operation to send (the input itself when nothing was cut). */
	operation: Operation
	/** True when a `previousData` entry was removed. */
	changed: boolean
	/** True when a removed entry belongs to a field whose fold reads its base. */
	lostBase: boolean
}

/**
 * Remove from an update's `previousData` every entry that tells the recipient something
 * its `data` does not: an entry equal to the new value reveals nothing and is kept (it is
 * how an unchanged restatement is recognised); any other entry is old content. The copy
 * keeps the id and declares no hash version, which is how a client already receives an
 * operation the server rewrote (it does not check the id of such an operation).
 *
 * Base dependence is judged on the operation as the fold reads it: the wire field names
 * are classified against the current schema (unknown ones fail closed), and when a schema
 * transform rewrites the operation, the transformed view's fields are classified too.
 * The wire representation of the copy is never rewritten.
 *
 * @param operation - A non-delete operation
 * @param collection - Its collection definition, if the schema has it
 * @param view - The operation as the schema reads it (`operationSchemaView`), `undefined`
 *   when it is the operation itself, `'unreadable'` when the transform failed (fail closed)
 */
export function cutPreviousData(
	operation: Operation,
	collection: CollectionDefinition | undefined,
	view?: Operation | null | 'unreadable',
): PreviousDataCut {
	const previous = operation.previousData
	if (operation.type === 'delete' || previous === null || previous === undefined) {
		return { operation, changed: false, lostBase: false }
	}
	const kept: Record<string, unknown> = {}
	let changed = false
	let lostBase = false
	for (const [field, value] of Object.entries(previous)) {
		if (
			operation.data !== null &&
			field in operation.data &&
			sameValue(value, operation.data[field])
		) {
			kept[field] = value
			continue
		}
		changed = true
		if (readsBaseOrUnknown(collection, field)) lostBase = true
	}
	if (!changed) return { operation, changed: false, lostBase: false }
	if (!lostBase && view !== undefined && view !== operation) {
		if (view === 'unreadable') lostBase = true
		else if (view !== null) {
			const names = [...Object.keys(view.previousData ?? {}), ...Object.keys(view.data ?? {})]
			lostBase = names.some((name) => readsBaseOrUnknown(collection, name))
		}
	}
	const { hashVersion, ...rest } = operation
	void hashVersion
	return { operation: { ...rest, previousData: kept }, changed: true, lostBase }
}
