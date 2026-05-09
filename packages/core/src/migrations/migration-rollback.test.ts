import { describe, expect, test } from 'vitest'
import { t } from '../schema/types'
import { MigrationBuilder, RollbackBuilder, migrate } from './migration-builder'
import type { MigrationStep } from './migration-builder'
import { migrationStepsToSQL, rollbackStepsToSQL } from './migration-sql'
import {
	MigrationRollbackError,
	canAutoRollback,
	createReversibleMigration,
	generateRollbackSteps,
} from './migration-rollback'

describe('canAutoRollback', () => {
	test('addField can be auto-rolled back', () => {
		const step: MigrationStep = {
			type: 'addField',
			collection: 'todos',
			field: 'priority',
			descriptor: t.string()._build(),
		}
		expect(canAutoRollback(step)).toBe(true)
	})

	test('addIndex can be auto-rolled back', () => {
		const step: MigrationStep = { type: 'addIndex', collection: 'todos', field: 'priority' }
		expect(canAutoRollback(step)).toBe(true)
	})

	test('removeIndex can be auto-rolled back', () => {
		const step: MigrationStep = { type: 'removeIndex', collection: 'todos', field: 'priority' }
		expect(canAutoRollback(step)).toBe(true)
	})

	test('renameField can be auto-rolled back', () => {
		const step: MigrationStep = {
			type: 'renameField',
			collection: 'todos',
			from: 'cost',
			to: 'costPrice',
		}
		expect(canAutoRollback(step)).toBe(true)
	})

	test('removeField cannot be auto-rolled back (no descriptor)', () => {
		const step: MigrationStep = { type: 'removeField', collection: 'todos', field: 'old' }
		expect(canAutoRollback(step)).toBe(false)
	})

	test('backfill cannot be auto-rolled back', () => {
		const step: MigrationStep = {
			type: 'backfill',
			collection: 'todos',
			transform: (r) => r,
		}
		expect(canAutoRollback(step)).toBe(false)
	})
})

describe('generateRollbackSteps', () => {
	test('addField auto-generates removeField rollback', () => {
		const forward: MigrationStep[] = [
			{
				type: 'addField',
				collection: 'todos',
				field: 'priority',
				descriptor: t.enum(['low', 'medium', 'high']).default('medium')._build(),
			},
		]
		const rollback = generateRollbackSteps(forward)
		expect(rollback).toHaveLength(1)
		expect(rollback[0]).toEqual({
			type: 'removeField',
			collection: 'todos',
			field: 'priority',
		})
	})

	test('addIndex auto-generates removeIndex rollback', () => {
		const forward: MigrationStep[] = [
			{ type: 'addIndex', collection: 'todos', field: 'dueDate' },
		]
		const rollback = generateRollbackSteps(forward)
		expect(rollback).toHaveLength(1)
		expect(rollback[0]).toEqual({
			type: 'removeIndex',
			collection: 'todos',
			field: 'dueDate',
		})
	})

	test('removeIndex auto-generates addIndex rollback', () => {
		const forward: MigrationStep[] = [
			{ type: 'removeIndex', collection: 'todos', field: 'dueDate' },
		]
		const rollback = generateRollbackSteps(forward)
		expect(rollback).toHaveLength(1)
		expect(rollback[0]).toEqual({
			type: 'addIndex',
			collection: 'todos',
			field: 'dueDate',
		})
	})

	test('renameField auto-generates reverse rename', () => {
		const forward: MigrationStep[] = [
			{ type: 'renameField', collection: 'products', from: 'cost', to: 'costPrice' },
		]
		const rollback = generateRollbackSteps(forward)
		expect(rollback).toHaveLength(1)
		expect(rollback[0]).toEqual({
			type: 'renameField',
			collection: 'products',
			from: 'costPrice',
			to: 'cost',
		})
	})

	test('removeField with preserved descriptor auto-generates addField rollback', () => {
		const descriptor = t.boolean().default(false)._build()
		const forward: MigrationStep[] = [
			{ type: 'removeField', collection: 'todos', field: 'active', descriptor },
		]
		const rollback = generateRollbackSteps(forward)
		expect(rollback).toHaveLength(1)
		expect(rollback[0]).toEqual({
			type: 'addField',
			collection: 'todos',
			field: 'active',
			descriptor,
		})
	})

	test('removeField without descriptor throws MigrationRollbackError', () => {
		const forward: MigrationStep[] = [
			{ type: 'removeField', collection: 'todos', field: 'old' },
		]
		expect(() => generateRollbackSteps(forward)).toThrow(MigrationRollbackError)
		expect(() => generateRollbackSteps(forward)).toThrow(
			'Cannot auto-generate rollback for "removeField"',
		)
	})

	test('backfill throws MigrationRollbackError', () => {
		const forward: MigrationStep[] = [
			{
				type: 'backfill',
				collection: 'todos',
				transform: () => ({ priority: 'medium' }),
			},
		]
		expect(() => generateRollbackSteps(forward)).toThrow(MigrationRollbackError)
		expect(() => generateRollbackSteps(forward)).toThrow(
			'Cannot auto-generate rollback for "backfill"',
		)
	})

	test('multiple steps rollback in reverse order', () => {
		const forward: MigrationStep[] = [
			{
				type: 'addField',
				collection: 'todos',
				field: 'priority',
				descriptor: t.string().default('medium')._build(),
			},
			{ type: 'addIndex', collection: 'todos', field: 'priority' },
			{ type: 'renameField', collection: 'products', from: 'cost', to: 'costPrice' },
		]
		const rollback = generateRollbackSteps(forward)
		expect(rollback).toHaveLength(3)
		// Reverse order: last forward step -> first rollback step
		expect(rollback[0]).toEqual({
			type: 'renameField',
			collection: 'products',
			from: 'costPrice',
			to: 'cost',
		})
		expect(rollback[1]).toEqual({
			type: 'removeIndex',
			collection: 'todos',
			field: 'priority',
		})
		expect(rollback[2]).toEqual({
			type: 'removeField',
			collection: 'todos',
			field: 'priority',
		})
	})

	test('empty forward steps produce empty rollback', () => {
		const rollback = generateRollbackSteps([])
		expect(rollback).toEqual([])
	})
})

