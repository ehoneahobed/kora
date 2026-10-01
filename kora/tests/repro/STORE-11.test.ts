import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-11: docs/api/store.md documents .orderBy('createdAt') and
// .where({ updatedAt: ... }); both must work on the virtual timestamp fields.
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } },
})

describe('STORE-11 createdAt / updatedAt in queries', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test("documented .orderBy('createdAt', 'desc') works", async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as Record<string, any>).todos
		await todos.insert({ title: 'a' })
		await todos.insert({ title: 'b' })
		const rows = await todos.where({ completed: false }).orderBy('createdAt', 'desc').exec()
		expect(rows).toHaveLength(2)
	})

	test('where on updatedAt works', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as Record<string, any>).todos
		await todos.insert({ title: 'a' })
		const rows = await todos.where({ updatedAt: { $gt: 0 } }).exec()
		expect(rows).toHaveLength(1)
	})
})
