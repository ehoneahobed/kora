import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

/**
 * Tests for schema migration execution in Store.open().
 *
 * Uses BetterSqlite3Adapter with temp files so data persists across
 * close → re-open cycles (needed to test upgrade migrations).
 */

let tmpDir: string

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'kora-migration-test-'))
})

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

let testCounter = 0
function nextDbPath(): string {
	return join(tmpDir, `test-${++testCounter}.db`)
}

describe('Store schema migrations', () => {
	test('first open sets schema_version to schema.version', async () => {
		const dbPath = nextDbPath()
		const adapter = new BetterSqlite3Adapter(dbPath)
		const schema = defineSchema({
			version: 1,
			collections: {
				todos: { fields: { title: t.string() } },
			},
		})
		const store = new Store({ schema, adapter, nodeId: 'node-1' })
		await store.open()

		const rows = await adapter.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		expect(rows[0]?.value).toBe('1')
		await store.close()
	})

	test('re-open with same version does not re-run migrations', async () => {
		const dbPath = nextDbPath()
		const schema = defineSchema({
			version: 1,
			collections: {
				todos: { fields: { title: t.string() } },
			},
		})

		const store1 = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.close()

		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema, adapter: adapter2, nodeId: 'node-1' })
		await store2.open()

		const rows = await adapter2.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		expect(rows[0]?.value).toBe('1')
		await store2.close()
	})

	test('migration adds a new column', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				products: {
					fields: {
						name: t.string(),
						price: t.number(),
					},
				},
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.collection('products').insert({ name: 'Widget', price: 9.99 })
		await store1.close()

		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				products: {
					fields: {
						name: t.string(),
						price: t.number(),
						taxInclusive: t.boolean().default(false),
					},
				},
			},
			migrations: {
				2: migrate().addField('products', 'taxInclusive', t.boolean().default(false)),
			},
		})
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: schemaV2, adapter: adapter2, nodeId: 'node-1' })
		await store2.open()

		const rows = await adapter2.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		expect(rows[0]?.value).toBe('2')

		const products = await store2.collection('products').where({}).exec()
		expect(products).toHaveLength(1)
		expect(products[0]?.name).toBe('Widget')
		await store2.close()
	})

	test('migration renames a column', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				products: {
					fields: {
						name: t.string(),
						cost: t.number(),
					},
				},
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.collection('products').insert({ name: 'Widget', cost: 5.0 })
		await store1.close()

		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				products: {
					fields: {
						name: t.string(),
						costPrice: t.number(),
					},
				},
			},
			migrations: {
				2: migrate().renameField('products', 'cost', 'costPrice'),
			},
		})
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: schemaV2, adapter: adapter2, nodeId: 'node-1' })
		await store2.open()

		const products = await store2.collection('products').where({}).exec()
		expect(products).toHaveLength(1)
		expect(products[0]?.costPrice).toBe(5.0)
		await store2.close()
	})

	test('migration adds an index', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				products: {
					fields: {
						name: t.string(),
						category: t.string(),
					},
				},
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.close()

		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				products: {
					fields: {
						name: t.string(),
						category: t.string(),
					},
					indexes: ['category'],
				},
			},
			migrations: {
				2: migrate().addIndex('products', 'category'),
			},
		})
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: schemaV2, adapter: adapter2, nodeId: 'node-1' })
		await store2.open()

		const indexes = await adapter2.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_8_products_category'",
		)
		expect(indexes).toHaveLength(1)
		await store2.close()
	})

	test('migration with backfill transforms existing records', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				products: {
					fields: {
						name: t.string(),
						price: t.number(),
						taxRate: t.number().default(0),
					},
				},
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.collection('products').insert({ name: 'Taxed', price: 10, taxRate: 0.15 })
		await store1.collection('products').insert({ name: 'Free', price: 5, taxRate: 0 })
		await store1.close()

		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				products: {
					fields: {
						name: t.string(),
						price: t.number(),
						taxRate: t.number().default(0),
						taxInclusive: t.boolean().default(false),
					},
				},
			},
			migrations: {
				2: migrate()
					.addField('products', 'taxInclusive', t.boolean().default(false))
					.backfill('products', (record) => ({
						taxInclusive: (record.taxRate as number) > 0,
					})),
			},
		})
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: schemaV2, adapter: adapter2, nodeId: 'node-1' })
		await store2.open()

		const products = await store2.collection('products').where({}).exec()
		expect(products).toHaveLength(2)

		const taxed = products.find((p) => p.name === 'Taxed')
		const free = products.find((p) => p.name === 'Free')
		// Backfill should have set taxInclusive based on taxRate > 0
		expect(taxed?.taxInclusive).toBeTruthy()
		expect(free?.taxInclusive).toBeFalsy()
		await store2.close()
	})

	test('multi-version migration runs in order', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				products: {
					fields: {
						name: t.string(),
					},
				},
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.collection('products').insert({ name: 'Widget' })
		await store1.close()

		const schemaV3 = defineSchema({
			version: 3,
			collections: {
				products: {
					fields: {
						name: t.string(),
						category: t.string().optional(),
						featured: t.boolean().default(false),
					},
				},
			},
			migrations: {
				2: migrate().addField('products', 'category', t.string().optional()),
				3: migrate().addField('products', 'featured', t.boolean().default(false)),
			},
		})
		const adapter3 = new BetterSqlite3Adapter(dbPath)
		const store3 = new Store({ schema: schemaV3, adapter: adapter3, nodeId: 'node-1' })
		await store3.open()

		const rows = await adapter3.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		expect(rows[0]?.value).toBe('3')

		const products = await store3.collection('products').where({}).exec()
		expect(products).toHaveLength(1)
		expect(products[0]?.name).toBe('Widget')
		await store3.close()
	})

	test('skips versions without migrations', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				todos: { fields: { title: t.string() } },
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.close()

		const schemaV3 = defineSchema({
			version: 3,
			collections: {
				todos: {
					fields: {
						title: t.string(),
						priority: t.string().optional(),
					},
				},
			},
			migrations: {
				3: migrate().addField('todos', 'priority', t.string().optional()),
			},
		})
		const adapter3 = new BetterSqlite3Adapter(dbPath)
		const store3 = new Store({ schema: schemaV3, adapter: adapter3, nodeId: 'node-1' })
		await store3.open()

		const rows = await adapter3.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		expect(rows[0]?.value).toBe('3')
		await store3.close()
	})

	test('migration removes an index', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				products: {
					fields: {
						name: t.string(),
						category: t.string(),
					},
					indexes: ['category'],
				},
			},
		})
		const store1 = new Store({
			schema: schemaV1,
			adapter: new BetterSqlite3Adapter(dbPath),
			nodeId: 'node-1',
		})
		await store1.open()
		await store1.close()

		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				products: {
					fields: {
						name: t.string(),
						category: t.string(),
					},
				},
			},
			migrations: {
				2: migrate().removeIndex('products', 'category'),
			},
		})
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: schemaV2, adapter: adapter2, nodeId: 'node-1' })
		await store2.open()

		const indexes = await adapter2.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_8_products_category'",
		)
		expect(indexes).toHaveLength(0)
		await store2.close()
	})

	test('no-op when schema has no migrations defined', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const schema = defineSchema({
			version: 2,
			collections: {
				todos: { fields: { title: t.string() } },
			},
		})
		const store = new Store({ schema, adapter, nodeId: 'node-1' })
		await store.open()

		const rows = await adapter.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		expect(rows[0]?.value).toBe('2')
		await store.close()
	})
})

