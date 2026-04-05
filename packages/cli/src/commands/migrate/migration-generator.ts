import { generateSQL } from '@kora/core'
import type { CollectionDefinition, FieldDescriptor, SchemaDefinition } from '@kora/core'
import type { SchemaDiff } from './schema-differ'
import { getChangedCollections } from './schema-differ'

export interface GeneratedMigration {
	up: string[]
	down: string[]
	summary: string[]
	containsBreakingChanges: boolean
}

/**
 * Generates SQL up/down migration statements from a schema diff.
 */
export function generateMigration(
	previous: SchemaDefinition,
	current: SchemaDefinition,
	diff: SchemaDiff,
): GeneratedMigration {
	const up: string[] = []
	const down: string[] = []

	for (const change of diff.changes) {
		if (change.type === 'collection-added') {
			const collectionDef = current.collections[change.collection]
			if (!collectionDef) continue
			up.push(...generateSQL(change.collection, collectionDef))
			down.push(...dropCollectionStatements(change.collection))
		}

		if (change.type === 'collection-removed') {
			const collectionDef = previous.collections[change.collection]
			up.push(...dropCollectionStatements(change.collection))
			if (collectionDef) {
				down.push(...generateSQL(change.collection, collectionDef))
			}
		}
	}

	const changedCollections = getChangedCollections(diff).filter(
		(collection) =>
			collection in previous.collections &&
			collection in current.collections &&
			diff.changes.some(
				(change) =>
					change.collection === collection &&
					(change.type === 'field-added' ||
						change.type === 'field-removed' ||
						change.type === 'field-changed' ||
						change.type === 'index-added' ||
						change.type === 'index-removed'),
			),
	)

	for (const collection of changedCollections) {
		const previousDef = previous.collections[collection]
		const currentDef = current.collections[collection]
		if (!previousDef || !currentDef) continue

		validateRebuildSafety(collection, previousDef, currentDef)

		up.push(...generateRebuildStatements(collection, previousDef, currentDef))
		down.push(...generateRebuildStatements(collection, currentDef, previousDef))
	}

	down.reverse()

	return {
		up,
		down,
		summary: diff.changes.map(formatChange),
		containsBreakingChanges: diff.hasBreakingChanges,
	}
}

function generateRebuildStatements(
	collection: string,
	from: CollectionDefinition,
	to: CollectionDefinition,
): string[] {
	const table = quoteIdentifier(collection)
	const tempTable = quoteIdentifier(`_kora_mig_${collection}_new`)

	const targetColumns = [
		'id TEXT PRIMARY KEY NOT NULL',
		...Object.entries(to.fields).map(([field, descriptor]) => columnDefinition(field, descriptor)),
		'_created_at INTEGER NOT NULL',
		'_updated_at INTEGER NOT NULL',
		'_deleted INTEGER NOT NULL DEFAULT 0',
	]

	const statements: string[] = []
	statements.push(`CREATE TABLE ${tempTable} (\n  ${targetColumns.join(',\n  ')}\n)`)

	const toFields = Object.keys(to.fields)
	const columns = ['id', ...toFields, '_created_at', '_updated_at', '_deleted']
	const selectExpressions = columns.map((column) =>
		projectionForColumn(column, from.fields, to.fields[column] ?? null),
	)

	statements.push(
		`INSERT INTO ${tempTable} (${columns.map(quoteIdentifier).join(', ')}) SELECT ${selectExpressions.join(', ')} FROM ${table}`,
	)
	statements.push(`DROP TABLE ${table}`)
	statements.push(`ALTER TABLE ${tempTable} RENAME TO ${table}`)

	for (const indexField of to.indexes) {
		statements.push(
			`CREATE INDEX IF NOT EXISTS idx_${collection}_${indexField} ON ${table} (${quoteIdentifier(indexField)})`,
		)
	}

	return statements
}

function validateRebuildSafety(
	collection: string,
	from: CollectionDefinition,
	to: CollectionDefinition,
): void {
	for (const [fieldName, descriptor] of Object.entries(to.fields)) {
		if (fieldName in from.fields) continue
		if (descriptor.required && descriptor.defaultValue === undefined && !descriptor.auto) {
			throw new Error(
				`Cannot auto-migrate collection "${collection}": added required field "${fieldName}" has no default value.`,
			)
		}
	}
}

function projectionForColumn(
	column: string,
	fromFields: Record<string, FieldDescriptor>,
	targetDescriptor: FieldDescriptor | null,
): string {
	if (column === 'id' || column === '_created_at' || column === '_updated_at' || column === '_deleted') {
		return quoteIdentifier(column)
	}

	if (column in fromFields) {
		return quoteIdentifier(column)
	}

	if (!targetDescriptor) {
		return 'NULL'
	}

	if (targetDescriptor.auto && targetDescriptor.kind === 'timestamp') {
		return "CAST(strftime('%s','now') AS INTEGER) * 1000"
	}

	if (targetDescriptor.defaultValue !== undefined) {
		return sqlLiteral(targetDescriptor.defaultValue)
	}

	return 'NULL'
}

function dropCollectionStatements(collection: string): string[] {
	const table = quoteIdentifier(collection)
	const opsTable = quoteIdentifier(`_kora_ops_${collection}`)
	return [`DROP TABLE IF EXISTS ${table}`, `DROP TABLE IF EXISTS ${opsTable}`]
}

function columnDefinition(fieldName: string, descriptor: FieldDescriptor): string {
	const sqlType = mapFieldType(descriptor)
	const parts = [quoteIdentifier(fieldName), sqlType]

	if (descriptor.required && descriptor.defaultValue === undefined && !descriptor.auto) {
		parts.push('NOT NULL')
	}

	if (descriptor.defaultValue !== undefined) {
		parts.push(`DEFAULT ${sqlLiteral(descriptor.defaultValue)}`)
	}

	if (descriptor.kind === 'enum' && descriptor.enumValues) {
		const values = descriptor.enumValues.map((value) => sqlLiteral(value)).join(', ')
		parts.push(`CHECK (${quoteIdentifier(fieldName)} IN (${values}))`)
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
			return 'TEXT'
		case 'richtext':
			return 'BLOB'
	}
}

function sqlLiteral(value: unknown): string {
	if (value === null) return 'NULL'
	if (typeof value === 'number') return String(value)
	if (typeof value === 'boolean') return value ? '1' : '0'
	if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
	return `'${JSON.stringify(value).replaceAll("'", "''")}'`
}

function quoteIdentifier(identifier: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
		throw new Error(`Invalid SQL identifier: ${identifier}`)
	}
	return identifier
}

function formatChange(change: SchemaDiff['changes'][number]): string {
	switch (change.type) {
		case 'collection-added':
			return `+ collection ${change.collection}`
		case 'collection-removed':
			return `- collection ${change.collection}`
		case 'field-added':
			return `+ ${change.collection}.${change.field}`
		case 'field-removed':
			return `- ${change.collection}.${change.field}`
		case 'field-changed':
			return `~ ${change.collection}.${change.field}`
		case 'index-added':
			return `+ index ${change.collection}.${change.index}`
		case 'index-removed':
			return `- index ${change.collection}.${change.index}`
	}
}
