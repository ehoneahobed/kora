import type { FieldBuilder } from '../schema/types'
import type { FieldDescriptor } from '../types'

/**
 * A single migration step describing a schema change.
 */
export type MigrationStep =
	| { type: 'addField'; collection: string; field: string; descriptor: FieldDescriptor }
	| { type: 'removeField'; collection: string; field: string; descriptor?: FieldDescriptor }
	| { type: 'renameField'; collection: string; from: string; to: string }
	| { type: 'addIndex'; collection: string; field: string }
	| { type: 'removeIndex'; collection: string; field: string }
	| {
			type: 'backfill'
			collection: string
			transform: (record: Record<string, unknown>) => Record<string, unknown>
			/** Reverse transform for rollback. If not provided, backfill is not safely reversible. */
			reverseTransform?: (record: Record<string, unknown>) => Record<string, unknown>
	  }

/**
 * A completed migration definition containing ordered steps and optional rollback steps.
 */
export interface MigrationDefinition {
	readonly steps: readonly MigrationStep[]
	/** Explicitly defined rollback steps. If undefined, inverse steps are auto-generated. */
	readonly rollbackSteps: readonly MigrationStep[] | undefined
	/** Whether this migration can be safely rolled back. */
	readonly safelyReversible: boolean
}

/**
 * Builder for defining rollback steps explicitly.
 * Used with the `.down()` method on MigrationBuilder.
 *
 * @example
 * ```typescript
 * migrate()
 *   .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
 *   .addIndex('todos', 'priority')
 *   .down((rollback) => {
 *     rollback
 *       .removeIndex('todos', 'priority')
 *       .removeField('todos', 'priority')
 *   })
 * ```
 */
export class RollbackBuilder {
	private _steps: MigrationStep[] = []

	/**
	 * Add a field during rollback (to reverse a removeField).
	 */
	addField(collection: string, field: string, builder: FieldBuilder): RollbackBuilder {
		this._steps.push({ type: 'addField', collection, field, descriptor: builder._build() })
		return this
	}

	/**
	 * Remove a field during rollback (to reverse an addField).
	 */
	removeField(collection: string, field: string): RollbackBuilder {
		this._steps.push({ type: 'removeField', collection, field })
		return this
	}

	/**
	 * Rename a field during rollback (to reverse a renameField).
	 */
	renameField(collection: string, from: string, to: string): RollbackBuilder {
		this._steps.push({ type: 'renameField', collection, from, to })
		return this
	}

	/**
	 * Add an index during rollback (to reverse a removeIndex).
	 */
	addIndex(collection: string, field: string): RollbackBuilder {
		this._steps.push({ type: 'addIndex', collection, field })
		return this
	}

	/**
	 * Remove an index during rollback (to reverse an addIndex).
	 */
	removeIndex(collection: string, field: string): RollbackBuilder {
		this._steps.push({ type: 'removeIndex', collection, field })
		return this
	}

	/**
	 * Run a backfill during rollback (to reverse a previous backfill).
	 */
	backfill(
		collection: string,
		transform: (record: Record<string, unknown>) => Record<string, unknown>,
	): RollbackBuilder {
		this._steps.push({ type: 'backfill', collection, transform })
		return this
	}

	/**
	 * Get the accumulated rollback steps.
	 */
	_getSteps(): readonly MigrationStep[] {
		return [...this._steps]
	}
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
	readonly rollbackSteps: readonly MigrationStep[] | undefined
	readonly safelyReversible: boolean

	constructor(
		steps: readonly MigrationStep[] = [],
		rollbackSteps?: readonly MigrationStep[],
		safelyReversible?: boolean,
	) {
		this.steps = steps
		this.rollbackSteps = rollbackSteps
		// Default: safely reversible if no backfill steps without reverseTransform
		this.safelyReversible = safelyReversible ?? this._computeSafelyReversible(steps, rollbackSteps)
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
	 * Optionally accepts a field builder to preserve the descriptor for rollback.
	 * Without the descriptor, rollback of this step requires a custom `.down()`.
	 *
	 * @param collection - The collection name
	 * @param field - The field name to remove
	 * @param builder - Optional field builder preserving the type info for rollback
	 */
	removeField(collection: string, field: string, builder?: FieldBuilder): MigrationBuilder {
		const step: MigrationStep = builder
			? { type: 'removeField', collection, field, descriptor: builder._build() }
			: { type: 'removeField', collection, field }
		return new MigrationBuilder([...this.steps, step])
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
	 *
	 * @param collection - The collection name
	 * @param transform - Forward transform function
	 * @param reverseTransform - Optional reverse transform for rollback support
	 */
	backfill(
		collection: string,
		transform: (record: Record<string, unknown>) => Record<string, unknown>,
		reverseTransform?: (record: Record<string, unknown>) => Record<string, unknown>,
	): MigrationBuilder {
		return new MigrationBuilder([
			...this.steps,
			{ type: 'backfill', collection, transform, reverseTransform },
		])
	}

	/**
	 * Define explicit rollback steps for this migration.
	 * If not called, inverse steps are auto-generated from forward steps.
	 *
	 * @param fn - Function that receives a RollbackBuilder to define rollback steps
	 * @returns A new MigrationBuilder with the rollback steps attached
	 *
	 * @example
	 * ```typescript
	 * migrate()
	 *   .addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
	 *   .addIndex('todos', 'priority')
	 *   .down((rollback) => {
	 *     rollback
	 *       .removeIndex('todos', 'priority')
	 *       .removeField('todos', 'priority')
	 *   })
	 * ```
	 */
	down(fn: (rollback: RollbackBuilder) => void): MigrationBuilder {
		const rollbackBuilder = new RollbackBuilder()
		fn(rollbackBuilder)
		const rbSteps = rollbackBuilder._getSteps()
		return new MigrationBuilder(this.steps, rbSteps, true)
	}

	/**
	 * Determine if a migration is safely reversible based on its steps.
	 * A migration is not safely reversible if:
	 * - It has a backfill step without a reverseTransform and no explicit rollback
	 * - It has a removeField without a stored descriptor and no explicit rollback
	 */
	private _computeSafelyReversible(
		steps: readonly MigrationStep[],
		rollbackSteps: readonly MigrationStep[] | undefined,
	): boolean {
		// Explicit rollback steps override auto-detection
		if (rollbackSteps !== undefined) {
			return true
		}

		for (const step of steps) {
			if (step.type === 'backfill' && !step.reverseTransform) {
				return false
			}
			if (step.type === 'removeField' && !step.descriptor) {
				return false
			}
		}

		return true
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
