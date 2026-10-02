import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { collectionIndexName } from '@korajs/core/internal'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

/**
 * STORE-15: index names no longer collide across collections, and indexes a
 * database created under the old `idx_<collection>_<field>` names are replaced
 * on open.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		a_b: { fields: { c: t.string() }, indexes: ['c'] },
		a: { fields: { b_c: t.string() }, indexes: ['b_c'] },
		todos: { fields: { title: t.string(), owner: t.string() }, indexes: ['owner'] },
	},
})

let dir = ''
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-legacy-idx-'))
})
afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

async function indexes(adapter: BetterSqlite3Adapter): Promise<Map<string, string>> {
	const rows = await adapter.query<{ name: string; tbl_name: string }>(
		"SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
	)
	return new Map(rows.map((row) => [row.name, row.tbl_name]))
}

describe('collision-free index names', () => {
	test('legacy-named indexes are replaced by collision-free ones on open', async () => {
		const path = join(dir, 'legacy.db')
		// A database as beta.12 left it: only the legacy names exist, and
		// `idx_a_b_c` belongs to whichever collection created it first.
		const raw = new BetterSqlite3Adapter(path)
		await raw.open(schema)
		for (const collection of Object.keys(schema.collections)) {
			for (const field of schema.collections[collection]?.indexes ?? []) {
				await raw.execute(`DROP INDEX IF EXISTS "${collectionIndexName(collection, field)}"`)
			}
		}
		await raw.execute('CREATE INDEX idx_a_b_c ON a_b (c)')
		await raw.execute('CREATE INDEX idx_todos_owner ON todos (owner)')
		await raw.close()

		const adapter = new BetterSqlite3Adapter(path)
		const store = new Store({ schema, adapter, nodeId: 'n' })
		await store.open()
		try {
			const found = await indexes(adapter)
			expect(found.get(collectionIndexName('a_b', 'c'))).toBe('a_b')
			expect(found.get(collectionIndexName('a', 'b_c'))).toBe('a')
			expect(found.get(collectionIndexName('todos', 'owner'))).toBe('todos')
			expect(found.has('idx_a_b_c')).toBe(false)
			expect(found.has('idx_todos_owner')).toBe(false)
		} finally {
			await store.close()
		}
	})

	test('a legacy name owned by another table is left alone', async () => {
		const path = join(dir, 'foreign.db')
		const raw = new BetterSqlite3Adapter(path)
		await raw.open(schema)
		// The legacy name of (a, b_c) is "idx_a_b_c", but here it sits on a_b.c.
		await raw.execute('CREATE INDEX idx_a_b_c ON a_b (c)')
		await raw.close()

		const adapter = new BetterSqlite3Adapter(path)
		const store = new Store({
			schema: defineSchema({
				version: 1,
				collections: {
					a_b: { fields: { c: t.string() } },
					a: { fields: { b_c: t.string() }, indexes: ['b_c'] },
				},
			}),
			adapter,
			nodeId: 'n',
		})
		await store.open()
		try {
			const found = await indexes(adapter)
			// a_b no longer declares the index and a does not own the name: kept.
			expect(found.get('idx_a_b_c')).toBe('a_b')
		} finally {
			await store.close()
		}
	})
})
