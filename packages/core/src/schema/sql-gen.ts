import type {
	CollectionDefinition,
	FieldDescriptor,
	RelationDefinition,
	SchemaDefinition,
} from '../types'

/**
 * Generate CREATE TABLE and CREATE INDEX SQL for a single collection.
 *
 * @param collectionName - The collection name
 * @param collection - The collection definition
 * @param relations - Optional relations for FK references
 * @returns An array of SQL statements (CREATE TABLE + CREATE INDEX)
 */
export function generateSQL(
	collectionName: string,
	collection: CollectionDefinition,
	relations?: Record<string, RelationDefinition>,
): string[] {
	const statements: string[] = []
	const columns: string[] = ['id TEXT PRIMARY KEY NOT NULL']

	// Track which fields already have indexes
	const indexedFields = new Set(collection.indexes)

	// Collect FK fields for auto-indexing
	const fkFields: string[] = []

	for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
		let colDef = columnDefinition(fieldName, descriptor)

		// Add FK reference if a relation exists for this field
		if (relations) {
			for (const rel of Object.values(relations)) {
				if (rel.from === collectionName && rel.field === fieldName) {
					colDef += ` REFERENCES ${rel.to}(id)`
					fkFields.push(fieldName)
					break
				}
			}
		}

		columns.push(colDef)
	}

	// Auto metadata columns
	columns.push('_created_at INTEGER NOT NULL')
	columns.push('_updated_at INTEGER NOT NULL')
	columns.push("_version TEXT NOT NULL DEFAULT ''")
	// Per-field last-writer HLC versions (JSON: { field -> serialized HLC }).
	// Enables deterministic, order-independent field-level LWW so concurrent
	// edits to different fields of one record never clobber each other and
	// same-field conflicts converge to the max-timestamp writer on every node.
	columns.push("_field_versions TEXT NOT NULL DEFAULT '{}'")
	columns.push('_deleted INTEGER NOT NULL DEFAULT 0')

	statements.push(`CREATE TABLE IF NOT EXISTS ${collectionName} (\n  ${columns.join(',\n  ')}\n)`)

	// Add ALTER TABLE statements so new columns are added to existing tables.
	// These are tagged with --kora:safe-alter so the runtime can ignore "duplicate column" errors.
	for (const [fieldName, descriptor] of Object.entries(collection.fields)) {
		const colDef = columnDefinition(fieldName, descriptor)
		statements.push(`--kora:safe-alter\nALTER TABLE ${collectionName} ADD COLUMN ${colDef}`)
	}
	statements.push(
		`--kora:safe-alter\nALTER TABLE ${collectionName} ADD COLUMN _version TEXT NOT NULL DEFAULT ''`,
	)
	statements.push(
		`--kora:safe-alter\nALTER TABLE ${collectionName} ADD COLUMN _field_versions TEXT NOT NULL DEFAULT '{}'`,
	)

	// Create indexes
	for (const indexField of collection.indexes) {
		statements.push(
			`CREATE INDEX IF NOT EXISTS idx_${collectionName}_${indexField} ON ${collectionName} (${indexField})`,
		)
	}

	// Auto-create indexes on FK columns not already indexed
	for (const fkField of fkFields) {
		if (!indexedFields.has(fkField)) {
			statements.push(
				`CREATE INDEX IF NOT EXISTS idx_${collectionName}_${fkField} ON ${collectionName} (${fkField})`,
			)
		}
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
	// Record-scoped lookups run on every remote apply (latest-op-for-record,
	// orphaned-op fold on out-of-order inserts) — index them.
	statements.push(
		`CREATE INDEX IF NOT EXISTS idx_kora_ops_${collectionName}_record_id ON _kora_ops_${collectionName} (record_id)`,
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

	// Sequence counters table (offline-safe sequences)
	statements.push(
		'CREATE TABLE IF NOT EXISTS _kora_sequences (\n' +
			'  name TEXT NOT NULL,\n' +
			"  scope TEXT NOT NULL DEFAULT '',\n" +
			'  node_id TEXT NOT NULL,\n' +
			'  counter INTEGER NOT NULL DEFAULT 0,\n' +
			'  PRIMARY KEY (name, scope, node_id)\n' +
			')',
	)

	// Durable outbound sync queue (survives page refresh)
	statements.push(
		'CREATE TABLE IF NOT EXISTS _kora_sync_queue (\n' +
			'  id TEXT PRIMARY KEY NOT NULL,\n' +
			'  payload TEXT NOT NULL\n' +
			')',
	)

	// Durable merge / constraint audit trail (enterprise audit export)
	statements.push(
		'CREATE TABLE IF NOT EXISTS _kora_audit_traces (\n' +
			'  id TEXT PRIMARY KEY NOT NULL,\n' +
			'  recorded_at INTEGER NOT NULL,\n' +
			'  event_type TEXT NOT NULL,\n' +
			'  collection TEXT NOT NULL,\n' +
			'  record_id TEXT NOT NULL,\n' +
			'  field TEXT NOT NULL,\n' +
			'  strategy TEXT NOT NULL,\n' +
			'  tier INTEGER NOT NULL,\n' +
			'  constraint_name TEXT,\n' +
			'  trace_json TEXT NOT NULL\n' +
			')',
	)
	statements.push(
		'CREATE INDEX IF NOT EXISTS idx_kora_audit_traces_recorded_at ON _kora_audit_traces (recorded_at)',
	)
	statements.push(
		'CREATE INDEX IF NOT EXISTS idx_kora_audit_traces_collection ON _kora_audit_traces (collection)',
	)

	for (const [name, collection] of Object.entries(schema.collections)) {
		statements.push(...generateSQL(name, collection, schema.relations))
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
		case 'object':
			return 'TEXT' // JSON-serialized structured object
		case 'json':
			return 'TEXT' // JSON-serialized dynamic-key value
		case 'blob':
			return 'TEXT' // JSON-serialized content-addressed BlobRef (bytes stored out of band)
		case 'secret':
			return 'TEXT'
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