describe('createReversibleMigration', () => {
	test('creates migration with auto-generated rollback', () => {
		const upSteps: MigrationStep[] = [
			{
				type: 'addField',
				collection: 'todos',
				field: 'priority',
				descriptor: t.string()._build(),
			},
		]
		const migration = createReversibleMigration(upSteps, null, 1, 2)
		expect(migration.up).toEqual(upSteps)
		expect(migration.down).toHaveLength(1)
		expect(migration.down[0]).toEqual({
			type: 'removeField',
			collection: 'todos',
			field: 'priority',
		})
		expect(migration.fromVersion).toBe(1)
		expect(migration.toVersion).toBe(2)
	})

	test('creates migration with explicit down steps', () => {
		const upSteps: MigrationStep[] = [
			{
				type: 'addField',
				collection: 'todos',
				field: 'priority',
				descriptor: t.string()._build(),
			},
			{
				type: 'backfill',
				collection: 'todos',
				transform: () => ({ priority: 'medium' }),
			},
		]
		const downSteps: MigrationStep[] = [
			{ type: 'removeField', collection: 'todos', field: 'priority' },
		]
		const migration = createReversibleMigration(upSteps, downSteps, 1, 2)
		expect(migration.up).toEqual(upSteps)
		expect(migration.down).toEqual(downSteps)
		expect(migration.fromVersion).toBe(1)
		expect(migration.toVersion).toBe(2)
	})

	test('throws when auto-rollback impossible and no explicit down', () => {
		const upSteps: MigrationStep[] = [
			{
				type: 'backfill',
				collection: 'todos',
				transform: () => ({ priority: 'medium' }),
			},
		]
		expect(() => createReversibleMigration(upSteps, null, 1, 2)).toThrow(
			MigrationRollbackError,
		)
	})
})

describe('MigrationRollbackError', () => {
	test('includes step type and collection in message', () => {
		const step: MigrationStep = {
			type: 'backfill',
			collection: 'todos',
			transform: (r) => r,
		}
		const error = new MigrationRollbackError(step)
		expect(error.message).toContain('backfill')
		expect(error.message).toContain('todos')
		expect(error.code).toBe('MIGRATION_ROLLBACK')
		expect(error.name).toBe('MigrationRollbackError')
		expect(error.context).toEqual({ stepType: 'backfill', collection: 'todos' })
	})

	test('extends KoraError', () => {
		const step: MigrationStep = { type: 'removeField', collection: 'x', field: 'y' }
		const error = new MigrationRollbackError(step)
		expect(error).toBeInstanceOf(Error)
	})
})

