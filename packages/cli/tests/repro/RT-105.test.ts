/**
 * RT-105 repro (Phase 4, `kora migrate` rebuild vs the Phase 3 fold): the table rebuild
 * `kora migrate` generated for a field add/remove (and for an index-only change) was a
 * fixed SQLite statement list that re-created the collection table with the schema
 * fields and `_created_at` / `_updated_at` / `_deleted` only.
 *
 * - SQLite client store (`--db`): the rebuild dropped the store's `_version` and
 *   `_field_versions` columns (the next open re-adds them EMPTY; only a fold plan change
 *   re-materializes them, so an index-only migration leaves every row's versions blank),
 *   dropped the relation's `REFERENCES` clause for good, and every index the store made.
 * - SQLite server store: the rebuild dropped the store's own `idx_<table>__deleted`.
 * - Postgres server store: the SQLite DDL turned BIGINT/DOUBLE PRECISION/JSONB columns into
 *   INTEGER/REAL/TEXT, so a table holding real millisecond timestamps could not be migrated
 *   at all ("integer out of range"), and an empty one came out unable to store them.
 *
 * Fold state, bases, snapshots, the log and every other `_kora_*` table were untouched
 * (they are separate tables), and a field add/remove re-folds every record on the next
 * open, so rows converged; the loss was the internal columns, constraints and indexes.
 *
 * Asserts the CORRECT behaviour: the migration changes only the schema fields it names,
 * keeps every internal column, constraint, table and index, works on Postgres, and the
 * replicas converge (rows, versions and fold states) after it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { createPostgresServerStore, createSqliteServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { TestDevice, TestServer } from '@korajs/test'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { generateMigration } from '../../src/commands/migrate/migration-generator'
import { runMigration } from '../../src/commands/migrate/migration-runner'
import { diffSchemas } from '../../src/commands/migrate/schema-differ'

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function schemaV(version: number, notes: Record<string, unknown>, indexes: string[]) {
	return defineSchema({
		version,
		collections: {
			projects: { fields: { name: t.string() } },
			notes: { fields: notes as never, indexes },
		},
		relations: {
			noteProject: {
				from: 'notes',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete: 'set-null',
			},
		},
	}) as unknown as SchemaDefinition
}

const common = {
	title: t.string(),
	body: t.string().optional(),
	tags: t.array(t.string()).default([]),
	stock: t.number().default(0).merge('counter'),
	projectId: t.string().optional(),
}
const v1 = schemaV(1, { ...common, priority: t.enum(['low', 'high']).default('low') }, ['title'])
// v2 removes `priority` (indexed), adds `status` (defaulted) and `due` (optional).
const v1Indexed = schemaV(1, { ...common, priority: t.enum(['low', 'high']).default('low') }, [
	'title',
	'priority',
])
const v2 = schemaV(
	2,
	{ ...common, status: t.string().default('open'), due: t.timestamp().optional() },
	['title'],
)
// v3 only adds an index: the fold plan does not change, so nothing re-materializes rows.
const v3 = schemaV(
	3,
	{ ...common, status: t.string().default('open'), due: t.timestamp().optional() },
	['title', 'status'],
)

const dirs: string[] = []
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'rt-105-'))
	dirs.push(dir)
	return dir
}

type Server = TestServer<ReturnType<typeof createSqliteServerStore>>
function makeServer(dir: string, schema: SchemaDefinition): Server {
	return new TestServer(schema, {
		store: createSqliteServerStore({ filename: join(dir, 'server.db') }),
	})
}
function makeDevice(dir: string, name: string, schema: SchemaDefinition, server: Server) {
	return new TestDevice({
		name,
		schema,
		server,
		tmpDir: dir,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
		},
	})
}
const devicePath = (dir: string, name: string): string => join(dir, `test-device-${name}.db`)

interface Inspection {
	tables: Record<string, number>
	indexes: Record<string, string>
	columns: string[]
	foreignKeys: Array<Record<string, unknown>>
	rows: Array<Record<string, unknown>>
	fold: Array<Record<string, unknown>>
}
function inspect(path: string, foldTable = '_kora_fold_state'): Inspection {
	const db = new Database(path, { readonly: true })
	try {
		const tables: Record<string, number> = {}
		for (const { name } of db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
			.all() as Array<{ name: string }>) {
			tables[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n
		}
		const indexes: Record<string, string> = {}
		for (const row of db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
			)
			.all() as Array<{ name: string; sql: string }>) {
			indexes[row.name] = row.sql
		}
		return {
			tables,
			indexes,
			columns: (
				db.prepare("SELECT name FROM pragma_table_info('notes')").all() as Array<{
					name: string
				}>
			).map((c) => c.name),
			foreignKeys: db
				.prepare('SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(\'notes\')')
				.all() as Array<Record<string, unknown>>,
			rows: db.prepare('SELECT * FROM notes ORDER BY id').all() as Array<Record<string, unknown>>,
			fold: db.prepare(`SELECT * FROM ${foldTable} ORDER BY collection, record_id`).all() as Array<
				Record<string, unknown>
			>,
		}
	} finally {
		db.close()
	}
}

async function apply(
	from: SchemaDefinition,
	to: SchemaDefinition,
	target: { sqlitePath?: string; postgresConnectionString?: string },
	extra: {
		postgresClientFactory?: Parameters<typeof runMigration>[0]['postgresClientFactory']
	} = {},
): Promise<void> {
	const migration = generateMigration(from, to, diffSchemas(from, to))
	await runMigration({
		upStatements: migration.up,
		migrationId: `v${from.version}-to-v${to.version}`,
		fromVersion: from.version,
		toVersion: to.version,
		projectRoot: cliRoot,
		...target,
		...extra,
	})
}

/** Row values and the store's per-record versions, comparable across replicas. */
function comparable(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return rows.map((row) => {
		const { priority: _dropped, ...rest } = row
		return rest
	})
}

