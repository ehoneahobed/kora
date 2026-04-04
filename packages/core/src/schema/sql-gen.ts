import type { CollectionDefinition, FieldDescriptor, SchemaDefinition } from '../types'

/**
 * Generate CREATE TABLE and CREATE INDEX SQL for a single collection.
 *
 * @param collectionName - The collection name
 * @param collection - The collection definition
 * @returns An array of SQL statements (CREATE TABLE + CREATE INDEX)
 */
export function generateSQL(collectionName: string, collection: CollectionDefinition): string[] {
	const statements: string[] = []
	const columns: string[] = ['id TEXT PRIMARY KEY NOT NULL']

	for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
		columns.push(columnDefinition(fieldName, descriptor))
	}

	// Auto metadata columns
	columns.push('_created_at INTEGER NOT NULL')
	columns.push('_updated_at INTEGER NOT NULL')
	columns.push('_deleted INTEGER NOT NULL DEFAULT 0')

	statements.push(`CREATE TABLE IF NOT EXISTS ${collectionName} (\n  ${columns.join(',\n  ')}\n)`)

	// Create indexes
	for (const indexField of collection.indexes) {
		statements.push(
			`CREATE INDEX IF NOT EXISTS idx_${collectionName}_${indexField} ON ${collectionName} (${indexField})`,
		)
	}

	// Per-collection operations log table
	statements.push(
		`CREATE TABLE IF NOT EXISTS _kora_ops_${collectionName} (
  id TEXT PRIMARY KEY NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  data TEXT,
  previous_data TEXT,
  timestamp TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  causal_deps TEXT NOT NULL,
  schema_version INTEGER NOT NULL
)`,
	)

	return statements
}

/**
 * Generate the full DDL for all collections plus metadata tables.
 *
 * @param schema - The complete schema definition
 * @returns An array of all SQL statements needed to initialize the database
 */
export function generateFullDDL(schema: SchemaDefinition): string[] {
	const statements: string[] = []

	// Metadata table
	statements.push(
		'CREATE TABLE IF NOT EXISTS _kora_meta (\n' +
			'  key TEXT PRIMARY KEY NOT NULL,\n' +
			'  value TEXT NOT NULL\n' +
			')',
	)

	// Version vector table
	statements.push(
		'CREATE TABLE IF NOT EXISTS _kora_version_vector (\n' +
			'  node_id TEXT PRIMARY KEY NOT NULL,\n' +
			'  sequence_number INTEGER NOT NULL\n' +
			')',
	)

	for (const [name, collection] of Object.entries(schema.collections)) {
		statements.push(...generateSQL(name, collection))
	}

	return statements
}

function columnDefinition(fieldName: string, descriptor: FieldDescriptor): string {
	const sqlType = mapFieldType(descriptor)
	const parts = [fieldName, sqlType]

	if (descriptor.required && descriptor.defaultValue === undefined && !descriptor.auto) {
		parts.push('NOT NULL')
	}

	if (descriptor.defaultValue !== undefined) {
		parts.push(`DEFAULT ${sqlDefault(descriptor.defaultValue)}`)
	}

	// CHECK constraint for enum fields
	if (descriptor.kind === 'enum' && descriptor.enumValues) {
		const values = descriptor.enumValues.map((v) => `'${v}'`).join(', ')
		parts.push(`CHECK (${fieldName} IN (${values}))`)
	}

	return parts.join(' ')
}

function mapFieldType(descriptor: FieldDescriptor): string {
	switch (descriptor.kind) {
		case 'string':
			return 'TEXT'
		case 'number':
			return 'REAL'
		case 'boolean':
			return 'INTEGER'
		case 'enum':
			return 'TEXT'
		case 'timestamp':
			return 'INTEGER'
		case 'array':
			return 'TEXT' // JSON-serialized
		case 'richtext':
			return 'BLOB' // Yjs state
	}
}

function sqlDefault(value: unknown): string {
	if (value === null) return 'NULL'
	if (typeof value === 'string') return `'${value}'`
	if (typeof value === 'number') return String(value)
	if (typeof value === 'boolean') return value ? '1' : '0'
	// Arrays and objects are stored as JSON strings
	return `'${JSON.stringify(value)}'`
}
