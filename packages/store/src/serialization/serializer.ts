import { HybridLogicalClock } from '@kora/core'
import type { CollectionDefinition, FieldDescriptor, Operation } from '@kora/core'
import type { CollectionRecord, OperationRow, RawCollectionRow } from '../types'

/**
 * Serialize a JS record to SQL-compatible values for INSERT/UPDATE.
 * Transforms: boolean → 0/1, array → JSON string, richtext → kept as-is (Uint8Array).
 *
 * @param data - The record data with JS-native types
 * @param fields - The field descriptors from the schema
 * @returns An object with SQL-compatible values
 */
export function serializeRecord(
	data: Record<string, unknown>,
	fields: Record<string, FieldDescriptor>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(data)) {
		const descriptor = fields[key]
		if (!descriptor) {
			result[key] = value
			continue
		}
		result[key] = serializeValue(value, descriptor)
	}
	return result
}

/**
 * Deserialize a SQL row to JS-native types for the application layer.
 * Transforms: 0/1 → boolean, JSON string → array, strips _deleted, maps _created_at/_updated_at.
 *
 * @param row - The raw SQL row
 * @param fields - The field descriptors from the schema
 * @returns A CollectionRecord with JS-native types
 */
export function deserializeRecord(
	row: RawCollectionRow,
	fields: Record<string, FieldDescriptor>,
): CollectionRecord {
	const result: CollectionRecord = {
		id: row.id,
		createdAt: row._created_at,
		updatedAt: row._updated_at,
	}

	for (const [key, descriptor] of Object.entries(fields)) {
		const rawValue = row[key]
		if (rawValue === undefined || rawValue === null) {
			result[key] = rawValue ?? null
			continue
		}
		result[key] = deserializeValue(rawValue, descriptor)
	}

	return result
}

/**
 * Serialize an Operation to a row for the operations log table.
 *
 * @param op - The operation to serialize
 * @returns An OperationRow suitable for SQL INSERT
 */
export function serializeOperation(op: Operation): OperationRow {
	return {
		id: op.id,
		node_id: op.nodeId,
		type: op.type,
		record_id: op.recordId,
		data: op.data ? JSON.stringify(op.data) : null,
		previous_data: op.previousData ? JSON.stringify(op.previousData) : null,
		timestamp: HybridLogicalClock.serialize(op.timestamp),
		sequence_number: op.sequenceNumber,
		causal_deps: JSON.stringify(op.causalDeps),
		schema_version: op.schemaVersion,
	}
}

/**
 * Deserialize a row from the operations log table back to an Operation.
 *
 * @param row - The raw operation row from SQL
 * @returns The deserialized Operation object
 */
export function deserializeOperation(row: OperationRow): Operation {
	return {
		id: row.id,
		nodeId: row.node_id,
		type: row.type as Operation['type'],
		collection: '', // Collection name is derived from the table name by the caller
		recordId: row.record_id,
		data: row.data ? (JSON.parse(row.data) as Record<string, unknown>) : null,
		previousData: row.previous_data
			? (JSON.parse(row.previous_data) as Record<string, unknown>)
			: null,
		timestamp: HybridLogicalClock.deserialize(row.timestamp),
		sequenceNumber: row.sequence_number,
		causalDeps: JSON.parse(row.causal_deps) as string[],
		schemaVersion: row.schema_version,
	}
}

/**
 * Deserialize an operation row with collection name already known.
 */
export function deserializeOperationWithCollection(
	row: OperationRow,
	collection: string,
): Operation {
	const op = deserializeOperation(row)
	return { ...op, collection }
}

function serializeValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (value === null || value === undefined) {
		return null
	}

	switch (descriptor.kind) {
		case 'boolean':
			return value ? 1 : 0
		case 'array':
			return JSON.stringify(value)
		case 'richtext':
			// Uint8Array stored as-is (BLOB) in SQLite
			return value
		default:
			return value
	}
}

function deserializeValue(value: unknown, descriptor: FieldDescriptor): unknown {
	switch (descriptor.kind) {
		case 'boolean':
			return value === 1 || value === true
		case 'array':
			if (typeof value === 'string') {
				return JSON.parse(value) as unknown[]
			}
			return value
		case 'richtext':
			// BLOB comes back as Buffer in Node.js — convert to Uint8Array
			if (Buffer.isBuffer(value)) {
				return new Uint8Array(value)
			}
			return value
		default:
			return value
	}
}
