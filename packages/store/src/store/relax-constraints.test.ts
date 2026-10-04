import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { IndexedDbAdapter } from '../adapters/indexeddb-adapter'
import { deleteFromIndexedDB } from '../adapters/sqlite-wasm-persistence'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import type { StorageAdapter, Transaction } from '../types'
import { relaxValueDomainConstraints } from './relax-constraints'

/**
 * RT-101: the one-time rebuild of tables created by beta.12-and-earlier DDL (enum CHECK,
 * NOT NULL on required fields) on every client adapter.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				priority: t.enum(['low', 'high']).default('low'),
				projectId: t.string().optional(),
			},
			indexes: ['priority'],
		},
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
	},
})

/** The `todos` table exactly as beta.12's DDL created it. */
const LEGACY_TODOS = `CREATE TABLE "todos" (
  id TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "priority" TEXT DEFAULT 'low' CHECK ("priority" IN ('low', 'high')),
  "projectId" TEXT REFERENCES "projects"(id),
  _created_at INTEGER NOT NULL,
  _updated_at INTEGER NOT NULL,
  _version TEXT NOT NULL DEFAULT '',
  _field_versions TEXT NOT NULL DEFAULT '{}',
  _deleted INTEGER NOT NULL DEFAULT 0
)`

async function makeLegacy(adapter: StorageAdapter): Promise<void> {
	await adapter.execute('PRAGMA foreign_keys = OFF')
	await adapter.transaction(async (tx) => {
		await tx.execute('DROP TABLE "todos"')
		await tx.execute(LEGACY_TODOS)
		await tx.execute('CREATE INDEX "idx_5_todos_priority" ON "todos" ("priority")')
		await tx.execute('CREATE INDEX "idx_5_todos_projectId" ON "todos" ("projectId")')
		await tx.execute(
			`CREATE TRIGGER "todos_audit" AFTER DELETE ON "todos" BEGIN SELECT 1; END`,
		)
		await tx.execute(
			"INSERT INTO projects (id, name, _created_at, _updated_at) VALUES ('p1', 'P', 1, 1)",
		)
		await tx.execute(
			"INSERT INTO todos (id, title, priority, projectId, _created_at, _updated_at) VALUES ('t1', 'a', 'high', 'p1', 1, 1), ('t2', 'it''s', 'low', NULL, 2, 2)",
		)
	})
	await adapter.execute('PRAGMA foreign_keys = ON')
}

async function tableSql(adapter: StorageAdapter, name: string): Promise<string> {
	const rows = await adapter.query<{ sql: string }>(
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
	)
	return rows[0]?.sql ?? ''
}

async function verifyRelaxed(adapter: StorageAdapter): Promise<void> {
	const sql = await tableSql(adapter, 'todos')
	expect(sql).not.toMatch(/CHECK/i)
	const columns = await adapter.query<{ name: string; notnull: number; dflt_value: string | null }>(
		'SELECT name, "notnull" AS "notnull", dflt_value FROM pragma_table_info(\'todos\')',
	)
	const byName = new Map(columns.map((c) => [c.name, c]))
	// Schema fields lose NOT NULL; Kora's own columns keep theirs; defaults stay.
	expect(byName.get('title')?.notnull).toBe(0)
	expect(byName.get('_created_at')?.notnull).toBe(1)
	expect(byName.get('_deleted')?.notnull).toBe(1)
	expect(byName.get('priority')?.dflt_value).toContain("'low'")
	// Rows, keys, indexes and triggers are kept.
	expect(
		await adapter.query('SELECT id, title, priority, projectId FROM todos ORDER BY id'),
	).toEqual([
		{ id: 't1', title: 'a', priority: 'high', projectId: 'p1' },
		{ id: 't2', title: "it's", priority: 'low', projectId: null },
	])
	const fks = await adapter.query<{ table: string; from: string }>(
		'SELECT "table" AS "table", "from" AS "from" FROM pragma_foreign_key_list(\'todos\')',
	)
	expect(fks).toEqual([{ table: 'projects', from: 'projectId' }])
	const pk = await adapter.query<{ name: string }>(
		"SELECT name FROM pragma_table_info('todos') WHERE pk = 1",
	)
	expect(pk).toEqual([{ name: 'id' }])
	const dependents = await adapter.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE tbl_name = 'todos' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name",
	)
	expect(dependents.map((d) => d.name)).toEqual([
		'idx_5_todos_priority',
		'idx_5_todos_projectId',
		'todos_audit',
	])
	// A value the old CHECK refused, and a null for a once-required column, now store.
	await adapter.execute(
		"INSERT INTO todos (id, title, priority, _created_at, _updated_at) VALUES ('t3', NULL, 'urgent', 3, 3)",
	)
	expect(
		await adapter.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '_kora_relax_%'"),
	).toEqual([{ n: 0 }])
}

const adapters: Array<[string, () => StorageAdapter]> = [
	['better-sqlite3', () => new BetterSqlite3Adapter(':memory:')],
	['SQLite WASM (worker bridge)', () => new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })],
	[
		'IndexedDB (SQLite in memory + snapshot)',
		() => new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: 'rt101-relax' }),
	],
]

describe('relaxValueDomainConstraints (RT-101)', () => {
	let open: StorageAdapter | null = null
	afterEach(async () => {
		await open?.close()
		open = null
		await deleteFromIndexedDB('rt101-relax').catch(() => {})
	})

	test.each(adapters)('%s: rebuilds a beta.12 table once, keeping everything', async (_, make) => {
		const adapter = make()
		open = adapter
		await adapter.open(schema)
		await makeLegacy(adapter)
		expect(await tableSql(adapter, 'todos')).toMatch(/CHECK/)

		expect(await relaxValueDomainConstraints(adapter, schema)).toEqual(['todos'])
		await verifyRelaxed(adapter)
		const after = await tableSql(adapter, 'todos')
		// Idempotent: nothing left to do, the table is not touched again.
		expect(await relaxValueDomainConstraints(adapter, schema)).toEqual([])
		expect(await tableSql(adapter, 'todos')).toBe(after)
		// Foreign keys are enforced again afterwards.
		expect(await adapter.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
	})

	test('tables created by the current DDL carry no value-domain constraints', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		open = adapter
		await adapter.open(schema)
		expect(await tableSql(adapter, 'todos')).not.toMatch(/CHECK|"title" TEXT NOT NULL/i)
		expect(await relaxValueDomainConstraints(adapter, schema)).toEqual([])
	})

	test('an interrupted rebuild leaves the table as it was and runs again (resumable)', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		open = adapter
		await adapter.open(schema)
		await makeLegacy(adapter)
		// Fail half-way: after the copy, at the drop of the original table.
		const failing: StorageAdapter = Object.create(adapter, {
			transaction: {
				value: (fn: (tx: Transaction) => Promise<void>) =>
					adapter.transaction((tx) =>
						fn({
							query: (sql, params) => tx.query(sql, params),
							execute: async (sql, params) => {
								if (sql === 'DROP TABLE "todos"') throw new Error('crash')
								await tx.execute(sql, params)
							},
						}),
					),
			},
		})
		await expect(relaxValueDomainConstraints(failing, schema)).rejects.toThrow('crash')
		expect(await tableSql(adapter, 'todos')).toMatch(/CHECK/)
		expect(await adapter.query('SELECT COUNT(*) AS n FROM todos')).toEqual([{ n: 2 }])
		expect(await adapter.query('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])

		expect(await relaxValueDomainConstraints(adapter, schema)).toEqual(['todos'])
		await verifyRelaxed(adapter)
	})
})
