import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import {
	type SqliteTableCatalog,
	isKoraInternalColumn,
	isPostgresEnumCheckDefinition,
	sqliteConstraintRelaxationStatements,
	sqliteTableNeedsRelaxation,
} from './constraint-relaxation'
import { t } from './types'

function catalog(overrides: Partial<SqliteTableCatalog> = {}): SqliteTableCatalog {
	return {
		table: 'todos',
		sql: `CREATE TABLE "todos" (id TEXT PRIMARY KEY NOT NULL, "title" TEXT NOT NULL, "p" TEXT DEFAULT 'low' CHECK ("p" IN ('low', 'high')), _created_at INTEGER NOT NULL)`,
		columns: [
			{ cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
			{ cid: 1, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 2, name: 'p', type: 'TEXT', notnull: 0, dflt_value: "'low'", pk: 0 },
			{ cid: 3, name: '_created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
		],
		foreignKeys: [],
		uniqueConstraints: [],
		dependents: ['CREATE INDEX "idx" ON "todos" ("p")'],
		...overrides,
	}
}

describe('constraint relaxation (RT-101)', () => {
	test('Kora internal columns are id and _-prefixed', () => {
		expect(isKoraInternalColumn('id')).toBe(true)
		expect(isKoraInternalColumn('_deleted')).toBe(true)
		expect(isKoraInternalColumn('title')).toBe(false)
	})

	test('detects a CHECK or a NOT NULL schema field, ignoring quoted text', () => {
		expect(sqliteTableNeedsRelaxation(catalog())).toBe(true)
		const relaxed = catalog({
			sql: `CREATE TABLE "todos" (id TEXT PRIMARY KEY NOT NULL, "title" TEXT DEFAULT 'CHECK (x)', "CHECK (" TEXT)`,
			columns: [
				{ cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
				{ cid: 1, name: 'title', type: 'TEXT', notnull: 0, dflt_value: "'CHECK (x)'", pk: 0 },
			],
		})
		expect(sqliteTableNeedsRelaxation(relaxed)).toBe(false)
		expect(sqliteConstraintRelaxationStatements(relaxed)).toEqual([])
	})

	test('rebuild keeps keys, defaults, foreign keys, unique constraints and dependents', () => {
		const statements = sqliteConstraintRelaxationStatements(
			catalog({
				foreignKeys: [
					{
						id: 0,
						seq: 0,
						table: 'projects',
						from: 'title',
						to: 'id',
						on_update: 'NO ACTION',
						on_delete: 'SET NULL',
					},
				],
				uniqueConstraints: [['p', 'title']],
			}),
		)
		const create = statements[1] ?? ''
		expect(statements[0]).toBe('DROP TABLE IF EXISTS "_kora_relax_todos"')
		expect(create).not.toMatch(/CHECK/)
		expect(create).toContain('"id" TEXT PRIMARY KEY NOT NULL')
		expect(create).toContain('"title" TEXT REFERENCES "projects"("id") ON DELETE SET NULL')
		expect(create).not.toContain('"title" TEXT NOT NULL')
		expect(create).toContain(`"p" TEXT DEFAULT ('low')`)
		expect(create).toContain('"_created_at" INTEGER NOT NULL')
		expect(create).toContain('UNIQUE ("p", "title")')
		expect(statements.slice(2)).toEqual([
			'INSERT INTO "_kora_relax_todos" ("id", "title", "p", "_created_at") SELECT "id", "title", "p", "_created_at" FROM "todos"',
			'DROP TABLE "todos"',
			'ALTER TABLE "_kora_relax_todos" RENAME TO "todos"',
			'CREATE INDEX "idx" ON "todos" ("p")',
		])
	})

	test('Postgres: only single-column enum-shaped checks are recognised', () => {
		expect(
			isPostgresEnumCheckDefinition("CHECK ((priority = ANY (ARRAY['low'::text, 'high'::text])))"),
		).toBe(true)
		expect(isPostgresEnumCheckDefinition(`CHECK (("Priority" = ANY (ARRAY['a'::text])))`)).toBe(
			true,
		)
		expect(isPostgresEnumCheckDefinition('CHECK ((length(title) < 1000))')).toBe(false)
		expect(isPostgresEnumCheckDefinition("CHECK ((title <> 'c'::text))")).toBe(false)
	})

	test('t.enum() refuses values SQLite cannot store verbatim', () => {
		expect(() => t.enum(['ok', 'nul\u0000'])).toThrow(SchemaValidationError)
		expect(() => t.enum(['￿'])).toThrow(SchemaValidationError)
		expect(() => t.enum(['\ud800'])).toThrow(SchemaValidationError)
		expect(() => t.enum(['emoji 😀', "it's"])).not.toThrow()
	})
})
