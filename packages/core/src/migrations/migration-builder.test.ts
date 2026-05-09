import { describe, expect, test } from 'vitest'
import { t } from '../schema/types'
import { MigrationBuilder, RollbackBuilder, migrate } from './migration-builder'

describe('migrate()', () => {
	test('returns a MigrationBuilder with no steps', () => {
		const builder = migrate()
		expect(builder).toBeInstanceOf(MigrationBuilder)
		expect(builder.steps).toEqual([])
	})

	test('has undefined rollbackSteps by default', () => {
		const builder = migrate()
		expect(builder.rollbackSteps).toBeUndefined()
	})

	test('is safely reversible by default (no steps)', () => {
		const builder = migrate()
		expect(builder.safelyReversible).toBe(true)
	})
})

describe('MigrationBuilder', () => {
	test('addField creates an addField step with built descriptor', () => {
		const builder = migrate().addField('products', 'taxInclusive', t.boolean().default(false))
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'addField',
			collection: 'products',
			field: 'taxInclusive',
			descriptor: expect.objectContaining({
				kind: 'boolean',
				defaultValue: false,
			}),
		})
	})

	test('removeField creates a removeField step', () => {
		const builder = migrate().removeField('products', 'oldField')
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'removeField',
			collection: 'products',
			field: 'oldField',
		})
	})

	test('removeField with descriptor stores the descriptor for rollback', () => {
		const builder = migrate().removeField('products', 'oldField', t.string().default('hello'))
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'removeField',
			collection: 'products',
			field: 'oldField',
			descriptor: expect.objectContaining({
				kind: 'string',
				defaultValue: 'hello',
			}),
		})
	})

	test('renameField creates a renameField step', () => {
		const builder = migrate().renameField('products', 'cost', 'costPrice')
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'renameField',
			collection: 'products',
			from: 'cost',
			to: 'costPrice',
		})
	})

	test('addIndex creates an addIndex step', () => {
		const builder = migrate().addIndex('products', 'category')
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'addIndex',
			collection: 'products',
			field: 'category',
		})
	})

	test('removeIndex creates a removeIndex step', () => {
		const builder = migrate().removeIndex('products', 'category')
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'removeIndex',
			collection: 'products',
			field: 'category',
		})
	})

	test('backfill creates a backfill step', () => {
		const transform = (record: Record<string, unknown>) => ({
			taxInclusive: (record.taxRate as number) > 0,
		})
		const builder = migrate().backfill('products', transform)
		expect(builder.steps).toHaveLength(1)
		expect(builder.steps[0]).toEqual({
			type: 'backfill',
			collection: 'products',
			transform,
			reverseTransform: undefined,
		})
	})

	test('backfill with reverseTransform stores both transforms', () => {
		const forward = (r: Record<string, unknown>) => ({ taxInclusive: (r.taxRate as number) > 0 })
		const reverse = (r: Record<string, unknown>) => ({
			taxRate: (r.taxInclusive as boolean) ? 10 : 0,
		})

		const builder = migrate().backfill('products', forward, reverse)
		expect(builder.steps).toHaveLength(1)
		const step = builder.steps[0]
		if (step?.type === 'backfill') {
			expect(step.transform).toBe(forward)
			expect(step.reverseTransform).toBe(reverse)
		}
	})

	test('chaining produces ordered steps', () => {
		const builder = migrate()
			.addField('products', 'taxInclusive', t.boolean().default(false))
			.renameField('products', 'cost', 'costPrice')
			.addIndex('products', 'costPrice')
			.backfill('products', (record) => ({
				taxInclusive: (record.taxRate as number) > 0,
			}))

		expect(builder.steps).toHaveLength(4)
		expect(builder.steps[0]?.type).toBe('addField')
		expect(builder.steps[1]?.type).toBe('renameField')
		expect(builder.steps[2]?.type).toBe('addIndex')
		expect(builder.steps[3]?.type).toBe('backfill')
	})

	test('each method returns a new builder (immutable)', () => {
		const a = migrate()
		const b = a.addField('products', 'taxInclusive', t.boolean())
		const c = b.renameField('products', 'cost', 'costPrice')

		expect(a.steps).toHaveLength(0)
		expect(b.steps).toHaveLength(1)
		expect(c.steps).toHaveLength(2)
		expect(a).not.toBe(b)
		expect(b).not.toBe(c)
	})

	test('implements MigrationDefinition interface', () => {
		const builder = migrate().addField('todos', 'priority', t.string().default('medium'))
		// The builder satisfies MigrationDefinition since it has readonly steps
		const steps: readonly unknown[] = builder.steps
		expect(steps).toHaveLength(1)
	})

	test('addField with enum field', () => {
		const builder = migrate().addField(
			'todos',
			'priority',
			t.enum(['low', 'medium', 'high']).default('medium'),
		)
		const step = builder.steps[0]
		expect(step?.type).toBe('addField')
		if (step?.type === 'addField') {
			expect(step.descriptor.kind).toBe('enum')
			expect(step.descriptor.enumValues).toEqual(['low', 'medium', 'high'])
			expect(step.descriptor.defaultValue).toBe('medium')
		}
	})

	test('addField with optional string', () => {
		const builder = migrate().addField('todos', 'notes', t.string().optional())
		const step = builder.steps[0]
		if (step?.type === 'addField') {
			expect(step.descriptor.required).toBe(false)
		}
	})

	test('addField with array field', () => {
		const builder = migrate().addField('todos', 'tags', t.array(t.string()).default([]))
		const step = builder.steps[0]
		if (step?.type === 'addField') {
			expect(step.descriptor.kind).toBe('array')
			expect(step.descriptor.itemKind).toBe('string')
			expect(step.descriptor.defaultValue).toEqual([])
		}
	})
})

