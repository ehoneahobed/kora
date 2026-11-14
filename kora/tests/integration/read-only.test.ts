import { defineSchema, t } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import { StoreReadOnlyError } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), done: t.boolean().default(false) } },
	},
})

describe('app.setReadOnly', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	const todosOf = (instance: KoraApp) =>
		(instance as unknown as Record<string, CollectionAccessor>).todos as CollectionAccessor

	test('refuses every local write while read-only, keeps reads, and writes again once cleared', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = todosOf(app)
		const existing = await todos.insert({ title: 'Before' })

		app.setReadOnly('previewing as Ama')
		expect(app.readOnlyReason()).toBe('previewing as Ama')
		await expect(todos.insert({ title: 'No' })).rejects.toBeInstanceOf(StoreReadOnlyError)
		await expect(todos.insertMany([{ title: 'No' }])).rejects.toMatchObject({
			code: 'STORE_READ_ONLY',
		})
		await expect(todos.update(existing.id, { done: true })).rejects.toMatchObject({
			code: 'STORE_READ_ONLY',
		})
		await expect(todos.delete(existing.id)).rejects.toMatchObject({ code: 'STORE_READ_ONLY' })
		await expect(
			app.mutation('rename', async (tx) => {
				await (tx as unknown as Record<string, CollectionAccessor>).todos?.update(existing.id, {
					title: 'No',
				})
			}),
		).rejects.toMatchObject({ code: 'STORE_READ_ONLY' })

		// Reads carry on, and nothing changed.
		const found = await todos.findById(existing.id)
		expect(found?.title).toBe('Before')
		expect(found?.done).toBe(false)
		expect(await todos.where({}).exec()).toHaveLength(1)

		app.setReadOnly(null)
		expect(app.readOnlyReason()).toBeNull()
		await todos.update(existing.id, { done: true })
		expect((await todos.findById(existing.id))?.done).toBe(true)
	})

	test('read-only set before the app opens applies once it opens', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		app.setReadOnly('locked')
		await app.ready
		expect(app.readOnlyReason()).toBe('locked')
		await expect(todosOf(app).insert({ title: 'No' })).rejects.toMatchObject({
			code: 'STORE_READ_ONLY',
		})
	})

	test('a blank reason means writable', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		app.setReadOnly('   ')
		expect(app.readOnlyReason()).toBeNull()
		await expect(todosOf(app).insert({ title: 'Yes' })).resolves.toMatchObject({ title: 'Yes' })
	})
})
