import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { defineSchema, generateFullDDL, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { generateMigration } from './migration-generator'
import { runMigration } from './migration-runner'
import { diffSchemas } from './schema-differ'
import {
	EVOLVE_TABLE_DIRECTIVE,
	type EvolveTableTarget,
	expandEvolveTableForSqlite,
	formatEvolveTableDirective,
	parseEvolveTableDirective,
} from './table-evolution-directive'

const v1 = defineSchema({
	version: 1,
	collections: {
		lists: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				done: t.string().optional(),
				score: t.string().optional(),
				legacy: t.string().optional(),
				listId: t.string().optional(),
			},
			indexes: ['legacy', 'title'],
		},
	},
	relations: {
		todoList: { from: 'todos', to: 'lists', type: 'many-to-one', field: 'listId' },
	},
})

const v2 = defineSchema({
	version: 2,
	collections: {
		lists: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().optional(),
				score: t.number().optional(),
				listId: t.string().optional(),
				status: t.string().default('open'),
				seenAt: t.timestamp().auto(),
			},
			indexes: ['title', 'status'],
		},
	},
	relations: {
		todoList: { from: 'todos', to: 'lists', type: 'many-to-one', field: 'listId' },
	},
})

/** A client store's table: the schema DDL plus `_version` / `_field_versions` and FKs. */
function createClientDatabase(path: string): void {
	const db = new Database(path)
	for (const statement of generateFullDDL(v1)) {
		if (!statement.startsWith('--kora:safe-alter')) db.exec(statement)
	}
	db.exec("INSERT INTO lists (id, name, _created_at, _updated_at) VALUES ('l1', 'L', 1, 1)")
	db.exec(
		`INSERT INTO todos (id, title, done, score, legacy, listId, _created_at, _updated_at, _version, _field_versions)
		VALUES ('t1', 'a', 'yes', '12.5', 'x', 'l1', 1, 2, 'v-t1', '{"title":"v-t1"}'),
		       ('t2', 'b', 'off', 'n/a', NULL, NULL, 3, 4, 'v-t2', '{}')`,
	)
	db.close()
}