describe('MigrationBuilder.down()', () => {
	test('attaches explicit rollback steps', () => {
		const migration = migrate()
			.addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
			.addIndex('todos', 'priority')
			.down((rollback) => {
				rollback.removeIndex('todos', 'priority').removeField('todos', 'priority')
			})

		expect(migration.rollbackSteps).toBeDefined()
		expect(migration.rollbackSteps).toHaveLength(2)
		expect(migration.rollbackSteps?.[0]).toEqual({
			type: 'removeIndex',
			collection: 'todos',
			field: 'priority',
		})
		expect(migration.rollbackSteps?.[1]).toEqual({
			type: 'removeField',
			collection: 'todos',
			field: 'priority',
		})
	})

	test('down() returns a new builder (immutable)', () => {
		const a = migrate().addField('todos', 'priority', t.string())
		const b = a.down((rb) => {
			rb.removeField('todos', 'priority')
		})

		expect(a.rollbackSteps).toBeUndefined()
		expect(b.rollbackSteps).toBeDefined()
		expect(a).not.toBe(b)
	})

	test('down() preserves forward steps', () => {
		const migration = migrate()
			.addField('todos', 'priority', t.string())
			.addIndex('todos', 'priority')
			.down((rb) => {
				rb.removeIndex('todos', 'priority')
			})

		expect(migration.steps).toHaveLength(2)
		expect(migration.steps[0]?.type).toBe('addField')
		expect(migration.steps[1]?.type).toBe('addIndex')
	})

	test('down() marks migration as safely reversible', () => {
		const migration = migrate()
			.removeField('todos', 'x') // no descriptor = normally not reversible
			.down((rb) => {
				rb.addField('todos', 'x', t.string())
			})

		expect(migration.safelyReversible).toBe(true)
	})
})

