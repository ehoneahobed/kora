import { describe, expect, test } from 'vitest'
import { FULL_SCHEMA, MINIMAL_SCHEMA } from '../../tests/fixtures/schemas'
import { defineSchema } from './define'
import { generateFullDDL, generateSQL } from './sql-gen'

describe('generateSQL', () => {
	test('generates CREATE TABLE for minimal collection', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)

		const createTable = stmts[0]
		expect(createTable).toContain('CREATE TABLE IF NOT EXISTS todos')
		expect(createTable).toContain('id TEXT PRIMARY KEY NOT NULL')
		expect(createTable).toContain('title TEXT NOT NULL')
		expect(createTable).toContain('_created_at INTEGER NOT NULL')
		expect(createTable).toContain('_updated_at INTEGER NOT NULL')
		expect(createTable).toContain('_deleted INTEGER NOT NULL DEFAULT 0')
	})

	test('maps field types correctly', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)
		const createTable = stmts[0] ?? ''

		expect(createTable).toContain('title TEXT NOT NULL') // string
		expect(createTable).toContain('completed INTEGER DEFAULT 0') // boolean with default(false)
		expect(createTable).toContain('assignee TEXT') // optional string
		expect(createTable).toContain('tags TEXT DEFAULT') // array with default
		expect(createTable).toContain('notes BLOB NOT NULL') // richtext (required)
		expect(createTable).toContain('due_date INTEGER') // optional timestamp
	})

	test('generates CHECK constraint for enum fields', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)
		const createTable = stmts[0] ?? ''

		expect(createTable).toContain("CHECK (priority IN ('low', 'medium', 'high'))")
	})

	test('generates CREATE INDEX statements', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)

		const indexStmts = stmts.filter((s) => s.startsWith('CREATE INDEX'))
		expect(indexStmts).toHaveLength(3)
		expect(indexStmts[0]).toContain('idx_todos_assignee')
		expect(indexStmts[1]).toContain('idx_todos_completed')
		expect(indexStmts[2]).toContain('idx_todos_due_date')
	})

	test('generates per-collection operations log table', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)

		const opsTable = stmts.find((s) => s.includes('_kora_ops_todos'))
		expect(opsTable).toBeDefined()
		expect(opsTable).toContain('id TEXT PRIMARY KEY NOT NULL')
		expect(opsTable).toContain('node_id TEXT NOT NULL')
		expect(opsTable).toContain('type TEXT NOT NULL')
		expect(opsTable).toContain('record_id TEXT NOT NULL')
		expect(opsTable).toContain('sequence_number INTEGER NOT NULL')
		expect(opsTable).toContain('causal_deps TEXT NOT NULL')
	})
})

describe('generateFullDDL', () => {
	test('includes metadata tables', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		const stmts = generateFullDDL(schema)

		expect(stmts.some((s) => s.includes('_kora_meta'))).toBe(true)
		expect(stmts.some((s) => s.includes('_kora_version_vector'))).toBe(true)
	})

	test('includes all collections', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const stmts = generateFullDDL(schema)

		expect(stmts.some((s) => s.includes('CREATE TABLE IF NOT EXISTS todos'))).toBe(true)
		expect(stmts.some((s) => s.includes('CREATE TABLE IF NOT EXISTS projects'))).toBe(true)
	})

	test('metadata tables come before collection tables', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		const stmts = generateFullDDL(schema)

		const metaIndex = stmts.findIndex((s) => s.includes('_kora_meta'))
		const todosIndex = stmts.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS todos'))

		expect(metaIndex).toBeLessThan(todosIndex)
	})
})
