import { HybridLogicalClock, decodeStoredText, encodeStoredText } from '@korajs/core'
import type { CollectionDefinition, FieldDescriptor, Operation } from '@korajs/core'
import type { CollectionRecord, OperationRow, RawCollectionRow } from '../types'
import { decodeRichtext, encodeRichtext } from './richtext-serializer'

/**
 * Serialize a JS record to SQL-compatible values for INSERT/UPDATE.
 * Transforms: boolean → 0/1, array → JSON string, richtext → Yjs binary update.
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
 * Internal key used to embed atomicOps metadata in the data JSON column.
 * This avoids adding a new column to the ops table (no migration needed).
 */
const ATOMIC_OPS_KEY = '__kora_atomic_ops__'

/**
 * Internal key used to embed transactionId in the data JSON column.
 */
const TX_ID_KEY = '__kora_tx_id__'

/**
 * Internal key used to embed mutationName in the data JSON column.
 */
const MUTATION_NAME_KEY = '__kora_mutation__'

/**
 * Internal key used to embed a scope-entry insert's per-field versions (RT-27) in the
 * data JSON column, so a later fold of the record's log places each field correctly.
 */
const FIELD_VERSIONS_KEY = '__kora_field_versions__'

/**
 * Internal key used to embed the operation's content-hash version (CORE-1, protocol
 * v2) in the data JSON column. Absent means version 1. Kept in the row so id
 * verification and re-hashing (rebase, rotation, resequence) use the right version.
 */
const HASH_VERSION_KEY = '__kora_hash_version__'

/**
 * Serialize an Operation to a row for the operations log table.
 *
 * @param op - The operation to serialize
 * @returns An OperationRow suitable for SQL INSERT
 */
