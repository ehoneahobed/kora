import { describe, expect, test } from 'vitest'
import { t } from '../schema/types'
import { migrate } from './migration-builder'
import { migrationStepsToSQL, rollbackStepsToSQL } from './migration-sql'

describe('migrationStepsToSQL', () => {
	test('addField produces ALTER TABLE ADD COLUMN', () => {
		const steps = migrate().addField('products', 'taxInclusive', t.boolean().default(false)).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE products ADD COLUMN taxInclusive INTEGER DEFAULT 0'])
	})

	test('addField with string and no default', () => {
		const steps = migrate().addField('products', 'description', t.string().optional()).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE products ADD COLUMN description TEXT'])
	})

	test('addField with number and default', () => {
		const steps = migrate().addField('products', 'price', t.number().default(0)).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE products ADD COLUMN price REAL DEFAULT 0'])
	})

	test('addField with enum and CHECK constraint', () => {
		const steps = migrate().addField(
			'todos',
			'priority',
			t.enum(['low', 'medium', 'high']).default('medium'),
		).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual([
			"ALTER TABLE todos ADD COLUMN priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high'))",
		])
	})

	test('addField with timestamp', () => {
		const steps = migrate().addField('todos', 'dueDate', t.timestamp().optional()).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE todos ADD COLUMN dueDate INTEGER'])
	})

	test('addField with array (JSON-serialized)', () => {
		const steps = migrate().addField('todos', 'tags', t.array(t.string()).default([])).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(["ALTER TABLE todos ADD COLUMN tags TEXT DEFAULT '[]'"])
	})

	test('removeField produces ALTER TABLE DROP COLUMN', () => {
		const steps = migrate().removeField('products', 'oldField').steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE products DROP COLUMN oldField'])
	})

	test('renameField produces ALTER TABLE RENAME COLUMN', () => {
		const steps = migrate().renameField('products', 'cost', 'costPrice').steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE products RENAME COLUMN cost TO costPrice'])
	})

	test('addIndex produces CREATE INDEX IF NOT EXISTS', () => {
		const steps = migrate().addIndex('products', 'category').steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['CREATE INDEX IF NOT EXISTS idx_products_category ON products (category)'])
	})

	test('removeIndex produces DROP INDEX IF EXISTS', () => {
		const steps = migrate().removeIndex('products', 'category').steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['DROP INDEX IF EXISTS idx_products_category'])
	})

	test('backfill produces no SQL (handled at application layer)', () => {
		const steps = migrate().backfill('products', (record) => ({
			taxInclusive: (record.taxRate as number) > 0,
		})).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual([])
	})

	test('chained steps produce ordered SQL', () => {
		const steps = migrate()
			.addField('products', 'taxInclusive', t.boolean().default(false))
			.renameField('products', 'cost', 'costPrice')
			.addIndex('products', 'costPrice')
			.removeField('products', 'deprecated').steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual([
			'ALTER TABLE products ADD COLUMN taxInclusive INTEGER DEFAULT 0',
			'ALTER TABLE products RENAME COLUMN cost TO costPrice',
			'CREATE INDEX IF NOT EXISTS idx_products_costPrice ON products (costPrice)',
			'ALTER TABLE products DROP COLUMN deprecated',
		])
	})

	test('empty steps produce no SQL', () => {
		const sql = migrationStepsToSQL([])
		expect(sql).toEqual([])
	})

	test('addField with richtext (BLOB)', () => {
		const steps = migrate().addField('todos', 'notes', t.richtext()).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE todos ADD COLUMN notes BLOB'])
	})

	test('addField with boolean default true', () => {
		const steps = migrate().addField('todos', 'active', t.boolean().default(true)).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(['ALTER TABLE todos ADD COLUMN active INTEGER DEFAULT 1'])
	})

	test('addField with string default', () => {
		const steps = migrate().addField('todos', 'status', t.string().default('pending')).steps
		const sql = migrationStepsToSQL(steps)
		expect(sql).toEqual(["ALTER TABLE todos ADD COLUMN status TEXT DEFAULT 'pending'"])
	})
})

describe('rollbackStepsToSQL', () => {
	test('generates DROP COLUMN for addField rollback', () => {
		const migration = migrate().addField(
			'todos',
			'priority',
			t.enum(['low', 'medium', 'high']).default('medium'),
		)

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(['ALTER TABLE todos DROP COLUMN priority'])
	})

	test('generates ADD COLUMN for removeField rollback (with descriptor)', () => {
		const migration = migrate().removeField('todos', 'oldField', t.string().default('hello'))

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(["ALTER TABLE todos ADD COLUMN oldField TEXT DEFAULT 'hello'"])
	})

	test('generates RENAME COLUMN for renameField rollback', () => {
		const migration = migrate().renameField('products', 'cost', 'costPrice')

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(['ALTER TABLE products RENAME COLUMN costPrice TO cost'])
	})

	test('generates DROP INDEX for addIndex rollback', () => {
		const migration = migrate().addIndex('todos', 'priority')

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(['DROP INDEX IF EXISTS idx_todos_priority'])
	})

	test('generates CREATE INDEX for removeIndex rollback', () => {
		const migration = migrate().removeIndex('todos', 'priority')

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual([
			'CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos (priority)',
		])
	})

	test('skips backfill steps (handled at application layer)', () => {
		const migration = migrate().backfill(
			'products',
			() => ({ computed: true }),
			() => ({ computed: false }),
		)

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual([])
	})

	test('multi-step rollback generates SQL in reverse order', () => {
		const migration = migrate()
			.addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
			.addIndex('todos', 'priority')
			.renameField('todos', 'name', 'title')

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual([
			'ALTER TABLE todos RENAME COLUMN title TO name',
			'DROP INDEX IF EXISTS idx_todos_priority',
			'ALTER TABLE todos DROP COLUMN priority',
		])
	})

	test('uses explicit .down() steps for SQL generation', () => {
		const migration = migrate()
			.addField('todos', 'priority', t.enum(['low', 'medium', 'high']).default('medium'))
			.addIndex('todos', 'priority')
			.down((rb) => {
				rb.removeIndex('todos', 'priority').removeField('todos', 'priority')
			})

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual([
			'DROP INDEX IF EXISTS idx_todos_priority',
			'ALTER TABLE todos DROP COLUMN priority',
		])
	})

	test('empty migration produces empty rollback SQL', () => {
		const migration = migrate()
		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual([])
	})

	test('rollback addField with boolean restores correct type', () => {
		const migration = migrate().removeField('todos', 'active', t.boolean().default(true))

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(['ALTER TABLE todos ADD COLUMN active INTEGER DEFAULT 1'])
	})

	test('rollback addField with number restores correct type', () => {
		const migration = migrate().removeField('products', 'price', t.number().default(9.99))

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(['ALTER TABLE products ADD COLUMN price REAL DEFAULT 9.99'])
	})

	test('rollback addField with array restores correct type', () => {
		const migration = migrate().removeField('todos', 'tags', t.array(t.string()).default([]))

		const sql = rollbackStepsToSQL(migration)
		expect(sql).toEqual(["ALTER TABLE todos ADD COLUMN tags TEXT DEFAULT '[]'"])
	})
})