describe('MigrationBuilder.safelyReversible', () => {
	test('addField only is safely reversible', () => {
		expect(migrate().addField('todos', 'x', t.string()).safelyReversible).toBe(true)
	})

	test('removeField without descriptor is not safely reversible', () => {
		expect(migrate().removeField('todos', 'x').safelyReversible).toBe(false)
	})

	test('removeField with descriptor is safely reversible', () => {
		expect(migrate().removeField('todos', 'x', t.string()).safelyReversible).toBe(true)
	})

	test('backfill without reverseTransform is not safely reversible', () => {
		expect(
			migrate().backfill('products', () => ({ computed: true })).safelyReversible,
		).toBe(false)
	})

	test('backfill with reverseTransform is safely reversible', () => {
		expect(
			migrate().backfill(
				'products',
				() => ({ computed: true }),
				() => ({ computed: false }),
			).safelyReversible,
		).toBe(true)
	})

	test('renameField is always safely reversible', () => {
		expect(migrate().renameField('todos', 'a', 'b').safelyReversible).toBe(true)
	})

	test('addIndex is always safely reversible', () => {
		expect(migrate().addIndex('todos', 'x').safelyReversible).toBe(true)
	})

	test('removeIndex is always safely reversible', () => {
		expect(migrate().removeIndex('todos', 'x').safelyReversible).toBe(true)
	})
})

describe('RollbackBuilder', () => {
	test('addField creates correct step', () => {
		const rb = new RollbackBuilder()
		rb.addField('todos', 'x', t.string().default('hello'))
		const steps = rb._getSteps()

		expect(steps).toHaveLength(1)
		expect(steps[0]).toEqual({
			type: 'addField',
			collection: 'todos',
			field: 'x',
			descriptor: expect.objectContaining({ kind: 'string', defaultValue: 'hello' }),
		})
	})

	test('removeField creates correct step', () => {
		const rb = new RollbackBuilder()
		rb.removeField('todos', 'x')
		const steps = rb._getSteps()

		expect(steps).toHaveLength(1)
		expect(steps[0]).toEqual({
			type: 'removeField',
			collection: 'todos',
			field: 'x',
		})
	})

	test('renameField creates correct step', () => {
		const rb = new RollbackBuilder()
		rb.renameField('todos', 'b', 'a')
		const steps = rb._getSteps()

		expect(steps).toHaveLength(1)
		expect(steps[0]).toEqual({
			type: 'renameField',
			collection: 'todos',
			from: 'b',
			to: 'a',
		})
	})

	test('addIndex creates correct step', () => {
		const rb = new RollbackBuilder()
		rb.addIndex('todos', 'x')
		const steps = rb._getSteps()

		expect(steps).toHaveLength(1)
		expect(steps[0]).toEqual({ type: 'addIndex', collection: 'todos', field: 'x' })
	})

	test('removeIndex creates correct step', () => {
		const rb = new RollbackBuilder()
		rb.removeIndex('todos', 'x')
		const steps = rb._getSteps()

		expect(steps).toHaveLength(1)
		expect(steps[0]).toEqual({ type: 'removeIndex', collection: 'todos', field: 'x' })
	})

	test('backfill creates correct step', () => {
		const transform = () => ({ x: 1 })
		const rb = new RollbackBuilder()
		rb.backfill('todos', transform)
		const steps = rb._getSteps()

		expect(steps).toHaveLength(1)
		expect(steps[0]).toEqual({ type: 'backfill', collection: 'todos', transform })
	})

	test('chaining works', () => {
		const rb = new RollbackBuilder()
		rb.removeIndex('todos', 'priority')
			.removeField('todos', 'priority')
			.addField('todos', 'old', t.string())
		const steps = rb._getSteps()

		expect(steps).toHaveLength(3)
		expect(steps[0]?.type).toBe('removeIndex')
		expect(steps[1]?.type).toBe('removeField')
		expect(steps[2]?.type).toBe('addField')
	})

	test('_getSteps returns a copy (not a reference)', () => {
		const rb = new RollbackBuilder()
		rb.addField('todos', 'x', t.string())
		const steps1 = rb._getSteps()
		const steps2 = rb._getSteps()

		expect(steps1).toEqual(steps2)
		expect(steps1).not.toBe(steps2)
	})
})
