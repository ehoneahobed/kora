import { quoteIdent } from '../schema/quote-ident'
import { collectionIndexName, enumCheckConstraint, sqlDefaultLiteral } from '../schema/sql-gen'
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
				statements.push(
					`ALTER TABLE ${quoteIdent(step.collection)} DROP COLUMN ${quoteIdent(step.field)}`,
				)
				break
			case 'renameField':
				// SQLite 3.25+ supports RENAME COLUMN
				statements.push(
					`ALTER TABLE ${quoteIdent(step.collection)} RENAME COLUMN ${quoteIdent(step.from)} TO ${quoteIdent(step.to)}`,
				)
				break
			case 'addIndex':
				statements.push(
					`CREATE INDEX IF NOT EXISTS ${quoteIdent(collectionIndexName(step.collection, step.field))} ON ${quoteIdent(step.collection)} (${quoteIdent(step.field)})`,
				)
				break
			case 'removeIndex':
				statements.push(
					`DROP INDEX IF EXISTS ${quoteIdent(collectionIndexName(step.collection, step.field))}`,
				)
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
 * // ['DROP INDEX IF EXISTS "idx_5_todos_priority"',
 * //  'ALTER TABLE "todos" DROP COLUMN "priority"']
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
	const parts = [`ALTER TABLE ${quoteIdent(collection)} ADD COLUMN ${quoteIdent(field)}`, sqlType]

	if (descriptor.defaultValue !== undefined) {
		parts.push(`DEFAULT ${sqlDefaultLiteral(descriptor.defaultValue)}`)
	}

	if (descriptor.kind === 'enum' && descriptor.enumValues) {
		parts.push(enumCheckConstraint(field, descriptor.enumValues))
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
