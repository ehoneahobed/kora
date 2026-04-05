import { describe, expect, test } from 'vitest'
import { FULL_SCHEMA, MINIMAL_SCHEMA } from '../../tests/fixtures/schemas'
import { defineSchema } from './define'
import { generateFullDDL, generateSQL } from './sql-gen'
import { t } from './types'

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

	test('adds REFERENCES for FK fields when relations provided', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos, schema.relations)
		const createTable = stmts[0] ?? ''

		expect(createTable).toContain('project_id TEXT REFERENCES projects(id)')
	})

	test('auto-creates index on FK field not already indexed', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos, schema.relations)

		// project_id is not in the explicit indexes array, so an auto-index should be created
		const fkIndex = stmts.find((s) => s.includes('idx_todos_project_id'))
		expect(fkIndex).toBeDefined()
		expect(fkIndex).toContain('ON todos (project_id)')
	})

	test('does not duplicate index for FK field already indexed', () => {
		// Create a schema where the FK field is also in the indexes array
		const schemaInput = {
			version: 1,
			collections: {
				tasks: {
					fields: {
						title: t.string(),
						user_id: t.string(),
					},
					indexes: ['user_id'],
				},
				users: {
					fields: {
						name: t.string(),
					},
				},
			},
			relations: {
				taskBelongsToUser: {
					from: 'tasks' as const,
					to: 'users' as const,
					type: 'many-to-one' as const,
					field: 'user_id',
					onDelete: 'cascade' as const,
				},
			},
		}
		const schema = defineSchema(schemaInput)
		const tasks = schema.collections.tasks
		if (!tasks) return
		const stmts = generateSQL('tasks', tasks, schema.relations)

		// Count how many index statements reference user_id
		const userIdIndexes = stmts.filter((s) => s.includes('idx_tasks_user_id'))
		expect(userIdIndexes).toHaveLength(1) // Only the explicit one, no duplicate
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
