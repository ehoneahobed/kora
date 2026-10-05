/**
 * RT-111 repro (Codex review of PR #4, core constraint-relaxation.ts): the one-time
 * SQLite value-domain relaxation (RT-101), which every client store runs at open, treated
 * ANY `CHECK (` in a collection table's DDL as a beta.12 enum check and rebuilt the table
 * without checks. A constraint added as a storage safety net (`CHECK (price >= 0)`) was
 * silently dropped at the next open.
 *
 * Asserts the CORRECT behaviour on every client adapter: only Kora's own enum check (on
 * an enum field of the schema) is relaxed; other checks survive, and a table holding only
 * such checks is not rebuilt.
 */
import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { IndexedDbAdapter } from '../../src/adapters/indexeddb-adapter'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { deleteFromIndexedDB } from '../../src/adapters/sqlite-wasm-persistence'
import { relaxValueDomainConstraints } from '../../src/store/relax-constraints'
import type { StorageAdapter } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		products: {
			fields: {
				title: t.string(),
				price: t.number().optional(),
				kind: t.enum(['a', 'b']).default('a'),
				label: t.string().optional(),
			},
		},
	},
})

const KORA_COLUMNS = `_created_at INTEGER NOT NULL,
  _updated_at INTEGER NOT NULL,
  _version TEXT NOT NULL DEFAULT '',
  _field_versions TEXT NOT NULL DEFAULT '{}',
  _deleted INTEGER NOT NULL DEFAULT 0`

/** Only hand-added checks: a column check, a named table check, an enum-shaped one on a string. */
const GUARDED = `CREATE TABLE "products" (
  id TEXT PRIMARY KEY NOT NULL,
  "title" TEXT,
  "price" REAL CHECK ("price" >= 0),
  "kind" TEXT DEFAULT 'a',
  "label" TEXT,
  ${KORA_COLUMNS},
  CONSTRAINT "label_domain" CHECK ("label" IN ('x', 'y'))
)`

/** beta.12's enum check and NOT NULL, plus a hand-added check. */
const LEGACY_AND_GUARDED = `CREATE TABLE "products" (
  id TEXT PRIMARY KEY NOT NULL,
  "title" TEXT NOT NULL,
  "price" REAL CHECK ("price" >= 0),
  "kind" TEXT DEFAULT 'a' CHECK ("kind" IN ('a', 'b')),
  "label" TEXT,
  ${KORA_COLUMNS}
)`

async function replaceTable(adapter: StorageAdapter, ddl: string): Promise<void> {
	await adapter.transaction(async (tx) => {
		await tx.execute('DROP TABLE "products"')
		await tx.execute(ddl)
	})
}

async function tableSql(adapter: StorageAdapter): Promise<string> {
	const rows = await adapter.query<{ sql: string }>(
		"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'",
	)
	return rows[0]?.sql ?? ''
}

async function insert(adapter: StorageAdapter, values: string): Promise<'stored' | 'refused'> {
	return adapter
		.execute(
			`INSERT INTO products (id, title, price, kind, label, _created_at, _updated_at) VALUES ${values}`,
		)
		.then(
			() => 'stored' as const,
			() => 'refused' as const,
		)
}

const adapters: Array<[string, () => StorageAdapter]> = [
	['better-sqlite3', () => new BetterSqlite3Adapter(':memory:')],
	['SQLite WASM (worker bridge)', () => new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })],
	[
		'IndexedDB (SQLite in memory + snapshot)',
		() => new IndexedDbAdapter({ bridge: new MockWorkerBridge(), dbName: 'rt111-relax' }),
	],
]

describe('RT-111: client relaxation keeps checks that are not Kora enum checks', () => {
	let open: StorageAdapter | null = null
	afterEach(async () => {
		await open?.close()
		open = null
		await deleteFromIndexedDB('rt111-relax').catch(() => {})
	})

	test.each(adapters)('%s: hand-added checks only: no rebuild, checks kept', async (_, make) => {
		const adapter = make()
		open = adapter
		await adapter.open(schema)
		await replaceTable(adapter, GUARDED)
		expect(await relaxValueDomainConstraints(adapter, schema)).toEqual([])
		expect(await tableSql(adapter)).toBe(GUARDED)
		expect(await insert(adapter, "('p1', 't', -1, 'a', NULL, 1, 1)")).toBe('refused')
		expect(await insert(adapter, "('p2', 't', 1, 'a', 'z', 1, 1)")).toBe('refused')
		expect(await insert(adapter, "('p3', 't', 1, 'a', 'x', 1, 1)")).toBe('stored')
	})

	test.each(adapters)(
		'%s: a beta.12 enum CHECK goes, a hand-added CHECK stays',
		async (_, make) => {
			const adapter = make()
			open = adapter
			await adapter.open(schema)
			await replaceTable(adapter, LEGACY_AND_GUARDED)
			expect(await relaxValueDomainConstraints(adapter, schema)).toEqual(['products'])
			const sql = await tableSql(adapter)
			expect(sql).not.toMatch(/"kind" IN/)
			expect(sql).not.toMatch(/"title" TEXT NOT NULL/)
			// Kora's enum check and NOT NULL are gone ...
			expect(await insert(adapter, "('p1', NULL, 1, 'c', NULL, 1, 1)")).toBe('stored')
			// ... the hand-added check is not.
			expect(await insert(adapter, "('p2', 't', -1, 'a', NULL, 1, 1)")).toBe('refused')
			// Idempotent: the kept check does not trigger another rebuild.
			expect(await relaxValueDomainConstraints(adapter, schema)).toEqual([])
			expect(await tableSql(adapter)).toBe(sql)
		},
	)
})