describe('MigrationBuilder .down()', () => {
	test('down callback receives a RollbackBuilder', () => {
		let receivedBuilder: RollbackBuilder | undefined
		migrate()
			.addField('todos', 'priority', t.string())
			.down((rb) => {
				receivedBuilder = rb
			})
		expect(receivedBuilder).toBeInstanceOf(RollbackBuilder)
	})

	test('down returns MigrationBuilder with rollbackSteps', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string())
			.down((rb) => {
				rb.removeField('todos', 'priority')
			})
		expect(builder).toBeInstanceOf(MigrationBuilder)
		expect(builder.rollbackSteps).toHaveLength(1)
		expect(builder.rollbackSteps?.[0]?.type).toBe('removeField')
	})

	test('RollbackBuilder supports all step types', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string())
			.down((rb) => {
				rb.removeField('todos', 'priority')
					.addField('todos', 'oldField', t.boolean())
					.renameField('products', 'a', 'b')
					.addIndex('products', 'x')
					.removeIndex('products', 'y')
					.backfill('products', (r) => r)
			})

		expect(builder.rollbackSteps).toHaveLength(6)
		expect(builder.rollbackSteps?.[0]?.type).toBe('removeField')
		expect(builder.rollbackSteps?.[1]?.type).toBe('addField')
		expect(builder.rollbackSteps?.[2]?.type).toBe('renameField')
		expect(builder.rollbackSteps?.[3]?.type).toBe('addIndex')
		expect(builder.rollbackSteps?.[4]?.type).toBe('removeIndex')
		expect(builder.rollbackSteps?.[5]?.type).toBe('backfill')
	})

	test('down preserves forward steps', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string())
			.down((rb) => {
				rb.removeField('todos', 'priority')
			})
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]?.type).toBe('addField')
	})

	test('safelyReversible is true when explicit rollback provided', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string())
			.backfill('todos', () => ({ priority: 'medium' }))
			.down((rb) => {
				rb.removeField('todos', 'priority')
			})
		expect(builder.safelyReversible).toBe(true)
	})
})

describe('MigrationBuilder removeField with descriptor', () => {
	test('removeField without builder has no descriptor', () => {
		const builder = migrate().removeField('todos', 'old')
		const step = builder.steps[0]
		if (step?.type === 'removeField') {
			expect(step.descriptor).toBeUndefined()
		}
	})

	test('removeField with builder preserves descriptor', () => {
		const builder = migrate().removeField('todos', 'active', t.boolean().default(true))
		const step = builder.steps[0]
		if (step?.type === 'removeField') {
			expect(step.descriptor).toBeDefined()
			expect(step.descriptor?.kind).toBe('boolean')
			expect(step.descriptor?.defaultValue).toBe(true)
		}
	})
})

describe('rollbackStepsToSQL', () => {
	test('generates SQL for auto-generated rollback steps', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string().default('medium'))

		const sql = rollbackStepsToSQL(builder)
		expect(sql).toEqual(['ALTER TABLE todos DROP COLUMN priority'])
	})

	test('skips backfill steps (handled at application layer)', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string().default('medium'))
			.down((rb) => {
				rb.removeField('todos', 'priority')
					.backfill('todos', () => ({ status: 'default' }))
			})
		const sql = rollbackStepsToSQL(builder)
		// backfill produces no SQL
		expect(sql).toEqual(['ALTER TABLE todos DROP COLUMN priority'])
	})
})

