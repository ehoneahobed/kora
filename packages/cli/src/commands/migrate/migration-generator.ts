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

	for (const [fieldName, targetDescriptor] of Object.entries(to.fields)) {
		const sourceDescriptor = from.fields[fieldName]
		if (!sourceDescriptor) continue
		if (canTransformField(sourceDescriptor, targetDescriptor)) continue

		if (targetDescriptor.required && targetDescriptor.defaultValue === undefined && !targetDescriptor.auto) {
			throw new Error(
				`Cannot auto-migrate collection "${collection}": changed required field "${fieldName}" from ${sourceDescriptor.kind} to ${targetDescriptor.kind} without a safe transform/default.`,
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

	const sourceDescriptor = fromFields[column]
	if (sourceDescriptor && targetDescriptor) {
		return projectionForFieldTransform(column, sourceDescriptor, targetDescriptor)
	}

	if (sourceDescriptor) {
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

function projectionForFieldTransform(
	column: string,
	source: FieldDescriptor,
	target: FieldDescriptor,
): string {
	const sourceColumn = quoteIdentifier(column)
	if (source.kind === target.kind && source.itemKind === target.itemKind) {
		if (target.kind === 'enum' && target.enumValues && target.enumValues.length > 0) {
			const allowed = target.enumValues.map((value) => sqlLiteral(value)).join(', ')
			const fallback =
				target.defaultValue !== undefined ? sqlLiteral(target.defaultValue) : sourceColumn
			return `CASE WHEN ${sourceColumn} IN (${allowed}) THEN ${sourceColumn} ELSE ${fallback} END`
		}
		return sourceColumn
	}

	if (target.kind === 'string') {
		return `CAST(${sourceColumn} AS TEXT)`
	}

	if (target.kind === 'number' || target.kind === 'timestamp') {
		if (
			source.kind === 'string' ||
			source.kind === 'enum' ||
			source.kind === 'number' ||
			source.kind === 'timestamp' ||
			source.kind === 'boolean'
		) {
			const castType = target.kind === 'number' ? 'REAL' : 'INTEGER'
			return `CASE WHEN ${sourceColumn} IS NULL THEN NULL ELSE CAST(${sourceColumn} AS ${castType}) END`
		}
	}

	if (target.kind === 'boolean') {
		if (source.kind === 'number' || source.kind === 'timestamp' || source.kind === 'boolean') {
			return `CASE WHEN ${sourceColumn} IS NULL THEN NULL WHEN CAST(${sourceColumn} AS REAL) = 0 THEN 0 ELSE 1 END`
		}

		if (source.kind === 'string' || source.kind === 'enum') {
			return `CASE WHEN ${sourceColumn} IS NULL THEN NULL WHEN LOWER(TRIM(CAST(${sourceColumn} AS TEXT))) IN ('1','true','t','yes','y','on') THEN 1 WHEN LOWER(TRIM(CAST(${sourceColumn} AS TEXT))) IN ('0','false','f','no','n','off') THEN 0 ELSE ${projectionFallback(target)} END`
		}
	}

	if (target.kind === 'enum' && target.enumValues && target.enumValues.length > 0) {
		if (source.kind === 'string' || source.kind === 'enum') {
			const allowed = target.enumValues.map((value) => sqlLiteral(value)).join(', ')
			return `CASE WHEN ${sourceColumn} IN (${allowed}) THEN ${sourceColumn} ELSE ${projectionFallback(target)} END`
		}
	}

	if (target.kind === 'array' && source.kind === 'array' && source.itemKind === target.itemKind) {
		return sourceColumn
	}

	if (target.auto && target.kind === 'timestamp') {
		return "CAST(strftime('%s','now') AS INTEGER) * 1000"
	}

	return projectionFallback(target)
}

function canTransformField(source: FieldDescriptor, target: FieldDescriptor): boolean {
	if (source.kind === target.kind && source.itemKind === target.itemKind) {
		return true
	}

	if (target.kind === 'string') {
		return true
	}

	if (target.kind === 'number' || target.kind === 'timestamp') {
		return (
			source.kind === 'string' ||
			source.kind === 'enum' ||
			source.kind === 'number' ||
			source.kind === 'timestamp' ||
			source.kind === 'boolean'
		)
	}

	if (target.kind === 'boolean') {
		return (
			source.kind === 'number' ||
			source.kind === 'timestamp' ||
			source.kind === 'boolean' ||
			source.kind === 'string' ||
			source.kind === 'enum'
		)
	}

	if (target.kind === 'enum') {
		return source.kind === 'string' || source.kind === 'enum'
	}

	if (target.kind === 'array') {
		return source.kind === 'array' && source.itemKind === target.itemKind
	}

	if (target.kind === 'richtext') {
		return source.kind === 'richtext'
	}

	return false
}

function projectionFallback(target: FieldDescriptor): string {
	if (target.auto && target.kind === 'timestamp') {
		return "CAST(strftime('%s','now') AS INTEGER) * 1000"
	}

	if (target.defaultValue !== undefined) {
		return sqlLiteral(target.defaultValue)
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
