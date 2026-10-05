import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import {
	type SqliteTableCatalog,
	isKoraInternalColumn,
	isKoraSqliteEnumCheck,
	isPostgresEnumCheckDefinition,
	parseEnumCheckDefinition,
	parseSqliteCheckConstraints,
	sqliteCheckReferencesColumn,
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

	test('parses column and table checks verbatim, ignoring quoted text and comments (RT-111)', () => {
		const sql = `CREATE TABLE "t" (
  id TEXT PRIMARY KEY NOT NULL, -- CHECK (not this)
  "a" TEXT DEFAULT 'CHECK (x)' CHECK ("a" IN ('x', 'y')),
  "b" REAL CONSTRAINT "b_pos" CHECK (("b" >= 0) AND ("b" < coalesce("a", 'z,)'))),
  /* CHECK (nor this) */ "CHECK (" TEXT,
  CONSTRAINT [named] CHECK (length("a") > 0),
  CHECK ("b" <> 3)
)`
		expect(parseSqliteCheckConstraints(sql)).toEqual([
			{ name: null, expression: `"a" IN ('x', 'y')`, column: 'a' },
			{ name: 'b_pos', expression: `("b" >= 0) AND ("b" < coalesce("a", 'z,)'))`, column: 'b' },
			{ name: 'named', expression: 'length("a") > 0', column: null },
			{ name: null, expression: '"b" <> 3', column: null },
		])
	})

	test('only enum checks on enum fields are Kora checks (RT-111)', () => {
		const enumCheck = { name: null, expression: `"p" IN ('low', 'high')`, column: 'p' }
		expect(isKoraSqliteEnumCheck(enumCheck, ['p'])).toBe(true)
		expect(isKoraSqliteEnumCheck(enumCheck, ['q'])).toBe(false)
		expect(isKoraSqliteEnumCheck(enumCheck)).toBe(true)
		expect(isKoraSqliteEnumCheck({ name: null, expression: '"p" >= 0', column: 'p' }, ['p'])).toBe(
			false,
		)
		expect(
			isKoraSqliteEnumCheck({ name: null, expression: `"_x" IN ('a')`, column: null }, ['_x']),
		).toBe(false)
		expect(
			sqliteCheckReferencesColumn(
				{ name: null, expression: `length("legacy") < 'legacy'`, column: null },
				new Set(['legacy']),
			),
		).toBe(true)
		expect(
			sqliteCheckReferencesColumn(
				{ name: null, expression: `"price" <> 'legacy'`, column: 'price' },
				new Set(['legacy']),
			),
		).toBe(false)
	})

	test('a table with only hand-added checks is not rebuilt; a rebuild keeps them (RT-111)', () => {
		const guarded = catalog({
			sql: `CREATE TABLE "todos" (id TEXT PRIMARY KEY NOT NULL, "title" TEXT, "p" TEXT CHECK ("p" IN ('low', 'high')), "n" REAL CHECK ("n" >= 0), _created_at INTEGER NOT NULL, CONSTRAINT "c1" CHECK (length("title") < 99))`,
			columns: [
				{ cid: 0, name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
				{ cid: 1, name: 'title', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
				{ cid: 2, name: 'p', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
				{ cid: 3, name: 'n', type: 'REAL', notnull: 0, dflt_value: null, pk: 0 },
				{ cid: 4, name: '_created_at', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
			],
		})
		// "p" is not an enum field: its IN check was added by hand.
		expect(sqliteTableNeedsRelaxation(guarded, [])).toBe(false)
		expect(sqliteConstraintRelaxationStatements(guarded, [])).toEqual([])
		// "p" is an enum field: only its check goes.
		const create = sqliteConstraintRelaxationStatements(guarded, ['p'])[1] ?? ''
		expect(create).not.toContain(`"p" IN`)
		expect(create).toContain('CHECK ("n" >= 0)')
		expect(create).toContain('CONSTRAINT "c1" CHECK (length("title") < 99)')
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

	// The definitions below are what PostgreSQL 16's pg_get_constraintdef returns for the
	// commented source (RT-108), plus SQLite's verbatim source form.
	test.each([
		// CHECK ("status" IN ('active')) on text: the single-value form
		["CHECK ((status = 'active'::text))", 'status', ['active'], false],
		["CHECK ((a = ANY (ARRAY['x'::text, 'y'::text])))", 'a', ['x', 'y'], false],
		// on varchar
		["CHECK (((b)::text = 'x'::text))", 'b', ['x'], false],
		[
			"CHECK (((b)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))",
			'b',
			['x', 'y'],
			false,
		],
		[`CHECK (("MixCase" = 'it''s'::text))`, 'MixCase', ["it's"], false],
		[
			"CHECK (((e)::text = ANY ((ARRAY['p'::character varying, 'q'::character varying])::text[]))) NOT VALID",
			'e',
			['p', 'q'],
			false,
		],
		["CHECK (((g = 'x'::text) OR (g = 'y'::text)))", 'g', ['x', 'y'], false],
		["CHECK (((h = ANY (ARRAY['x'::text, 'y'::text])) OR (h IS NULL)))", 'h', ['x', 'y'], true],
		[`CHECK ("status" IN ('a', 'b'))`, 'status', ['a', 'b'], false],
		["CHECK (((c)::bpchar = 'x'::bpchar))", 'c', ['x'], false],
		["CHECK (((v)::character varying(20) = 'x'::character varying(20)))", 'v', ['x'], false],
	])('parses the enum check %s', (definition, column, values, allowsNull) => {
		expect(parseEnumCheckDefinition(definition)).toEqual({ column, values, allowsNull })
	})

	test.each([
		"CHECK ((c <> 'x'::text))", // NOT IN ('x')
		'CHECK ((length(c) < 5))',
		"CHECK ((lower(c) = 'x'::text))",
		"CHECK (((a = 'x'::text) OR (b = 'y'::text)))",
		"CHECK (((a = 'x'::text) AND (a <> 'y'::text)))",
		"CHECK ((NOT (a = 'x'::text)))",
		'CHECK ((a = b))',
		'CHECK ((a IS NULL))',
		'CHECK ((a = 1))',
		"UNIQUE (a = 'x')",
	])('does not parse %s as an enum check', (definition) => {
		expect(parseEnumCheckDefinition(definition)).toBeNull()
	})

	test('t.enum() refuses values SQLite cannot store verbatim', () => {
		expect(() => t.enum(['ok', 'nul\u0000'])).toThrow(SchemaValidationError)
		expect(() => t.enum(['￿'])).toThrow(SchemaValidationError)
		expect(() => t.enum(['\ud800'])).toThrow(SchemaValidationError)
		expect(() => t.enum(['emoji 😀', "it's"])).not.toThrow()
	})
})