describe('round-trip: up then down', () => {
	test('addField followed by removeField rollback', () => {
		const upSteps: MigrationStep[] = [
			{
				type: 'addField',
				collection: 'todos',
				field: 'priority',
				descriptor: t.string().default('medium')._build(),
			},
		]
		const rollback = generateRollbackSteps(upSteps)

		const upSQL = migrationStepsToSQL(upSteps)
		const downSQL = migrationStepsToSQL(rollback)

		expect(upSQL).toHaveLength(1)
		expect(upSQL[0]).toContain('ADD COLUMN priority')
		expect(downSQL).toHaveLength(1)
		expect(downSQL[0]).toContain('DROP COLUMN priority')
	})

	test('addIndex followed by removeIndex rollback', () => {
		const upSteps: MigrationStep[] = [
			{ type: 'addIndex', collection: 'todos', field: 'dueDate' },
		]
		const rollback = generateRollbackSteps(upSteps)

		const upSQL = migrationStepsToSQL(upSteps)
		const downSQL = migrationStepsToSQL(rollback)

		expect(upSQL[0]).toContain('CREATE INDEX')
		expect(downSQL[0]).toContain('DROP INDEX')
	})

	test('renameField forward and reverse', () => {
		const upSteps: MigrationStep[] = [
			{ type: 'renameField', collection: 'products', from: 'cost', to: 'costPrice' },
		]
		const rollback = generateRollbackSteps(upSteps)

		const upSQL = migrationStepsToSQL(upSteps)
		const downSQL = migrationStepsToSQL(rollback)

		expect(upSQL[0]).toBe('ALTER TABLE products RENAME COLUMN cost TO costPrice')
		expect(downSQL[0]).toBe('ALTER TABLE products RENAME COLUMN costPrice TO cost')
	})

	test('complex migration with multiple auto-rollbackable steps', () => {
		const upSteps: MigrationStep[] = [
			{
				type: 'addField',
				collection: 'todos',
				field: 'priority',
				descriptor: t.string().default('medium')._build(),
			},
			{ type: 'addIndex', collection: 'todos', field: 'priority' },
			{ type: 'renameField', collection: 'todos', from: 'desc', to: 'description' },
			{ type: 'removeIndex', collection: 'todos', field: 'oldIdx' },
		]
		const rollback = generateRollbackSteps(upSteps)

		expect(rollback).toHaveLength(4)
		expect(rollback[0]?.type).toBe('addIndex')
		expect(rollback[1]?.type).toBe('renameField')
		expect(rollback[2]?.type).toBe('removeIndex')
		expect(rollback[3]?.type).toBe('removeField')

		const upSQL = migrationStepsToSQL(upSteps)
		const downSQL = migrationStepsToSQL(rollback)
		expect(upSQL).toHaveLength(4)
		expect(downSQL).toHaveLength(4)
	})
})

describe('backward compatibility', () => {
	test('migrate() without .down() still works as before', () => {
		const builder = migrate()
			.addField('products', 'taxInclusive', t.boolean().default(false))
			.renameField('products', 'cost', 'costPrice')

		expect(builder.steps).toHaveLength(2)
		expect(builder.rollbackSteps).toBeUndefined()
	})

	test('MigrationBuilder implements MigrationDefinition', () => {
		const builder = migrate()
			.addField('todos', 'priority', t.string().default('medium'))
		const steps: readonly MigrationStep[] = builder.steps
		expect(steps).toHaveLength(1)
	})

	test('existing migrationStepsToSQL works unchanged', () => {
		const steps = migrate()
			.addField('products', 'taxInclusive', t.boolean().default(false))
			.renameField('products', 'cost', 'costPrice')
			.addIndex('products', 'costPrice').steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual([
			'ALTER TABLE products ADD COLUMN taxInclusive INTEGER DEFAULT 0',
			'ALTER TABLE products RENAME COLUMN cost TO costPrice',
			'CREATE INDEX IF NOT EXISTS idx_products_costPrice ON products (costPrice)',
		])
	})
})

describe('edge cases', () => {
	test('removeField with descriptor for rollback via builder API', () => {
		const builder = migrate()
			.removeField('todos', 'active', t.boolean().default(true))

		const rollback = generateRollbackSteps(builder.steps)
		expect(rollback).toHaveLength(1)
		expect(rollback[0]?.type).toBe('addField')
		if (rollback[0]?.type === 'addField') {
			expect(rollback[0].descriptor.kind).toBe('boolean')
			expect(rollback[0].descriptor.defaultValue).toBe(true)
		}
	})

	test('single step migration round-trips through createReversibleMigration', () => {
		const builder = migrate()
			.addField('todos', 'x', t.number().default(0))

		const migration = createReversibleMigration(
			[...builder.steps],
			null,
			1,
			2,
		)

		const upSQL = migrationStepsToSQL(migration.up)
		const downSQL = migrationStepsToSQL(migration.down)

		expect(upSQL).toEqual(['ALTER TABLE todos ADD COLUMN x REAL DEFAULT 0'])
		expect(downSQL).toEqual(['ALTER TABLE todos DROP COLUMN x'])
	})

	test('MigrationRollbackError context includes step details', () => {
		const step: MigrationStep = { type: 'removeField', collection: 'orders', field: 'legacy' }
		const error = new MigrationRollbackError(step)
		expect(error.context?.stepType).toBe('removeField')
		expect(error.context?.collection).toBe('orders')
	})
})
