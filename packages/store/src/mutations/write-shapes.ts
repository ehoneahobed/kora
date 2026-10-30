import type { AtomicOp, CollectionDefinition } from '@korajs/core'
import { assertResolvedFieldValue, isAtomicOp, resolveAtomicOp, toAtomicOp } from '@korajs/core'
import { encodeRichtextFieldsForOpData } from '../serialization/op-data-encoding'
import { deserializeRecord, toRichtextReadShape } from '../serialization/serializer'
import type { CollectionRecord, RawCollectionRow } from '../types'

/*
 * The pure, storage-free parts of the local write path (instant-UI stage S2).
 *
 * `write-ops.ts` builds and persists operations inside a storage transaction. What it
 * computes from values it already holds (the body of an insert, the previous and
 * resolved values of an update, the record a write reports) lives here, so the
 * write path and the overlay predictor (`overlay/predict.ts`) call the SAME code and
 * cannot drift apart. Nothing in this file touches storage, a clock or the overlay.
 */

/** An insert whose values are validated and in their at-rest form. */
export interface PreparedInsert {
	readonly collection: string
	readonly recordId: string
	/** Record-shaped, at-rest values (secret fields hashed / encrypted). */
	readonly data: Record<string, unknown>
}

/**
 * The `data` of an insert operation: the prepared values with binary richtext tagged as
 * canonical JSON BEFORE hashing, so the hash input, persisted JSON and wire payload are
 * the identical value.
 */
export function insertOperationData(
	insert: PreparedInsert,
	definition: CollectionDefinition,
): Record<string, unknown> {
	return encodeRichtextFieldsForOpData(insert.data, definition.fields)
}

/**
 * The record an insert reports: the prepared values plus the operation's wall time as
 * `createdAt` and `updatedAt`. A richtext value written as a string returns as the bytes
 * reads return.
 *
 * @param insert - The prepared insert the transaction wrote
 * @param definition - The collection's definition
 * @param wallTime - `operation.timestamp.wallTime` of the insert operation
 */
export function recordForInsert(
	insert: PreparedInsert,
	definition: CollectionDefinition,
	wallTime: number,
): CollectionRecord {
	return {
		id: insert.recordId,
		...toRichtextReadShape(insert.data, definition.fields),
		createdAt: wallTime,
		updatedAt: wallTime,
	}
}

/** What an update writes, derived from the row's current record. */
export interface UpdatePatch {
	/** The current values of the fields being written (enables 3-way merge). */
	readonly previousData: Record<string, unknown>
	/** The values to write: atomic ops resolved against the current record. */
	readonly resolved: Record<string, unknown>
	/** The atomic intents among the written fields, by field. */
	readonly atomicOps: Record<string, AtomicOp>
}

/**
 * Work out `previousData`, the resolved values and the atomic intents of an update
 * from the record's current values. `allowed` is the state-machine-filtered, schema
 * validated input (it may contain atomic op descriptors).
 *
 * @throws When a resolved atomic value leaves its field's domain (RT-87)
 */
export function patchForUpdate(
	collection: string,
	definition: CollectionDefinition,
	currentRecord: CollectionRecord,
	allowed: Record<string, unknown>,
): UpdatePatch {
	const previousData: Record<string, unknown> = {}
	const resolved: Record<string, unknown> = {}
	const atomicOps: Record<string, AtomicOp> = {}
	for (const [key, value] of Object.entries(allowed)) {
		previousData[key] = currentRecord[key]
		if (isAtomicOp(value)) {
			resolved[key] = resolveAtomicOp(currentRecord[key], value)
			// The resolved value must be in the field's domain like any written value
			// (RT-87): `op.increment(0.5)` on a timestamp, an increment past the largest
			// finite number.
			const descriptor = definition.fields[key]
			if (descriptor) assertResolvedFieldValue(collection, key, descriptor, resolved[key])
			atomicOps[key] = toAtomicOp(value)
		} else {
			resolved[key] = value
		}
	}
	return { previousData, resolved, atomicOps }
}

/**
 * The record a delete reports: the record as it stood when it was tombstoned (what the
 * row held, read the way every read shapes it).
 */
export function tombstone(
	definition: CollectionDefinition,
	row: RawCollectionRow,
): CollectionRecord {
	return deserializeRecord(row, definition.fields)
}
