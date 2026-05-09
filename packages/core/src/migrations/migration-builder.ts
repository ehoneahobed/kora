import type { FieldBuilder } from '../schema/types'
import type { FieldDescriptor } from '../types'

/**
 * A single migration step describing a schema change.
 */
export type MigrationStep =
	| { type: 'addField'; collection: string; field: string; descriptor: FieldDescriptor }
	| { type: 'removeField'; collection: string; field: string }
	| { type: 'renameField'; collection: string; from: string; to: string }
	| { type: 'addIndex'; collection: string; field: string }
	| { type: 'removeIndex'; collection: string; field: string }
	| {
			type: 'backfill'
			collection: string
			transform: (record: Record<string, unknown>) => Record<string, unknown>
	  }

/**
 * A completed migration definition containing ordered steps.
 */
export interface MigrationDefinition {
	readonly steps: readonly MigrationStep[]
}

/**
 * Fluent builder for defining schema migrations.
 *
 * Each method returns a new builder instance (immutable).
 *
 * @example
 * ```typescript
 * migrate()
 *   .addField('products', 'taxInclusive', t.boolean().default(false))
 *   .renameField('products', 'cost', 'costPrice')
 *   .backfill('products', (record) => ({
 *     taxInclusive: record.taxRate > 0,
 *   }))
 * ```
 */
export class MigrationBuilder implements MigrationDefinition {
	readonly steps: readonly MigrationStep[]

	constructor(steps: readonly MigrationStep[] = []) {
		this.steps = steps
	}

	/**
	 * Add a new field to a collection.
	 * The field builder provides the type and default value.
	 */
	addField(collection: string, field: string, builder: FieldBuilder): MigrationBuilder {
		return new MigrationBuilder([
			...this.steps,
			{ type: 'addField', collection, field, descriptor: builder._build() },
		])
	}

	/**
	 * Remove a field from a collection.
	 * Note: SQLite does not support DROP COLUMN on older versions.
	 * The field is made nullable and excluded from queries.
	 */
	removeField(collection: string, field: string): MigrationBuilder {
		return new MigrationBuilder([...this.steps, { type: 'removeField', collection, field }])
	}

	/**
	 * Rename a field in a collection.
	 * Implemented as ALTER TABLE RENAME COLUMN (SQLite 3.25+).
	 */
	renameField(collection: string, from: string, to: string): MigrationBuilder {
		return new MigrationBuilder([...this.steps, { type: 'renameField', collection, from, to }])
	}

	/**
	 * Add an index on a field.
	 */
	addIndex(collection: string, field: string): MigrationBuilder {
		return new MigrationBuilder([...this.steps, { type: 'addIndex', collection, field }])
	}

	/**
	 * Remove an index on a field.
	 */
	removeIndex(collection: string, field: string): MigrationBuilder {
		return new MigrationBuilder([...this.steps, { type: 'removeIndex', collection, field }])
	}

	/**
	 * Backfill records in a collection using a transform function.
	 * The transform receives each record and returns the fields to update.
	 * Runs after structural changes (addField, renameField, etc.).
	 */
	backfill(
		collection: string,
		transform: (record: Record<string, unknown>) => Record<string, unknown>,
	): MigrationBuilder {
		return new MigrationBuilder([...this.steps, { type: 'backfill', collection, transform }])
	}
}

/**
 * Start building a migration.
 *
 * @returns A new MigrationBuilder
 *
 * @example
 * ```typescript
 * import { migrate, t } from '@korajs/core'
 *
 * const migration = migrate()
 *   .addField('products', 'taxInclusive', t.boolean().default(false))
 *   .renameField('products', 'cost', 'costPrice')
 * ```
 */
export function migrate(): MigrationBuilder {
	return new MigrationBuilder()
}