describe('Store schema migrations: atomic versions and syncing backfills (STORE-13, NEW-STORE-1)', () => {
	const collections = () => ({
		items: {
			fields: {
				name: t.string(),
				qty: t.number().default(1),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
				note: t.string().optional(),
			},
		},
	})
	const v1 = defineSchema({ version: 1, collections: collections() })

	async function seed(path: string, count = 2): Promise<void> {
		const store = new Store({ schema: v1, adapter: new BetterSqlite3Adapter(path) })
		await store.open()
		for (let i = 0; i < count; i++) {
			await store
				.collection('items')
				.insert({ name: `n${i}`, qty: i + 1, done: i === 0, tags: ['x'] })
		}
		await store.close()
	}

	const vN = (
		version: number,
		migrations: NonNullable<Parameters<typeof defineSchema>[0]['migrations']>,
	) => defineSchema({ version, collections: collections(), migrations })

	test('backfills write update operations named migration:vN, with contiguous own sequence numbers', async () => {
		const path = nextDbPath()
		await seed(path)
		const schema = vN(2, { 2: migrate().backfill('items', (r) => ({ qty: Number(r.qty) * 10 })) })
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await store.open()
		const ops = await store.getAllOperations()
		const updates = ops.filter((op) => op.type === 'update')
		expect(updates.map((op) => op.data)).toEqual([{ qty: 10 }, { qty: 20 }])
		expect(updates.every((op) => op.mutationName === 'migration:v2')).toBe(true)
		expect(updates.map((op) => op.previousData)).toEqual([{ qty: 1 }, { qty: 2 }])
		const own = ops.filter((op) => op.nodeId === store.getNodeId()).map((op) => op.sequenceNumber)
		expect(own).toEqual([1, 2, 3, 4])
		expect(store.getVersionVector().get(store.getNodeId())).toBe(4)
		const report = await store.verifyLogIntegrity()
		expect(report.clean).toBe(true)
		await store.close()
	})

	test('transforms see typed records; unchanged values write nothing', async () => {
		const path = nextDbPath()
		await seed(path)
		const seen: Array<Record<string, unknown>> = []
		const schema = vN(2, {
			2: migrate().backfill('items', (r) => {
				seen.push(r)
				return { done: r.done, tags: r.tags }
			}),
		})
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await store.open()
		expect(seen.map((r) => [r.done, r.tags])).toEqual([
			[true, ['x']],
			[false, ['x']],
		])
		expect((await store.getAllOperations()).filter((op) => op.type === 'update')).toEqual([])
		await store.close()
	})

	test('a transform returning { ...record, field } changes only that field', async () => {
		const path = nextDbPath()
		await seed(path, 1)
		const schema = vN(2, { 2: migrate().backfill('items', (r) => ({ ...r, qty: 7 })) })
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await store.open()
		const updates = (await store.getAllOperations()).filter((op) => op.type === 'update')
		expect(updates.map((op) => op.data)).toEqual([{ qty: 7 }])
		await store.close()
	})

	test('localOnly backfills rewrite rows without operations', async () => {
		const path = nextDbPath()
		await seed(path)
		const schema = vN(2, {
			2: migrate().backfill('items', () => ({ tags: ['local'] }), { localOnly: true }),
		})
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await store.open()
		const rows = await store.collection('items').where({}).exec()
		expect(rows.map((r) => r.tags)).toEqual([['local'], ['local']])
		expect((await store.getAllOperations()).filter((op) => op.type === 'update')).toEqual([])
		await store.close()
	})

	test('each version commits on its own: a failing v3 keeps v2 and rolls back all of v3', async () => {
		const path = nextDbPath()
		await seed(path, 1)
		let fail = true
		const schema = vN(3, {
			2: migrate().backfill('items', (r) => ({ qty: Number(r.qty) + 1 })),
			3: migrate()
				.addField('items', 'note', t.string().optional())
				.backfill('items', (r) => ({ qty: Number(r.qty) * 100 }))
				.backfill('items', () => {
					if (fail) throw new Error('crash')
					return {}
				}),
		})
		const first = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await expect(first.open()).rejects.toThrow('crash')
		await first.close().catch(() => {})

		const probe = new BetterSqlite3Adapter(path)
		await probe.open(v1)
		const version = await probe.query<{ value: string }>(
			"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
		)
		const qty = await probe.query<{ qty: number }>('SELECT qty FROM items')
		await probe.close()
		expect(version[0]?.value).toBe('2')
		expect(qty).toEqual([{ qty: 2 }])

		fail = false
		const second = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await second.open()
		const rows = await second.collection('items').where({}).exec()
		expect(rows.map((r) => r.qty)).toEqual([200])
		const updates = (await second.getAllOperations()).filter((op) => op.type === 'update')
		expect(updates.map((op) => [op.mutationName, op.data])).toEqual([
			['migration:v2', { qty: 2 }],
			['migration:v3', { qty: 200 }],
		])
		await second.close()
	})

	test('a backfill returning a field outside the schema fails the version', async () => {
		const path = nextDbPath()
		await seed(path, 1)
		const schema = vN(2, { 2: migrate().backfill('items', () => ({ nope: 1 })) })
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path) })
		await expect(store.open()).rejects.toThrow(/unknown field "nope"/)
		await store.close().catch(() => {})
	})
})
