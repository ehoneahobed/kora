import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { generateMigration } from './migration-generator'
import { runMigration } from './migration-runner'
import { diffSchemas } from './schema-differ'
import { parseEvolveTableDirective } from './table-evolution-directive'
import {
	RELAX_VALUE_DOMAIN_DIRECTIVE,
	formatRelaxValueDomainDirective,
	parseRelaxValueDomainDirective,
} from './value-domain-directive'

/**
 * RT-101: a schema change to a field's value domain (enum values, requiredness) makes
 * `kora migrate` emit a relax-value-domain directive, which `--apply` expands per backend
 * against the live catalog, in the migration's transaction, idempotently.
 */
const v1 = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				priority: t.enum(['low', 'high']).default('low'),
			},
			indexes: ['priority'],
		},
	},
})
const v2 = defineSchema({
	version: 2,
	collections: {
		todos: {
			fields: {
				title: t.string().optional(),
				priority: t.enum(['low', 'high', 'urgent']).default('low'),
			},
			indexes: ['priority'],
		},
	},
})

/** The table as beta.12 created it (enum CHECK, NOT NULL on a required field). */
const LEGACY_TODOS = `CREATE TABLE "todos" (
  id TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "priority" TEXT DEFAULT 'low' CHECK ("priority" IN ('low', 'high')),
  _created_at INTEGER NOT NULL,
  _updated_at INTEGER NOT NULL,
  _version TEXT NOT NULL DEFAULT '',
  _field_versions TEXT NOT NULL DEFAULT '{}',
  _deleted INTEGER NOT NULL DEFAULT 0
)`

