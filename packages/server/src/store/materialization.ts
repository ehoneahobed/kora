import type { CollectionDefinition, FieldDescriptor, SchemaDefinition } from '@korajs/core'

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
		let colDef = `${fieldName} ${sqlType}`
		if (descriptor.defaultValue !== undefined) {
			colDef += ` DEFAULT ${sqlDefaultLiteral(descriptor.defaultValue)}`
		}
		if (descriptor.kind === 'enum' && descriptor.enumValues) {
			const values = descriptor.enumValues.map((v) => `'${v}'`).join(', ')
			colDef += ` CHECK (${fieldName} IN (${values}))`
		}
		columns.push(colDef)
	}

	const tsType = dialect === 'postgres' ? 'BIGINT' : 'INTEGER'
	columns.push(`_created_at ${tsType} NOT NULL DEFAULT 0`)
	columns.push(`_updated_at ${tsType} NOT NULL DEFAULT 0`)
	columns.push('_deleted INTEGER NOT NULL DEFAULT 0')

	statements.push(`CREATE TABLE IF NOT EXISTS ${name} (\n  ${columns.join(',\n  ')}\n)`)

	// Safe ALTER TABLE for adding new columns to existing tables
	for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
		const sqlType = fieldTypeToSql(descriptor, dialect)
		let colDef = `${fieldName} ${sqlType}`
		if (descriptor.defaultValue !== undefined) {
			colDef += ` DEFAULT ${sqlDefaultLiteral(descriptor.defaultValue)}`
		}
		statements.push(`--kora:safe-alter\nALTER TABLE ${name} ADD COLUMN ${colDef}`)
	}

	// User-defined indexes from schema
	for (const indexField of collection.indexes) {
		statements.push(
			`CREATE INDEX IF NOT EXISTS idx_${name}_${indexField} ON ${name} (${indexField})`,
		)
	}

	// Always index _deleted for efficient soft-delete filtering
	statements.push(`CREATE INDEX IF NOT EXISTS idx_${name}__deleted ON ${name} (_deleted)`)

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

/**
 * Replay a list of operations (must be sorted by HLC order) to produce
 * the current state of a single record.
 *
 * Returns the record field data (without `id`) or null if the record was deleted
 * or never inserted.
 */
export function replayOperationsForRecord(
	ops: Array<{ type: string; data: Record<string, unknown> | null }>,
): Record<string, unknown> | null {
	let record: Record<string, unknown> | null = null
	let deleted = false

	for (const op of ops) {
		switch (op.type) {
			case 'insert':
				if (op.data) {
					record = { ...op.data }
					deleted = false
				}
				break
			case 'update':
				if (op.data) {
					record = { ...(record ?? {}), ...op.data }
					deleted = false
				}
				break
			case 'delete':
				deleted = true
				break
		}
	}

	return deleted ? null : record
}

/**
 * Serialize a field value for SQL storage.
 * Arrays become JSON strings, booleans become 0/1, etc.
 */
export function serializeFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (value === null || value === undefined) return null
	switch (descriptor.kind) {
		case 'array':
			return typeof value === 'string' ? value : JSON.stringify(value)
		case 'boolean':
			return value ? 1 : 0
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
