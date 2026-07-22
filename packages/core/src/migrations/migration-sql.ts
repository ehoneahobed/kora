import type { FieldDescriptor } from '../types'
import type { MigrationDefinition, MigrationStep } from './migration-builder'
import { generateRollbackSteps } from './migration-rollback'

/**
 * Convert migration steps to SQL statements.
 *
 * Structural steps (addField, removeField, renameField, addIndex, removeIndex)
 * produce SQL. Backfill steps are skipped (handled at the application layer
 * by reading rows and applying the transform function).
 *
 * @param steps - The migration steps from a MigrationBuilder
 * @returns Array of SQL statements for structural changes
 */
export function migrationStepsToSQL(steps: readonly MigrationStep[]): string[] {
	const statements: string[] = []

	for (const step of steps) {
		switch (step.type) {
			case 'addField':
				statements.push(addFieldSQL(step.collection, step.field, step.descriptor))
				break
			case 'removeField':
				// SQLite 3.35+ supports DROP COLUMN. For broader compat, we mark
				// the column as nullable so it can be ignored in queries.
				// Drop is preferred when available.
				statements.push(`ALTER TABLE ${step.collection} DROP COLUMN ${step.field}`)
				break
			case 'renameField':
				// SQLite 3.25+ supports RENAME COLUMN
				statements.push(`ALTER TABLE ${step.collection} RENAME COLUMN ${step.from} TO ${step.to}`)
				break
			case 'addIndex':
				statements.push(
					`CREATE INDEX IF NOT EXISTS idx_${step.collection}_${step.field} ON ${step.collection} (${step.field})`,
				)
				break
			case 'removeIndex':
				statements.push(`DROP INDEX IF EXISTS idx_${step.collection}_${step.field}`)
				break
			case 'backfill':
				// Backfills are handled by the store at runtime, not via SQL.
				break
		}
	}

	return statements
}

/**
 * Generate SQL statements to roll back a migration.
 *
 * Uses the migration's explicit rollback steps if available,
 * otherwise auto-generates inverse steps from the forward steps.
 *
 * Backfill steps in the rollback are skipped (handled at the application layer).
 *
 * @param migration - The migration definition to generate rollback SQL for
 * @returns Array of SQL statements that undo the migration's structural changes
 *
 * @example
 * ```typescript
 * const migration = migrate()
 *   .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
 *   .addIndex('todos', 'priority')
 *
 * const rollbackSQL = rollbackStepsToSQL(migration)
 * // ['DROP INDEX IF EXISTS idx_todos_priority',
 * //  'ALTER TABLE todos DROP COLUMN priority']
 * ```
 */
export function rollbackStepsToSQL(migration: MigrationDefinition): string[] {
	// Use explicit rollback steps if provided, otherwise auto-generate from forward steps
	const rollbackSteps = migration.rollbackSteps ?? generateRollbackSteps(migration.steps)
	return migrationStepsToSQL(rollbackSteps)
}

/**
 * Produce an ALTER TABLE ADD COLUMN statement for a new field.
 */
function addFieldSQL(collection: string, field: string, descriptor: FieldDescriptor): string {
	const sqlType = mapFieldType(descriptor)
	const parts = [`ALTER TABLE ${collection} ADD COLUMN ${field}`, sqlType]

	if (descriptor.defaultValue !== undefined) {
		parts.push(`DEFAULT ${sqlDefault(descriptor.defaultValue)}`)
	}

	if (descriptor.kind === 'enum' && descriptor.enumValues) {
		const values = descriptor.enumValues.map((v) => `'${v}'`).join(', ')
		parts.push(`CHECK (${field} IN (${values}))`)
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
		case 'object':
			return 'TEXT'
		case 'json':
			return 'TEXT'
		case 'blob':
			return 'TEXT'
		case 'secret':
			return 'TEXT'
		case 'richtext':
			return 'BLOB'
	}
}

function sqlDefault(value: unknown): string {
	if (value === null) return 'NULL'
	if (typeof value === 'string') return `'${value}'`
	if (typeof value === 'number') return String(value)
	if (typeof value === 'boolean') return value ? '1' : '0'
	return `'${JSON.stringify(value)}'`
}