describe('evolve-table directive (RT-105)', () => {
	test('parse round-trips and refuses a malformed directive', () => {
		const target: EvolveTableTarget = {
			table: 'todos',
			add: { a: { kind: 'string', default: "it's" } },
			drop: ['b'],
			change: { c: { from: { kind: 'string' }, to: { kind: 'number' } } },
			addIndexes: ['a'],
			removeIndexes: [],
		}
		expect(parseEvolveTableDirective(formatEvolveTableDirective(target))).toEqual(target)
		expect(parseEvolveTableDirective('ALTER TABLE x ADD COLUMN y TEXT')).toBeNull()
		expect(() => parseEvolveTableDirective(`${EVOLVE_TABLE_DIRECTIVE} {"table":"x"}`)).toThrow(
			/Malformed migration directive/,
		)
	})

	describe('--apply on SQLite', () => {
		let tempDir: { path: string; cleanup: () => Promise<void> }
		beforeEach(async () => {
			tempDir = await createTempDir()
		})
		afterEach(async () => {
			await tempDir.cleanup()
		})

		test('changes only the named fields and indexes; internal columns, FKs and other indexes stay', async () => {
			const dbPath = join(tempDir.path, 'app.db')
			createClientDatabase(dbPath)
			const before = new Database(dbPath, { readonly: true })
			const otherIndexes = before
				.prepare(
					"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL AND sql NOT LIKE '%\"legacy\"%' ORDER BY name",
				)
				.all()
			before.close()

			const generated = generateMigration(v1, v2, diffSchemas(v1, v2))
			await runMigration({
				sqlitePath: dbPath,
				migrationId: '001-v1-to-v2',
				fromVersion: 1,
				toVersion: 2,
				upStatements: generated.up,
			})

			const db = new Database(dbPath, { readonly: true })
			const rows = db
				.prepare(
					'SELECT id, title, done, score, status, seenAt, listId, _version, _field_versions, _created_at FROM todos ORDER BY id',
				)
				.all() as Array<Record<string, unknown>>
			expect(rows.map(({ seenAt: _s, ...row }) => row)).toEqual([
				{
					id: 't1',
					title: 'a',
					done: 1,
					score: 12.5,
					status: 'open',
					listId: 'l1',
					_version: 'v-t1',
					_field_versions: '{"title":"v-t1"}',
					_created_at: 1,
				},
				{
					id: 't2',
					title: 'b',
					done: 0,
					score: 0,
					status: 'open',
					listId: null,
					_version: 'v-t2',
					_field_versions: '{}',
					_created_at: 3,
				},
			])
			expect(rows.every((row) => typeof row.seenAt === 'number' && row.seenAt > 0)).toBe(true)
			const columns = (
				db.prepare("SELECT name, type FROM pragma_table_info('todos')").all() as Array<{
					name: string
					type: string
				}>
			).map((c) => `${c.name}:${c.type}`)
			expect(columns).not.toContain('legacy:TEXT')
			expect(columns).toEqual(
				expect.arrayContaining(['done:INTEGER', 'score:REAL', '_version:TEXT', '_deleted:INTEGER']),
			)
			expect(
				db.prepare('SELECT "from", "table" FROM pragma_foreign_key_list(\'todos\')').all(),
			).toEqual([{ from: 'listId', table: 'lists' }])
			const indexes = db
				.prepare(
					"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'todos' AND sql IS NOT NULL ORDER BY name",
				)
				.all() as Array<{ name: string; sql: string }>
			expect(indexes.filter((index) => index.name !== 'idx_todos_status')).toEqual(otherIndexes)
			expect(indexes.map((index) => index.name)).toContain('idx_todos_status')

			// Expanding the directive again finds nothing left to do.
			const query = async (text: string) => db.prepare(text).all() as Array<Record<string, unknown>>
			for (const statement of generated.up) {
				const target = parseEvolveTableDirective(statement)
				if (target) expect(await expandEvolveTableForSqlite(target, query, 0)).toEqual([])
			}
			db.close()
		})

		test('the inverse migration restores the previous shape and keeps internal columns', async () => {
			const dbPath = join(tempDir.path, 'app.db')
			createClientDatabase(dbPath)
			const generated = generateMigration(v1, v2, diffSchemas(v1, v2))
			const base = { sqlitePath: dbPath, fromVersion: 1, toVersion: 2 }
			await runMigration({ ...base, migrationId: 'up', upStatements: generated.up })
			await runMigration({ ...base, migrationId: 'down', upStatements: generated.down })
			const db = new Database(dbPath, { readonly: true })
			const columns = (
				db.prepare("SELECT name FROM pragma_table_info('todos')").all() as Array<{ name: string }>
			).map((c) => c.name)
			expect(columns).toEqual(expect.arrayContaining(['legacy', 'done', '_version']))
			expect(columns).not.toContain('status')
			expect(
				db.prepare('SELECT id, _version, _field_versions FROM todos ORDER BY id').all(),
			).toEqual([
				{ id: 't1', _version: 'v-t1', _field_versions: '{"title":"v-t1"}' },
				{ id: 't2', _version: 'v-t2', _field_versions: '{}' },
			])
			db.close()
		})

		test('refuses to drop a Kora column', async () => {
			const dbPath = join(tempDir.path, 'app.db')
			createClientDatabase(dbPath)
			const directive = formatEvolveTableDirective({
				table: 'todos',
				add: {},
				drop: ['_version'],
				change: {},
				addIndexes: [],
				removeIndexes: [],
			})
			await expect(
				runMigration({ sqlitePath: dbPath, migrationId: 'bad', upStatements: [directive] }),
			).rejects.toThrow(/refuses to drop Kora's own column "_version"/)
		})
	})

	const pgUrl = process.env.KORA_PG_TEST_URL
	test.skipIf(!pgUrl)(
		'--apply on Postgres keeps server column types and converts kinds',
		async () => {
			const requireFromServer = createRequire(resolve(__dirname, '../../../../server/package.json'))
			const postgres = requireFromServer('postgres') as (
				url: string,
				options?: Record<string, unknown>,
			) => {
				unsafe(query: string): Promise<Array<Record<string, unknown>>>
				end(): Promise<void>
			}
			const schema = `rt105_cli_${process.pid}`
			const admin = postgres(pgUrl ?? '', { max: 1, onnotice: () => {} })
			try {
				await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
				await admin.unsafe(`CREATE SCHEMA ${schema}`)
				// The Postgres server store's table shape for v1.
				await admin.unsafe(
					`CREATE TABLE ${schema}.todos (id TEXT PRIMARY KEY NOT NULL, "title" TEXT, "done" TEXT, "score" TEXT, "legacy" TEXT, "listId" TEXT,
				_created_at BIGINT NOT NULL DEFAULT 0, _updated_at BIGINT NOT NULL DEFAULT 0, _deleted INTEGER NOT NULL DEFAULT 0)`,
				)
				await admin.unsafe(`CREATE INDEX idx_todos_legacy ON ${schema}.todos ("legacy")`)
				await admin.unsafe(`CREATE INDEX idx_todos__deleted ON ${schema}.todos (_deleted)`)
				await admin.unsafe(
					`INSERT INTO ${schema}.todos (id, title, done, score, legacy, _created_at, _updated_at) VALUES ('t1', 'a', 'yes', '12.5', 'x', 1791000000000, 1791000000001), ('t2', 'b', 'off', 'n/a', NULL, 1791000000002, 1791000000003)`,
				)
				const generated = generateMigration(v1, v2, diffSchemas(v1, v2))
				const apply = (id: string) =>
					runMigration({
						postgresConnectionString: pgUrl,
						migrationId: id,
						fromVersion: 1,
						toVersion: 2,
						upStatements: generated.up,
						postgresClientFactory: (u) =>
							postgres(u, { max: 1, onnotice: () => {}, connection: { search_path: schema } }),
					})
				await apply('rt105-up')
				const types = await admin.unsafe(
					`SELECT column_name::text AS name, data_type::text AS type FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'todos' ORDER BY column_name`,
				)
				expect(Object.fromEntries(types.map((row) => [row.name, row.type]))).toEqual({
					_created_at: 'bigint',
					_deleted: 'integer',
					_updated_at: 'bigint',
					done: 'integer',
					id: 'text',
					listId: 'text',
					score: 'double precision',
					seenAt: 'bigint',
					status: 'text',
					title: 'text',
				})
				const rows = await admin.unsafe(
					`SELECT id, done, score, status, _created_at::text AS created FROM ${schema}.todos ORDER BY id`,
				)
				expect(rows).toEqual([
					{ id: 't1', done: 1, score: 12.5, status: 'open', created: '1791000000000' },
					{ id: 't2', done: 0, score: null, status: 'open', created: '1791000000002' },
				])
				const indexes = await admin.unsafe(
					`SELECT indexname::text AS name FROM pg_indexes WHERE schemaname = '${schema}' AND tablename = 'todos' ORDER BY indexname`,
				)
				expect(indexes.map((row) => row.name)).toEqual([
					'idx_todos__deleted',
					'idx_todos_status',
					'todos_pkey',
				])
				// A second run (another migration id) finds nothing to change.
				await apply('rt105-again')
				expect(
					await admin.unsafe(`SELECT id, done, score FROM ${schema}.todos ORDER BY id`),
				).toEqual([
					{ id: 't1', done: 1, score: 12.5 },
					{ id: 't2', done: 0, score: null },
				])
			} finally {
				await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
				await admin.end()
			}
		},
	)
})
