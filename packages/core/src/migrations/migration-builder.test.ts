import { describe, expect, test } from 'vitest'
import { t } from '../schema/types'
import { MigrationBuilder, migrate } from './migration-builder'

describe('migrate()', () => {
	test('returns a MigrationBuilder with no steps', () => {
		const builder = migrate()
		expect(builder).toBeInstanceOf(MigrationBuilder)
		expect(builder.steps).toEqual([])
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
		})
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
