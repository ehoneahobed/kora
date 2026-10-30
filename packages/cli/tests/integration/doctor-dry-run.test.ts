/**
 * `kora doctor --db --dry-run-migrations` on a real SQLite file: the pending generated
 * migration runs on a copy, the live file is untouched, and the copy is gone afterwards.
 * Postgres is covered with a scripted connection in the unit tests.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SchemaDefinition, defineSchema, t } from '@korajs/core'
import { createSqliteServerStore } from '@korajs/server'
import Database from 'better-sqlite3'
import postgres from 'postgres'
import { afterEach, describe, expect, test } from 'vitest'
import { parseDoctorDatabaseUrl } from '../../src/commands/doctor/db/database'
import { checkMigrationDryRun } from '../../src/commands/doctor/db/migration-dry-run'
import { runDoctorChecks } from '../../src/commands/doctor/doctor-checks'

const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture(options: { wal?: boolean } = {}): Promise<{
	root: string
	file: string
	migrations: string
}> {
	const root = await mkdtemp(join(tmpdir(), 'kora-test-dry-run-'))
	dirs.push(root)
	const file = join(root, 'kora-server.db')
	const db = new Database(file)
	if (options.wal) db.pragma('journal_mode = WAL')
	db.exec(
		'CREATE TABLE operations (id TEXT PRIMARY KEY); CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL);',
	)
	const insert = db.prepare('INSERT INTO notes (id, title) VALUES (?, ?)')
	db.transaction(() => {
		for (let i = 0; i < 500; i++) insert.run(`n${i}`, `title ${i}`)
	})()
	db.close()
	const migrations = join(root, 'kora', 'migrations')
	await mkdir(migrations, { recursive: true })
	const directive = `--kora:evolve-table ${JSON.stringify({
		table: 'notes',
		add: { views: { kind: 'number', default: 0 } },
		drop: [],
		change: {},
		addIndexes: [],
		removeIndexes: [],
	})}`
	await writeFile(
		join(migrations, '001-v1-to-v2.ts'),
		'export const up = [] as const\nexport const down = [] as const\nexport const summary = [] as const\nexport const containsBreakingChanges = false\n',
	)
	await writeFile(
		join(migrations, '001-v1-to-v2.json'),
		JSON.stringify({
			id: '001-v1-to-v2',
			fromVersion: 1,
			toVersion: 2,
			up: [directive],
			down: [],
			summary: [],
			containsBreakingChanges: false,
		}),
	)
	return { root, file, migrations }
}

/** Private copies the dry run leaves in the temp directory (must be none). */
async function copies(): Promise<string[]> {
	return (await readdir(tmpdir())).filter((f) => f.startsWith('kora-doctor-dry-run-'))
}

function columns(file: string): string[] {
	const db = new Database(file, { readonly: true })
	const names = (db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map(
		(c) => c.name,
	)
	db.close()
	return names
}

describe.each([{ wal: false }, { wal: true }])('SQLite dry run (wal: $wal)', ({ wal }) => {
	test('runs the pending step on a copy and leaves the database untouched', async () => {
		const { root, file, migrations } = await fixture({ wal })
		const before = columns(file)
		const copiesBefore = await copies()
		const result = await checkMigrationDryRun(parseDoctorDatabaseUrl(file, root), migrations, root)
		expect(result.id).toBe('db-migration-dry-run')
		expect(result.status).toBe('pass')
		expect(result.message).toContain('001-v1-to-v2')
		expect(result.message).toContain('evolve notes: add views')
		expect(result.message).toContain('500 row(s)')
		expect(columns(file)).toEqual(before)
		expect(columns(file)).not.toContain('views')
		// nothing recorded as applied, no stray files next to the database
		expect(await copies()).toEqual(copiesBefore)
	})

	test('a recorded migration is not pending', async () => {
		const { root, file, migrations } = await fixture({ wal })
		const db = new Database(file)
		db.exec(
			"CREATE TABLE _kora_migrations (id TEXT PRIMARY KEY NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, applied_at INTEGER NOT NULL); INSERT INTO _kora_migrations VALUES ('001-v1-to-v2', 1, 2, 0);",
		)
		db.close()
		const result = await checkMigrationDryRun(parseDoctorDatabaseUrl(file, root), migrations, root)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('nothing to dry run')
	})
})

describe('runDoctorChecks with --dry-run-migrations', () => {
	test('adds the dry run only when asked, after the read-only preflight', async () => {
		const { root, file } = await fixture()
		// A real server database (operations log, meta tables) with the same notes table.
		const store = createSqliteServerStore({ filename: join(root, 'server.db') })
		await store.setSchema(
			defineSchema({
				version: 1,
				collections: { notes: { fields: { title: t.string() } } },
			}) as unknown as SchemaDefinition,
		)
		await store.close()
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'app', dependencies: { korajs: '1.0.0' } }),
		)
		const serverDb = join(root, 'server.db')
		const without = await runDoctorChecks({ projectRoot: root, skipNetwork: true, db: serverDb })
		expect(without.some((c) => c.id === 'db-migration-dry-run')).toBe(false)
		const withDryRun = await runDoctorChecks({
			projectRoot: root,
			skipNetwork: true,
			db: serverDb,
			dryRunMigrations: true,
		})
		const dry = withDryRun.find((c) => c.id === 'db-migration-dry-run')
		expect(dry?.status).toBe('pass')
		expect(columns(serverDb)).not.toContain('views')
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL

describe.skipIf(!PG_URL)('Postgres dry run (KORA_PG_TEST_URL)', () => {
	test('runs in a rolled-back transaction: real lock, real timing, nothing committed', async () => {
		const schema = `kora_dry_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1, onnotice: () => {} })
		const { root, migrations } = await fixture()
		try {
			await admin.unsafe(`CREATE SCHEMA ${schema}`)
			await admin.unsafe(
				`CREATE TABLE ${schema}.notes (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO ${schema}.notes SELECT 'n' || g, 'title ' || g FROM generate_series(1, 2000) g; ANALYZE ${schema}.notes`,
			)
			const url = `${PG_URL}${PG_URL?.includes('?') ? '&' : '?'}search_path=${schema}`
			const result = await checkMigrationDryRun(parseDoctorDatabaseUrl(url, root), migrations, root)
			expect(result.status).toBe('pass')
			expect(result.message).toContain('inside a transaction that was rolled back')
			expect(result.message).toContain('evolve notes: add views')
			expect(result.message).toContain('2,000 row(s) (estimate)')
			expect(result.message).toContain('ACCESS EXCLUSIVE')
			const columnRows = await admin.unsafe(
				`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'notes'`,
			)
			expect(columnRows.map((r) => r.column_name)).not.toContain('views')
			const recorded = await admin.unsafe(
				`SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '_kora_migrations'`,
			)
			expect(recorded).toHaveLength(0)
		} finally {
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
			await admin.end()
		}
	})
})
