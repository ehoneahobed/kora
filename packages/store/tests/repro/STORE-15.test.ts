import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

// STORE-15 (lows)
describe('STORE-15 lows', () => {
	const stores: Store[] = []
	afterEach(async () => {
		for (const s of stores.splice(0)) await s.close()
	})

	test('indexes on (a_b.c) and (a.b_c) both exist', async () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				a_b: { fields: { c: t.string() }, indexes: ['c'] },
				a: { fields: { b_c: t.string() }, indexes: ['b_c'] },
			},
		})
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter, nodeId: 'n' })
		stores.push(store)
		await store.open()
		const idx = await adapter.query<{ tbl_name: string }>(
			"SELECT tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' AND tbl_name IN ('a','a_b')",
		)
		expect(new Set(idx.map((r) => r.tbl_name))).toEqual(new Set(['a', 'a_b']))
	})

	test('concurrent delivery of the same remote op is idempotent (no throw)', async () => {
		const schema = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string() } } },
		})
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:'), nodeId: 'n' })
		stores.push(store)
		await store.open()
		const op = await createOperation(
			{
				nodeId: 'peer',
				type: 'insert',
				collection: 'todos',
				recordId: 'r1',
				data: { title: 'x' },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			new HybridLogicalClock('peer'),
		)
		const results = await Promise.allSettled([
			store.applyRemoteOperation(op),
			store.applyRemoteOperation(op),
		])
		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
	})
})
