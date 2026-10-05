import { describe, expect, test } from 'vitest'
import { FULL_SCHEMA, MINIMAL_SCHEMA } from '../../tests/fixtures/schemas'
import { defineSchema } from './define'
import {
	collectionIndexName,
	enumCheckConstraint,
	generateFullDDL,
	generateSQL,
	sqlDefaultLiteral,
	sqlStringLiteral,
} from './sql-gen'
import { t } from './types'

describe('generateSQL', () => {
	test('generates CREATE TABLE for minimal collection', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)

		const createTable = stmts[0]
		expect(createTable).toContain('CREATE TABLE IF NOT EXISTS "todos"')
		expect(createTable).toContain('id TEXT PRIMARY KEY NOT NULL')
		// Requiredness is a value-domain rule, enforced by validation only (RT-101).
		expect(createTable).toMatch(/"title" TEXT,/)
		expect(createTable).toContain('_created_at INTEGER NOT NULL')
		expect(createTable).toContain('_updated_at INTEGER NOT NULL')
		expect(createTable).toContain("_version TEXT NOT NULL DEFAULT ''")
		expect(createTable).toContain('_deleted INTEGER NOT NULL DEFAULT 0')
	})

	test('maps field types correctly', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)
		const createTable = stmts[0] ?? ''

		expect(createTable).toMatch(/"title" TEXT,/) // string (no NOT NULL, RT-101)
		expect(createTable).toContain('"completed" INTEGER DEFAULT 0') // boolean with default(false)
		expect(createTable).toContain('"assignee" TEXT') // optional string
		expect(createTable).toContain('"tags" TEXT DEFAULT') // array with default
		expect(createTable).toMatch(/"notes" BLOB,/) // richtext (required: validation only)
		expect(createTable).toContain('"due_date" INTEGER') // optional timestamp
	})

	test('generates no value-domain constraints for enum or required fields (RT-101)', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const ddl = generateSQL('todos', todos).join('\n')

		expect(ddl).not.toMatch(/CHECK/i)
		expect(ddl).toContain(`"priority" TEXT DEFAULT 'medium'`)
		// Kora's own columns keep their constraints.
		expect(ddl).toContain('_deleted INTEGER NOT NULL DEFAULT 0')
	})

	test('generates CREATE INDEX statements', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos)

		const indexStmts = stmts.filter((s) => s.startsWith('CREATE INDEX'))
		// Three schema-declared indexes plus the ops-table record_id index
		// (record-scoped lookups run on every remote apply).
		expect(indexStmts).toHaveLength(4)
		expect(indexStmts[0]).toContain('idx_5_todos_assignee')
		expect(indexStmts[1]).toContain('idx_5_todos_completed')
		expect(indexStmts[2]).toContain('idx_5_todos_due_date')
		expect(indexStmts[3]).toContain('idx_kora_ops_todos_record_id')
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

		expect(createTable).toContain('"project_id" TEXT REFERENCES "projects"(id)')
	})

	test('auto-creates index on FK field not already indexed', () => {
		const schema = defineSchema(FULL_SCHEMA)
		const todos = schema.collections.todos
		if (!todos) return
		const stmts = generateSQL('todos', todos, schema.relations)

		// project_id is not in the explicit indexes array, so an auto-index should be created
		const fkIndex = stmts.find((s) => s.includes('idx_5_todos_project_id'))
		expect(fkIndex).toBeDefined()
		expect(fkIndex).toContain('ON "todos" ("project_id")')
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
		const userIdIndexes = stmts.filter((s) => s.includes('idx_5_tasks_user_id'))
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

		expect(stmts.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "todos"'))).toBe(true)
		expect(stmts.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "projects"'))).toBe(true)
	})

	test('metadata tables come before collection tables', () => {
		const schema = defineSchema(MINIMAL_SCHEMA)
		const stmts = generateFullDDL(schema)

		const metaIndex = stmts.findIndex((s) => s.includes('_kora_meta'))
		const todosIndex = stmts.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS "todos"'))

		expect(metaIndex).toBeLessThan(todosIndex)
	})

	test('index names never collide across collections (STORE-15)', () => {
		const ab = generateSQL('a_b', {
			fields: {},
			indexes: ['c'],
			constraints: [],
			resolvers: {},
			scope: [],
		})
		const a = generateSQL('a', {
			fields: {},
			indexes: ['b_c'],
			constraints: [],
			resolvers: {},
			scope: [],
		})
		const name = (stmts: string[]) =>
			stmts.find((s) => s.startsWith('CREATE INDEX') && !s.includes('_kora_ops_'))?.split(' ')[5]
		expect(name(ab)).toBe('"idx_3_a_b_c"')
		expect(name(a)).toBe('"idx_1_a_b_c"')
		expect(collectionIndexName('a_b', 'c')).not.toBe(collectionIndexName('a', 'b_c'))
	})
})

describe('SQL literals in DDL (SEC-9b)', () => {
	test('sqlStringLiteral doubles single quotes and leaves backslashes alone', () => {
		expect(sqlStringLiteral("don't")).toBe("'don''t'")
		expect(sqlStringLiteral("''")).toBe("''''''")
		expect(sqlStringLiteral('a\\b')).toBe("'a\\b'")
	})

	test('sqlDefaultLiteral quotes strings and JSON, maps non-finite numbers to NULL', () => {
		expect(sqlDefaultLiteral("it's")).toBe("'it''s'")
		expect(sqlDefaultLiteral(["o'k"])).toBe(`'["o''k"]'`)
		expect(sqlDefaultLiteral({ a: "'" })).toBe(`'{"a":"''"}'`)
		expect(sqlDefaultLiteral(1.5)).toBe('1.5')
		expect(sqlDefaultLiteral(Number.POSITIVE_INFINITY)).toBe('NULL')
		expect(sqlDefaultLiteral(true)).toBe('1')
		expect(sqlDefaultLiteral(null)).toBe('NULL')
	})

	test('defaults (and the enum CHECK helper) with quotes cannot break out of the literal', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				notes: {
					fields: {
						status: t.string().default("x'); DROP TABLE notes; --"),
						mood: t.enum(["it's fine", 'ok']).default("it's fine"),
					},
				},
			},
		})
		const notes = schema.collections.notes
		if (!notes) throw new Error('missing collection')
		const create = generateSQL('notes', notes)[0] ?? ''
		expect(create).toContain(`DEFAULT 'x''); DROP TABLE notes; --'`)
		expect(create).toContain(`"mood" TEXT DEFAULT 'it''s fine'`)
		expect(enumCheckConstraint('m', ["a'b"])).toBe(`CHECK ("m" IN ('a''b'))`)
	})
})