describe('relax-value-domain migration directive (RT-101)', () => {
	test('a value-domain-only change emits the directive, not a table rebuild', () => {
		const diff = diffSchemas(v1, v2)
		const generated = generateMigration(v1, v2, diff)
		const directive = formatRelaxValueDomainDirective({
			table: 'todos',
			fields: ['priority', 'title'],
			enums: ['priority'],
		})
		expect(generated.up).toEqual([directive])
		expect(generated.down).toEqual([directive])
		// Adding an enum value or making a field optional only widens the domain.
		expect(generated.containsBreakingChanges).toBe(false)
	})

	test('removing an enum value is breaking, and old rows keep it', () => {
		const v3 = defineSchema({
			version: 3,
			collections: {
				todos: {
					fields: {
						title: t.string().optional(),
						priority: t.enum(['low', 'high']).default('low'),
						note: t.string().optional(),
					},
					indexes: ['priority'],
				},
			},
		})
		const generated = generateMigration(v2, v3, diffSchemas(v2, v3))
		expect(generated.containsBreakingChanges).toBe(true)
		// Rows keep the removed enum value: the table change only adds `note` (RT-105), it
		// never rewrites the values of a field whose kind is unchanged.
		const evolve = generated.up.map(parseEvolveTableDirective).find((target) => target !== null)
		expect(evolve).toMatchObject({ table: 'todos', drop: [], change: {} })
		expect(Object.keys(evolve?.add ?? {})).toEqual(['note'])
	})

	test('parse round-trips and refuses a malformed directive', () => {
		const target = { table: 'to"dos', fields: ['a', 'b'] }
		expect(parseRelaxValueDomainDirective(formatRelaxValueDomainDirective(target))).toEqual(target)
		expect(parseRelaxValueDomainDirective('CREATE TABLE x (a TEXT)')).toBeNull()
		expect(() => parseRelaxValueDomainDirective(`${RELAX_VALUE_DOMAIN_DIRECTIVE} {`)).toThrow(
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

		test('rebuilds a beta.12 table once with the history row; a no-op afterwards', async () => {
			const dbPath = join(tempDir.path, 'app.db')
			const db = new Database(dbPath)
			db.exec(LEGACY_TODOS)
			db.exec('CREATE INDEX "idx_todos_priority" ON "todos" ("priority")')
			db.exec(
				"INSERT INTO todos (id, title, priority, _created_at, _updated_at) VALUES ('t1', 'a', 'high', 1, 1)",
			)
			db.close()

			const generated = generateMigration(v1, v2, diffSchemas(v1, v2))
			const report = await runMigration({
				sqlitePath: dbPath,
				migrationId: '001-v1-to-v2',
				fromVersion: 1,
				toVersion: 2,
				upStatements: generated.up,
			})
			expect(report.backends[0]).toMatchObject({ backend: 'sqlite', skipped: false })

			const after = new Database(dbPath)
			const sql = (
				after.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as {
					sql: string
				}
			).sql
			expect(sql).not.toMatch(/CHECK|"title" TEXT NOT NULL/)
			after
				.prepare(
					"INSERT INTO todos (id, title, priority, _created_at, _updated_at) VALUES ('t2', NULL, 'urgent', 2, 2)",
				)
				.run()
			expect(after.prepare('SELECT id, priority FROM todos ORDER BY id').all()).toEqual([
				{ id: 't1', priority: 'high' },
				{ id: 't2', priority: 'urgent' },
			])
			expect(
				after
					.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
					.all(),
			).toEqual([{ name: 'idx_todos_priority' }])
			expect(after.prepare('SELECT id, to_version FROM _kora_migrations').all()).toEqual([
				{ id: '001-v1-to-v2', to_version: 2 },
			])
			after.close()

			// Expanding the directive again (a later migration, a fresh database) changes nothing.
			const again = await runMigration({
				sqlitePath: dbPath,
				migrationId: '002-noop',
				fromVersion: 2,
				toVersion: 2,
				upStatements: generated.up,
			})
			expect(again.backends[0]).toMatchObject({ skipped: false })
			const final = new Database(dbPath)
			expect(
				(
					final.prepare("SELECT sql FROM sqlite_master WHERE name = 'todos'").get() as {
						sql: string
					}
				).sql,
			).toBe(sql)
			final.close()
		})
	})

	test('the directive names the enum fields of both schemas and round-trips (RT-108)', () => {
		const before = defineSchema({
			version: 1,
			collections: { projects: { fields: { status: t.enum(['active']).default('active') } } },
		})
		const after = defineSchema({
			version: 2,
			collections: {
				projects: { fields: { status: t.enum(['active', 'archived']).default('active') } },
			},
		})
		const generated = generateMigration(before, after, diffSchemas(before, after))
		const target = { table: 'projects', fields: ['status'], enums: ['status'] }
		expect(generated.up).toEqual([formatRelaxValueDomainDirective(target)])
		expect(parseRelaxValueDomainDirective(formatRelaxValueDomainDirective(target))).toEqual(target)
		// A release-candidate directive (no `enums`) still parses.
		expect(
			parseRelaxValueDomainDirective(
				formatRelaxValueDomainDirective({ table: 'projects', fields: ['status'] }),
			),
		).toEqual({ table: 'projects', fields: ['status'] })
		expect(() =>
			parseRelaxValueDomainDirective(
				`${RELAX_VALUE_DOMAIN_DIRECTIVE} {"table":"p","fields":["s"],"enums":[1]}`,
			),
		).toThrow(/Malformed migration directive/)
	})

	const pgUrl = process.env.KORA_PG_TEST_URL
	test.skipIf(!pgUrl)(
		'--apply on Postgres drops a single-value enum CHECK, with and without `enums` (RT-108)',
		async () => {
			const requireFromServer = createRequire(resolve(__dirname, '../../../../server/package.json'))
			const postgres = requireFromServer('postgres') as (
				url: string,
				options?: { max?: number; onnotice?: () => void },
			) => {
				unsafe(query: string): Promise<Array<Record<string, unknown>>>
				end(): Promise<void>
			}
			const admin = postgres(pgUrl ?? '', { max: 1, onnotice: () => {} })
			const cases = [
				{ suffix: 'enums', enums: ['status'] as string[] | undefined },
				{ suffix: 'legacy', enums: undefined },
			]
			try {
				for (const { suffix, enums } of cases) {
					const table = `rt108_cli_${suffix}_${process.pid}`
					const id = `rt108-${suffix}-${process.pid}`
					await admin.unsafe(`DROP TABLE IF EXISTS "${table}"`)
					await admin.unsafe(`DELETE FROM _kora_migrations WHERE id = '${id}'`).catch(() => {})
					// beta.12 DDL for t.enum(['active']); Postgres stores it as `status = 'active'`.
					await admin.unsafe(
						`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, "status" TEXT DEFAULT 'active' CHECK ("status" IN ('active')), "kind" TEXT CONSTRAINT "${table}_kind_hand" CHECK ("kind" <> 'x'))`,
					)
					const directive = formatRelaxValueDomainDirective({
						table,
						fields: ['kind', 'status'],
						...(enums ? { enums } : {}),
					})
					await runMigration({
						postgresConnectionString: pgUrl,
						migrationId: id,
						fromVersion: 1,
						toVersion: 2,
						upStatements: [directive],
						postgresClientFactory: (url) => postgres(url, { max: 1 }),
					})
					await admin.unsafe(`INSERT INTO "${table}" (id, status) VALUES ('p1', 'archived')`)
					// The check added by hand is kept.
					await expect(
						admin.unsafe(`INSERT INTO "${table}" (id, kind) VALUES ('p2', 'x')`),
					).rejects.toThrow(/check constraint/i)
					await admin.unsafe(`DROP TABLE IF EXISTS "${table}"`)
					await admin.unsafe(`DELETE FROM _kora_migrations WHERE id = '${id}'`).catch(() => {})
				}
			} finally {
				await admin.end()
			}
		},
	)

	test.skipIf(!pgUrl)('--apply on Postgres drops the enum CHECK and NOT NULL', async () => {
		const requireFromServer = createRequire(resolve(__dirname, '../../../../server/package.json'))
		const postgres = requireFromServer('postgres') as (
			url: string,
			options?: { max?: number; onnotice?: () => void },
		) => {
			unsafe(query: string): Promise<Array<Record<string, unknown>>>
			end(): Promise<void>
		}
		const table = `rt101_cli_${process.pid}`
		const admin = postgres(pgUrl ?? '', { max: 1, onnotice: () => {} })
		try {
			await admin.unsafe(`DROP TABLE IF EXISTS "${table}"`)
			await admin
				.unsafe(`DELETE FROM _kora_migrations WHERE id = 'rt101-${process.pid}'`)
				.catch(() => {})
			await admin.unsafe(
				`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, "title" TEXT NOT NULL, "priority" TEXT CHECK ("priority" IN ('low', 'high')), "score" INTEGER CHECK ("score" > 0), _created_at BIGINT NOT NULL DEFAULT 0)`,
			)
			const directive = formatRelaxValueDomainDirective({
				table,
				fields: ['priority', 'score', 'title'],
			})
			await runMigration({
				postgresConnectionString: pgUrl,
				migrationId: `rt101-${process.pid}`,
				fromVersion: 1,
				toVersion: 2,
				upStatements: [directive],
				postgresClientFactory: (url) => postgres(url, { max: 1 }),
			})
			await admin.unsafe(
				`INSERT INTO "${table}" (id, title, priority) VALUES ('t1', NULL, 'urgent')`,
			)
			// A check of another shape (added by hand) is kept.
			await expect(
				admin.unsafe(`INSERT INTO "${table}" (id, priority, score) VALUES ('t2', 'low', -1)`),
			).rejects.toThrow(/check constraint/i)
			const notNull = await admin.unsafe(
				`SELECT attname::text AS name FROM pg_attribute WHERE attrelid = '"${table}"'::regclass AND attnotnull AND attnum > 0 ORDER BY attnum`,
			)
			expect(notNull.map((row) => row.name)).toEqual(['id', '_created_at'])
			const history = await admin.unsafe(
				`SELECT to_version FROM _kora_migrations WHERE id = 'rt101-${process.pid}'`,
			)
			expect(history).toEqual([{ to_version: 2 }])
		} finally {
			await admin.unsafe(`DROP TABLE IF EXISTS "${table}"`)
			await admin
				.unsafe(`DELETE FROM _kora_migrations WHERE id = 'rt101-${process.pid}'`)
				.catch(() => {})
			await admin.end()
		}
	})
})
