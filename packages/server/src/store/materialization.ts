import { StorageError, quoteIdent, replayOperationsForRecord } from '@korajs/core'
import type {
	CollectionDefinition,
	FieldDescriptor,
	ReplayOperation,
	SchemaDefinition,
} from '@korajs/core'

// Re-exported so existing server-internal imports keep working; the implementation
// now lives in @korajs/core so the client apply pipeline and the server materialize
// records through the exact same atomic-aware fold.
export { replayOperationsForRecord }
export type { ReplayOperation }

/**
 * SQL dialect for DDL generation.
 * SQLite and PostgreSQL differ in some column types.
 */
export type SqlDialect = 'sqlite' | 'postgres'

/**
 * Map a Kora field kind to its SQL column type for the given dialect.
 */
function fieldTypeToSql(descriptor: FieldDescriptor, dialect: SqlDialect): string {
	switch (descriptor.kind) {
		case 'string':
			return 'TEXT'
		case 'number':
			return dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'
		case 'boolean':
			return 'INTEGER'
		case 'enum':
			return 'TEXT'
		case 'timestamp':
			return dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
		case 'array':
			return dialect === 'postgres' ? 'JSONB' : 'TEXT'
		case 'object':
			return dialect === 'postgres' ? 'JSONB' : 'TEXT'
		case 'json':
			return dialect === 'postgres' ? 'JSONB' : 'TEXT'
		case 'blob':
			// Content-addressed BlobRef metadata is stored as JSON; the bytes live
			// out of band, so the column is textual, not binary.
			return 'TEXT'
		case 'secret':
			return 'TEXT'
		case 'richtext':
			return dialect === 'postgres' ? 'BYTEA' : 'BLOB'
	}
}

function sqlDefaultLiteral(value: unknown): string {
	if (value === null) return 'NULL'
	if (typeof value === 'string') return `'${value}'`
	if (typeof value === 'number') return String(value)
	if (typeof value === 'boolean') return value ? '1' : '0'
	return `'${JSON.stringify(value)}'`
}

/**
 * Generate DDL statements for creating a materialized collection table.
 * Includes CREATE TABLE, safe ALTER TABLE for schema evolution, and indexes.
 *
 * @param name - Collection/table name
 * @param collection - Collection definition from the schema
 * @param dialect - SQL dialect ('sqlite' or 'postgres')
 * @returns Array of DDL SQL strings
 */
export function generateCollectionDDL(
	name: string,
	collection: CollectionDefinition,
	dialect: SqlDialect,
): string[] {
	const statements: string[] = []
	const columns: string[] = ['id TEXT PRIMARY KEY NOT NULL']

	for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
		const sqlType = fieldTypeToSql(descriptor, dialect)
		let colDef = `${quoteIdent(fieldName)} ${sqlType}`
		if (descriptor.defaultValue !== undefined) {
			colDef += ` DEFAULT ${sqlDefaultLiteral(descriptor.defaultValue)}`
		}
		if (descriptor.kind === 'enum' && descriptor.enumValues) {
			const values = descriptor.enumValues.map((v) => `'${v}'`).join(', ')
			colDef += ` CHECK (${quoteIdent(fieldName)} IN (${values}))`
		}
		columns.push(colDef)
	}

	const tsType = dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
	columns.push(`_created_at ${tsType} NOT NULL DEFAULT 0`)
	columns.push(`_updated_at ${tsType} NOT NULL DEFAULT 0`)
	columns.push('_deleted INTEGER NOT NULL DEFAULT 0')

	statements.push(`CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} (\n  ${columns.join(',\n  ')}\n)`)

	// Safe ALTER TABLE for adding new columns to existing tables
	for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
		const sqlType = fieldTypeToSql(descriptor, dialect)
		let colDef = `${quoteIdent(fieldName)} ${sqlType}`
		if (descriptor.defaultValue !== undefined) {
			colDef += ` DEFAULT ${sqlDefaultLiteral(descriptor.defaultValue)}`
		}
		statements.push(`--kora:safe-alter\nALTER TABLE ${quoteIdent(name)} ADD COLUMN ${colDef}`)
	}

	// User-defined indexes from schema. The index NAME stays unquoted (only ever
	// created/dropped by this construction); the table and column are quoted.
	for (const indexField of collection.indexes) {
		statements.push(
			`CREATE INDEX IF NOT EXISTS idx_${name}_${indexField} ON ${quoteIdent(name)} (${quoteIdent(indexField)})`,
		)
	}

	// Always index _deleted for efficient soft-delete filtering
	statements.push(
		`CREATE INDEX IF NOT EXISTS idx_${name}__deleted ON ${quoteIdent(name)} (_deleted)`,
	)

	return statements
}

