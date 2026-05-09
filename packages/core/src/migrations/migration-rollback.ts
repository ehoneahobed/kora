import { KoraError } from '../errors/errors'
import type { FieldDescriptor } from '../types'
import type { MigrationStep } from './migration-builder'

/**
 * A migration that includes both forward (up) and backward (down) steps.
 * Rollback steps are applied in reverse order of the forward steps.
 */
export interface ReversibleMigration {
	readonly up: readonly MigrationStep[]
	readonly down: readonly MigrationStep[]
	readonly fromVersion: number
	readonly toVersion: number
}

/**
 * Error thrown when a migration step cannot be automatically rolled back
 * and no explicit down step has been provided.
 */
export class MigrationRollbackError extends KoraError {
	constructor(step: MigrationStep) {
		super(
			`Cannot auto-generate rollback for "${step.type}" step on collection "${step.collection}". Provide an explicit .down() definition for this migration.`,
			'MIGRATION_ROLLBACK',
			{ stepType: step.type, collection: step.collection },
		)
		this.name = 'MigrationRollbackError'
	}
}

/**
 * Determines whether a migration step can be automatically rolled back
 * without explicit developer-provided down steps.
 *
 * Auto-rollback is possible when the inverse operation is deterministic:
 * - addField -> removeField (drop the added column)
 * - addIndex -> removeIndex (drop the added index)
 * - removeIndex -> addIndex (re-create the index)
 * - renameField -> renameField (swap from/to names)
 *
 * Steps that CANNOT auto-rollback:
 * - removeField: the field descriptor is lost (need it to re-create the column)
 * - backfill: data transforms are not reversible
 *
 * @param step - The forward migration step to check
 * @returns true if the step can be auto-rolled back
 */
export function canAutoRollback(step: MigrationStep): boolean {
	switch (step.type) {
		case 'addField':
		case 'addIndex':
		case 'removeIndex':
		case 'renameField':
			return true
		case 'removeField':
		case 'backfill':
			return false
	}
}

/**
 * Generates rollback steps for a list of forward migration steps.
 * Steps are reversed in order (last forward step becomes first rollback step).
 *
 * For steps that cannot be auto-rolled back, throws a MigrationRollbackError.
 * Use canAutoRollback() to check before calling, or provide explicit down steps
 * via the MigrationBuilder .down() API.
 *
 * @param forwardSteps - The forward migration steps to generate rollbacks for
 * @returns Array of rollback steps in reverse execution order
 * @throws MigrationRollbackError if any step cannot be auto-rolled back
 */
export function generateRollbackSteps(forwardSteps: readonly MigrationStep[]): MigrationStep[] {
	const rollbackSteps: MigrationStep[] = []

	// Process in reverse order so rollback undoes changes in the opposite sequence
	for (let i = forwardSteps.length - 1; i >= 0; i--) {
		const step = forwardSteps[i]
		if (step === undefined) continue

		const rollback = generateSingleRollbackStep(step)
		rollbackSteps.push(rollback)
	}

	return rollbackSteps
}

/**
 * Generate the inverse of a single migration step.
 * @internal
 */
function generateSingleRollbackStep(step: MigrationStep): MigrationStep {
	switch (step.type) {
		case 'addField':
			return { type: 'removeField', collection: step.collection, field: step.field }

		case 'removeField':
			// removeField lacks the descriptor needed to re-create the column.
			// The developer must provide an explicit down step.
			if (step.descriptor) {
				return {
					type: 'addField',
					collection: step.collection,
					field: step.field,
					descriptor: step.descriptor,
				}
			}
			throw new MigrationRollbackError(step)

		case 'renameField':
			// Reverse the rename: swap from and to
			return { type: 'renameField', collection: step.collection, from: step.to, to: step.from }

		case 'addIndex':
			return { type: 'removeIndex', collection: step.collection, field: step.field }

		case 'removeIndex':
			return { type: 'addIndex', collection: step.collection, field: step.field }

		case 'backfill':
			// Backfills with a reverseTransform can be auto-reversed
			if (step.reverseTransform) {
				return {
					type: 'backfill',
					collection: step.collection,
					transform: step.reverseTransform,
				}
			}
			throw new MigrationRollbackError(step)
	}
}

/**
 * Create a ReversibleMigration from forward steps, explicit down steps, and version info.
 *
 * If explicit down steps are provided, they are used as-is.
 * If no explicit down steps are provided, auto-generation is attempted.
 *
 * @param upSteps - The forward migration steps
 * @param downSteps - Optional explicit rollback steps (overrides auto-generation)
 * @param fromVersion - The schema version before the migration
 * @param toVersion - The schema version after the migration
 * @returns A complete ReversibleMigration
 * @throws MigrationRollbackError if auto-generation fails and no explicit down steps provided
 */
export function createReversibleMigration(
	upSteps: readonly MigrationStep[],
	downSteps: readonly MigrationStep[] | null,
	fromVersion: number,
	toVersion: number,
): ReversibleMigration {
	const down = downSteps !== null ? [...downSteps] : generateRollbackSteps(upSteps)

	return {
		up: [...upSteps],
		down,
		fromVersion,
		toVersion,
	}
}