describe('RT-105: kora migrate keeps every internal column, constraint, table and index', () => {
	test('two devices, concurrent edits, compaction, add+remove field, continued sync (SQLite)', async () => {
		const dir = tempDir()
		let server = makeServer(dir, v1)
		await server.ready
		let a = makeDevice(dir, 'a', v1, server)
		let b = makeDevice(dir, 'b', v1, server)
		await a.open()
		await b.open()
		const project = await a.collection('projects').insert({ name: 'P' })
		const n1 = await a.collection('notes').insert({
			title: 'n1',
			tags: ['x'],
			stock: 10,
			projectId: project.id,
			priority: 'high',
		})
		const n2 = await a.collection('notes').insert({ title: 'n2' })
		await a.sync()
		await b.sync()
		await a.sync()
		// Concurrent edits of one record on both devices.
		await a.collection('notes').update(n1.id, { title: 'n1-a', tags: ['x', 'a'], stock: 12 })
		await b.collection('notes').update(n1.id, { body: 'from b', tags: ['x', 'b'], stock: 7 })
		await a.sync()
		await b.sync()
		await a.sync()
		// Compact the acknowledged history on both devices (bases in _kora_fold_base).
		for (const device of [a, b]) {
			const result = await device.store.compact({ mode: 'after-ack' })
			expect(result.deletedCount).toBeGreaterThan(0)
		}
		// A write still in A's outbound queue across the migration.
		await a.disconnect()
		await a.collection('notes').update(n2.id, { title: 'n2-offline' })
		await a.close()
		await b.close()
		await server.close()

		const before = { a: inspect(devicePath(dir, 'a')), b: inspect(devicePath(dir, 'b')) }
		const serverBefore = inspect(join(dir, 'server.db'), 'kora_fold_state')
		expect(before.a.tables._kora_fold_base).toBeGreaterThan(0)

		// `kora migrate --apply` against the server database and (`--db`) each device's.
		for (const path of [join(dir, 'server.db'), devicePath(dir, 'a'), devicePath(dir, 'b')]) {
			await apply(v1, v2, { sqlitePath: path })
		}

		for (const name of ['a', 'b'] as const) {
			const was = before[name]
			const now = inspect(devicePath(dir, name))
			// Internal columns kept, with their values.
			expect(now.columns).toEqual(expect.arrayContaining(['_version', '_field_versions']))
			expect(now.columns).not.toContain('priority')
			expect(now.columns).toEqual(expect.arrayContaining(['status', 'due']))
			expect(
				now.rows.map((row) => [row.id, row._version, row._field_versions, row._created_at]),
			).toEqual(was.rows.map((row) => [row.id, row._version, row._field_versions, row._created_at]))
			expect(now.rows.map((row) => row.status)).toEqual(was.rows.map(() => 'open'))
			// The relation's foreign key is kept.
			expect(now.foreignKeys).toEqual(was.foreignKeys)
			expect(now.foreignKeys).toHaveLength(1)
			// Every index on the table survives (none was on a removed field).
			expect(now.indexes).toEqual(was.indexes)
			// Every internal table, and its contents, is untouched.
			const { _kora_migrations: _history, ...tables } = now.tables
			expect(tables).toEqual(was.tables)
			expect(now.fold).toEqual(was.fold)
		}
		const serverNow = inspect(join(dir, 'server.db'), 'kora_fold_state')
		expect(serverNow.indexes).toEqual(serverBefore.indexes)
		expect(serverNow.fold).toEqual(serverBefore.fold)

		// Continue: everyone on v2, more concurrent edits, a fresh device joins.
		server = makeServer(dir, v2)
		await server.ready
		a = makeDevice(dir, 'a', v2, server)
		b = makeDevice(dir, 'b', v2, server)
		await a.open()
		await b.open()
		await b.collection('notes').update(n1.id, { status: 'done', stock: 9 })
		await a.collection('notes').update(n1.id, { body: 'from a' })
		await a.collection('notes').update(n2.id, { due: 1_800_000_000_000 })
		await a.sync()
		await b.sync()
		await a.sync()
		const c = makeDevice(dir, 'c', v2, server)
		await c.open()
		await c.sync()
		const serverRows = (await server.store.queryCollection('notes', {})) as Array<
			Record<string, unknown>
		>
		const stateA = await a.getState('notes')
		expect(await b.getState('notes')).toEqual(stateA)
		expect(await c.getState('notes')).toEqual(stateA)
		const pick = (row: Record<string, unknown>) => ({
			id: row.id,
			title: row.title,
			body: row.body,
			tags: row.tags,
			stock: row.stock,
			// n2 predates `status`: the default on every replica, the server included (RT-106).
			status: row.status,
			due: row.due,
		})
		expect(serverRows.map(pick)).toEqual(stateA.map(pick))
		expect(stateA.map((row) => row.status)).toEqual(['done', 'open'])
		await a.close()
		await b.close()
		await c.close()
		await server.close()

		const after = {
			a: inspect(devicePath(dir, 'a')),
			b: inspect(devicePath(dir, 'b')),
			c: inspect(devicePath(dir, 'c')),
		}
		// Rows (values AND per-record versions) and fold states agree with a device that
		// never migrated.
		expect(comparable(after.a.rows)).toEqual(after.c.rows)
		expect(comparable(after.b.rows)).toEqual(after.c.rows)
		const states = (inspection: Inspection) =>
			inspection.fold.map((row) => {
				const { u: _u, ...state } = JSON.parse(String(row.state)) as Record<string, unknown>
				return [row.collection, row.record_id, state.f, state.cr]
			})
		expect(states(after.a)).toEqual(states(after.c))
		expect(states(after.b)).toEqual(states(after.c))
		expect(after.a.foreignKeys).toEqual(after.c.foreignKeys)
	}, 120_000)

	test('an index-only migration keeps every row version (no re-materialization follows it)', async () => {
		const dir = tempDir()
		const server = makeServer(dir, v2)
		await server.ready
		const a = makeDevice(dir, 'a', v2, server)
		await a.open()
		const note = await a.collection('notes').insert({ title: 'n' })
		await a.collection('notes').update(note.id, { body: 'b' })
		await a.close()
		await server.close()
		const before = inspect(devicePath(dir, 'a'))
		await apply(v2, v3, { sqlitePath: devicePath(dir, 'a') })
		const after = inspect(devicePath(dir, 'a'))
		expect(after.rows).toEqual(before.rows)
		expect(after.foreignKeys).toEqual(before.foreignKeys)
		for (const [name, sql] of Object.entries(before.indexes)) expect(after.indexes[name]).toBe(sql)
		expect(Object.values(after.indexes).some((sql) => /\("status"\)|\(status\)/.test(sql))).toBe(
			true,
		)
	})

	test('removing an indexed field drops only its indexes; a failing migration changes nothing', async () => {
		const dir = tempDir()
		const server = makeServer(dir, v1Indexed)
		await server.ready
		const a = makeDevice(dir, 'a', v1Indexed, server)
		await a.open()
		await a.collection('notes').insert({ title: 'n', priority: 'high' })
		await a.close()
		await server.close()
		const before = inspect(devicePath(dir, 'a'))
		expect(Object.values(before.indexes).some((sql) => sql.includes('"priority"'))).toBe(true)

		// A failure after the table change rolls the whole migration back.
		const migration = generateMigration(v1Indexed, v2, diffSchemas(v1Indexed, v2))
		await expect(
			runMigration({
				upStatements: [...migration.up, 'SELECT * FROM no_such_table'],
				migrationId: 'failing',
				sqlitePath: devicePath(dir, 'a'),
				projectRoot: cliRoot,
			}),
		).rejects.toThrow(/no_such_table/)
		const unchanged = inspect(devicePath(dir, 'a'))
		const { _kora_migrations: _created, ...tables } = unchanged.tables
		expect({ ...unchanged, tables }).toEqual(before)

		await apply(v1Indexed, v2, { sqlitePath: devicePath(dir, 'a') })
		const after = inspect(devicePath(dir, 'a'))
		const expected = Object.fromEntries(
			Object.entries(before.indexes).filter(([, sql]) => !sql.includes('"priority"')),
		)
		expect(after.indexes).toEqual(expected)
		expect(after.rows.map((row) => [row._version, row._field_versions])).toEqual(
			before.rows.map((row) => [row._version, row._field_versions]),
		)
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL
describe.skipIf(!PG_URL)('RT-105: kora migrate on a Postgres server store', () => {
	test('add+remove field keeps the column types and the server keeps ingesting', async () => {
		const requireServer = createRequire(resolve(cliRoot, '../server/package.json'))
		const postgres = requireServer('postgres') as (
			url: string,
			options?: Record<string, unknown>,
		) => { unsafe(query: string): Promise<unknown>; end(): Promise<void> }
		const admin = postgres(PG_URL as string, { max: 1, onnotice: () => {} })
		await admin.unsafe('DROP DATABASE IF EXISTS kora_rt105')
		await admin.unsafe('CREATE DATABASE kora_rt105')
		await admin.end()
		const url = (PG_URL as string).replace(/\/[^/]*$/, '/kora_rt105')
		const pg = (u: string) => postgres(u, { max: 1, onnotice: () => {} })
		const columnTypes = async () => {
			const client = pg(url)
			try {
				const rows = (await client.unsafe(
					"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'notes' ORDER BY column_name",
				)) as Array<{ column_name: string; data_type: string }>
				return Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]))
			} finally {
				await client.end()
			}
		}
		const clock = new HybridLogicalClock('device-a')
		const insert = (recordId: string, data: Record<string, unknown>, sequenceNumber: number) =>
			createOperation(
				{
					nodeId: 'device-a',
					type: 'insert',
					collection: 'notes',
					recordId,
					data,
					previousData: null,
					sequenceNumber,
					causalDeps: [],
					schemaVersion: data.status === undefined ? 1 : 2,
				},
				clock,
			)

		let store = await createPostgresServerStore({ connectionString: url })
		try {
			await store.setSchema(v1)
			await store.applyRemoteOperation(
				await insert('r1', { title: 'hello', tags: ['x'], stock: 3.25, priority: 'high' }, 1),
			)
		} finally {
			await store.close()
		}
		const before = await columnTypes()

		await apply(v1, v2, { postgresConnectionString: url }, { postgresClientFactory: pg })
		const after = await columnTypes()
		const { priority: _removed, ...kept } = before
		expect(after).toEqual({ ...kept, status: 'text', due: 'bigint' })

		store = await createPostgresServerStore({ connectionString: url })
		try {
			await store.setSchema(v2)
			await store.applyRemoteOperation(
				await insert('r2', { title: 'after', tags: [], stock: 0.5, status: 'open' }, 2),
			)
			const rows = (await store.queryCollection('notes', {})) as Array<Record<string, unknown>>
			expect(rows.map((row) => [row.id, row.title, row.tags, row.stock])).toEqual([
				['r1', 'hello', ['x'], 3.25],
				['r2', 'after', [], 0.5],
			])
		} finally {
			await store.close()
		}
	}, 60_000)
})