/**
 * Generate all collection table DDL from a full schema.
 */
export function generateAllCollectionDDL(schema: SchemaDefinition, dialect: SqlDialect): string[] {
	const statements: string[] = []
	for (const [name, collection] of Object.entries(schema.collections)) {
		statements.push(...generateCollectionDDL(name, collection, dialect))
	}
	return statements
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_REVERSE: ReadonlyMap<string, number> = new Map(
	Array.from(BASE64_ALPHABET, (char, index) => [char, index]),
)

function base64ToBytes(base64: string): Uint8Array {
	const cleaned = base64.replace(/=+$/, '')
	const out = new Uint8Array(Math.floor((cleaned.length * 6) / 8))
	let buffer = 0
	let bits = 0
	let index = 0
	for (const char of cleaned) {
		const value = BASE64_REVERSE.get(char)
		if (value === undefined) {
			throw new StorageError(`Invalid base64 character "${char}" in tagged richtext value`, {
				char,
			})
		}
		buffer = (buffer << 6) | value
		bits += 6
		if (bits >= 8) {
			bits -= 8
			out[index] = (buffer >> bits) & 0xff
			index += 1
		}
	}
	return out
}

/**
 * Decode a richtext op-data value to something a BLOB/BYTEA column accepts.
 * Client operations carry binary richtext as the canonical tagged
 * `{ $koraBytes: base64 }` form (raw bytes cannot survive the JSON `dataJson`
 * wire field). The server cannot import the store package (dependency rules),
 * so the tiny base64 decode is duplicated here rather than shared.
 * Strings and byte views pass through unchanged.
 */
function decodeRichtextColumnValue(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) {
		return value
	}
	const record = value as Record<string, unknown>
	if (Object.keys(record).length === 1 && typeof record.$koraBytes === 'string') {
		return base64ToBytes(record.$koraBytes)
	}
	// Pre-fix operations serialized raw Uint8Arrays as numeric-key objects;
	// reconstruct the bytes so old dev databases keep materializing.
	const keys = Object.keys(record)
	if (keys.length > 0 && keys.every((k, i) => k === String(i) && typeof record[k] === 'number')) {
		const bytes = new Uint8Array(keys.length)
		for (let i = 0; i < keys.length; i++) {
			const byte = record[String(i)]
			bytes[i] = typeof byte === 'number' ? byte & 0xff : 0
		}
		return bytes
	}
	return value
}

/**
 * Serialize a field value for SQL storage.
 * Arrays become JSON strings, booleans become 0/1, etc.
 */
export function serializeFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (value === null || value === undefined) return null
	switch (descriptor.kind) {
		case 'array':
		case 'object':
		case 'json':
		case 'blob':
			return typeof value === 'string' ? value : JSON.stringify(value)
		case 'boolean':
			return value ? 1 : 0
		case 'richtext':
			return decodeRichtextColumnValue(value)
		default:
			return value
	}
}

/**
 * Deserialize a field value from SQL storage back to JavaScript types.
 */
export function deserializeFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (value === null || value === undefined) return null
	switch (descriptor.kind) {
		case 'array':
		case 'object':
		case 'json':
		case 'blob':
			return typeof value === 'string' ? JSON.parse(value) : value
		case 'boolean':
			return value === 1 || value === true
		default:
			return value
	}
}

/**
 * Validate that a field name is a valid column in the given collection schema.
 * Includes system fields (id, _created_at, _updated_at, _deleted).
 */
export function validateFieldName(
	collectionName: string,
	fieldName: string,
	schema: SchemaDefinition,
): void {
	const collection = schema.collections[collectionName]
	if (!collection) {
		throw new Error(`Unknown collection: ${collectionName}`)
	}
	const validFields = new Set([
		'id',
		'_created_at',
		'_updated_at',
		'_deleted',
		...Object.keys(collection.fields),
	])
	if (!validFields.has(fieldName)) {
		throw new Error(
			`Invalid field name "${fieldName}" for collection "${collectionName}". ` +
				`Valid fields: ${Array.from(validFields).join(', ')}`,
		)
	}
}