export function serializeOperation(op: Operation): OperationRow {
	const hasMetadata =
		op.transactionId !== undefined || op.mutationName !== undefined || op.hashVersion !== undefined
	let dataPayload: Record<string, unknown> | null = null
	if (op.data) {
		// Embed metadata in the data JSON when present
		dataPayload = { ...op.data }
		if (op.atomicOps !== undefined && Object.keys(op.atomicOps).length > 0) {
			dataPayload[ATOMIC_OPS_KEY] = op.atomicOps
		}
		if (op.transactionId !== undefined) {
			dataPayload[TX_ID_KEY] = op.transactionId
		}
		if (op.mutationName !== undefined) {
			dataPayload[MUTATION_NAME_KEY] = op.mutationName
		}
		if (op.fieldVersions !== undefined) {
			dataPayload[FIELD_VERSIONS_KEY] = op.fieldVersions
		}
		if (op.hashVersion !== undefined) {
			dataPayload[HASH_VERSION_KEY] = op.hashVersion
		}
	} else if (hasMetadata) {
		// For delete operations (data is null), we still need to store metadata
		dataPayload = {}
		if (op.transactionId !== undefined) {
			dataPayload[TX_ID_KEY] = op.transactionId
		}
		if (op.mutationName !== undefined) {
			dataPayload[MUTATION_NAME_KEY] = op.mutationName
		}
		if (op.hashVersion !== undefined) {
			dataPayload[HASH_VERSION_KEY] = op.hashVersion
		}
	}

	return {
		id: op.id,
		node_id: op.nodeId,
		type: op.type,
		record_id: op.recordId,
		data: dataPayload ? JSON.stringify(dataPayload) : null,
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
	let data: Record<string, unknown> | null = null
	let atomicOps: Record<string, unknown> | undefined
	let transactionId: string | undefined
	let mutationName: string | undefined
	let fieldVersions: Operation['fieldVersions']
	let hashVersion: Operation['hashVersion']

	if (row.data) {
		const parsed = JSON.parse(row.data) as Record<string, unknown>
		// Extract embedded metadata keys
		if (ATOMIC_OPS_KEY in parsed) {
			atomicOps = parsed[ATOMIC_OPS_KEY] as Record<string, unknown>
		}
		if (TX_ID_KEY in parsed) {
			transactionId = parsed[TX_ID_KEY] as string
		}
		if (MUTATION_NAME_KEY in parsed) {
			mutationName = parsed[MUTATION_NAME_KEY] as string
		}
		if (FIELD_VERSIONS_KEY in parsed) {
			fieldVersions = parsed[FIELD_VERSIONS_KEY] as Operation['fieldVersions']
		}
		if (HASH_VERSION_KEY in parsed) {
			hashVersion = parsed[HASH_VERSION_KEY] as Operation['hashVersion']
		}
		// Remove metadata keys from data
		const {
			[ATOMIC_OPS_KEY]: _a,
			[TX_ID_KEY]: _t,
			[MUTATION_NAME_KEY]: _m,
			[FIELD_VERSIONS_KEY]: _f,
			[HASH_VERSION_KEY]: _h,
			...rest
		} = parsed
		// An insert or update always carries data, possibly `{}` (an insert of only
		// optional fields): its id covers `{}`, so `{}` is read back, never `null`. Only a
		// delete's payload is metadata alone (RT-80).
		data = row.type !== 'delete' || Object.keys(rest).length > 0 ? rest : null
	}

	return {
		id: row.id,
		nodeId: row.node_id,
		type: row.type as Operation['type'],
		collection: '', // Collection name is derived from the table name by the caller
		recordId: row.record_id,
		data,
		previousData: row.previous_data
			? (JSON.parse(row.previous_data) as Record<string, unknown>)
			: null,
		timestamp: HybridLogicalClock.deserialize(row.timestamp),
		sequenceNumber: row.sequence_number,
		causalDeps: JSON.parse(row.causal_deps) as string[],
		schemaVersion: row.schema_version,
		...(atomicOps !== undefined ? { atomicOps: atomicOps as Operation['atomicOps'] } : {}),
		...(transactionId !== undefined ? { transactionId } : {}),
		...(mutationName !== undefined ? { mutationName } : {}),
		...(fieldVersions !== undefined ? { fieldVersions } : {}),
		...(hashVersion !== undefined ? { hashVersion } : {}),
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
		case 'object':
		case 'json':
		case 'blob':
			return JSON.stringify(value)
		case 'richtext':
			// May be a record-shaped value (string/bytes) or an op-data value
			// (tagged { $koraBytes }) — encodeRichtext accepts every form.
			return encodeRichtext(value as Parameters<typeof encodeRichtext>[0])
		default:
			// Raw string columns: SQLite binds strings as UTF-8, which cannot hold a lone
			// surrogate (stored as U+FFFD) and SQLite WASM reads TEXT up to a NUL. The
			// shared stored-text codec keeps every JS string (RT-65); JSON columns above
			// need none (JSON.stringify escapes both).
			return typeof value === 'string' && isRawTextKind(descriptor.kind)
				? encodeStoredText(value)
				: value
	}
}

/**
 * Field kinds whose column holds the raw string (the stored-text codec applies). Not
 * `enum`: its column has a `CHECK (col IN (...))` of the schema's literal values, so it
 * must hold them verbatim (an enum value SQL text cannot express is already refused by
 * the DDL).
 */
const RAW_TEXT_KINDS: ReadonlySet<string> = new Set(['string', 'secret'])

/** True for a field kind stored as a raw string, encoded with the stored-text codec. */
export function isRawTextKind(kind: string): boolean {
	return RAW_TEXT_KINDS.has(kind)
}

/**
 * Encode a filter value compared against a field's column: a raw-string field stores
 * the encoded form, and the codec is injective, so equality and `IN` stay exact.
 *
 * @param value - The value from the developer's `where`
 * @param descriptor - The field's descriptor, when the field is known
 */
export function encodeStoredFilterValue(
	value: unknown,
	descriptor: FieldDescriptor | undefined,
): unknown {
	return typeof value === 'string' && descriptor !== undefined && isRawTextKind(descriptor.kind)
		? encodeStoredText(value)
		: value
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
		case 'object':
		case 'json':
		case 'blob':
			if (typeof value === 'string') {
				return JSON.parse(value) as unknown
			}
			return value
		case 'richtext':
			return decodeRichtext(value)
		default:
			return typeof value === 'string' && isRawTextKind(descriptor.kind)
				? decodeStoredText(value)
				: value
	}
}
