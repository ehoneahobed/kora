import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

/**
 * Integration tests for the schema migration flow through createApp().
 */

let tmpDir: string
let testCounter = 0

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'kora-migration-integration-'))
})

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})

function nextDbPath(): string {
	return join(tmpDir, `test-${++testCounter}.db`)
}

describe('Schema migration integration', () => {
	test('v1 app → v2 app with addField migration preserves data', async () => {
		const dbPath = nextDbPath()

		// Create v1 app and insert data
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
		const app1 = createApp({
			schema: schemaV1,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app1.ready
		await app1.products.insert({ name: 'Widget', price: 9.99 })
		await app1.products.insert({ name: 'Gadget', price: 19.99 })
		await app1.close()

		// Create v2 app with migration
		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				products: {
					fields: {
						name: t.string(),
						price: t.number(),
						inStock: t.boolean().default(true),
					},
				},
			},
			migrations: {
				2: migrate().addField('products', 'inStock', t.boolean().default(true)),
			},
		})
		const app2 = createApp({
			schema: schemaV2,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app2.ready

		// Old data should be preserved
		const products = await app2.products.where({}).exec()
		expect(products).toHaveLength(2)
		expect(products.find((p) => p.name === 'Widget')).toBeDefined()
		expect(products.find((p) => p.name === 'Gadget')).toBeDefined()

		// New field should be accessible on new inserts
		const newProduct = await app2.products.insert({ name: 'Doohickey', price: 4.99 })
		expect(newProduct.name).toBe('Doohickey')
		await app2.close()
	})

	test('v1 → v3 multi-step migration with backfill', async () => {
		const dbPath = nextDbPath()

		// v1 app
		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				invoices: {
					fields: {
						customer: t.string(),
						amount: t.number(),
						taxRate: t.number().default(0),
					},
				},
			},
		})
		const app1 = createApp({
			schema: schemaV1,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app1.ready
		await app1.invoices.insert({ customer: 'Alice', amount: 100, taxRate: 0.1 })
		await app1.invoices.insert({ customer: 'Bob', amount: 200, taxRate: 0 })
		await app1.close()

		// v3 app with two migrations
		const schemaV3 = defineSchema({
			version: 3,
			collections: {
				invoices: {
					fields: {
						customer: t.string(),
						amount: t.number(),
						taxRate: t.number().default(0),
						taxAmount: t.number().default(0),
						status: t.string().default('draft'),
					},
				},
			},
			migrations: {
				2: migrate()
					.addField('invoices', 'taxAmount', t.number().default(0))
					.backfill('invoices', (record) => ({
						taxAmount: (record.amount as number) * (record.taxRate as number),
					})),
				3: migrate().addField('invoices', 'status', t.string().default('draft')),
			},
		})
		const app3 = createApp({
			schema: schemaV3,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app3.ready

		const invoices = await app3.invoices.where({}).exec()
		expect(invoices).toHaveLength(2)

		const alice = invoices.find((i) => i.customer === 'Alice')
		const bob = invoices.find((i) => i.customer === 'Bob')

		// Backfill should have computed tax amounts
		expect(alice?.taxAmount).toBe(10) // 100 * 0.1
		expect(bob?.taxAmount).toBe(0) // 200 * 0

		await app3.close()
	})

	test('renameField migration preserves data under new name', async () => {
		const dbPath = nextDbPath()

		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: {
						name: t.string(),
						cost: t.number(),
					},
				},
			},
		})
		const app1 = createApp({
			schema: schemaV1,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app1.ready
		await app1.items.insert({ name: 'Item A', cost: 42 })
		await app1.close()

		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				items: {
					fields: {
						name: t.string(),
						unitCost: t.number(),
					},
				},
			},
			migrations: {
				2: migrate().renameField('items', 'cost', 'unitCost'),
			},
		})
		const app2 = createApp({
			schema: schemaV2,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app2.ready

		const items = await app2.items.where({}).exec()
		expect(items).toHaveLength(1)
		expect(items[0]?.unitCost).toBe(42)
		await app2.close()
	})

	test('CRUD works normally after migration', async () => {
		const dbPath = nextDbPath()

		// v1
		const schemaV1 = defineSchema({
			version: 1,
			collections: {
				tasks: {
					fields: {
						title: t.string(),
					},
				},
			},
		})
		const app1 = createApp({
			schema: schemaV1,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app1.ready
		const task = await app1.tasks.insert({ title: 'Original' })
		await app1.close()

		// v2
		const schemaV2 = defineSchema({
			version: 2,
			collections: {
				tasks: {
					fields: {
						title: t.string(),
						priority: t.string().default('medium'),
					},
				},
			},
			migrations: {
				2: migrate().addField('tasks', 'priority', t.string().default('medium')),
			},
		})
		const app2 = createApp({
			schema: schemaV2,
			store: { adapter: 'better-sqlite3', name: dbPath },
		})
		await app2.ready

		// Update existing task
		await app2.tasks.update(task.id, { priority: 'high' })
		const updated = await app2.tasks.findById(task.id)
		expect(updated?.priority).toBe('high')

		// Insert new task with new field
		const newTask = await app2.tasks.insert({ title: 'New Task' })
		expect(newTask.title).toBe('New Task')

		// Delete
		await app2.tasks.delete(newTask.id)
		const deleted = await app2.tasks.findById(newTask.id)
		expect(deleted).toBeNull()

		await app2.close()
	})
})
