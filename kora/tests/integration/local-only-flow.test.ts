import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
				priority: t.enum(['low', 'medium', 'high']).default('medium'),
			},
		},
	},
})

describe('Local-only flow (end-to-end)', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('full CRUD lifecycle', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor

		// Insert
		const record = await todos.insert({ title: 'Build Kora' })
		expect(record.id).toBeDefined()
		expect(record.title).toBe('Build Kora')
		expect(record.completed).toBe(false)
		expect(record.priority).toBe('medium')

		// Read
		const found = await todos.findById(record.id)
		expect(found).not.toBeNull()
		expect(found?.title).toBe('Build Kora')

		// Update
		const updated = await todos.update(record.id, { completed: true, priority: 'high' })
		expect(updated.completed).toBe(true)
		expect(updated.priority).toBe('high')
		expect(updated.title).toBe('Build Kora') // unchanged field preserved

		// Delete
		await todos.delete(record.id)
		const deleted = await todos.findById(record.id)
		expect(deleted).toBeNull()
	})

	test('events are emitted for each mutation', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const events: KoraEvent[] = []
		app.events.on('operation:created', (e) => events.push(e))

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor

		const record = await todos.insert({ title: 'Event tracking' })
		expect(events.length).toBe(1)
		expect(events[0]?.type).toBe('operation:created')

		await todos.update(record.id, { completed: true })
		expect(events.length).toBe(2)

		await todos.delete(record.id)
		expect(events.length).toBe(3)
	})

	test('query with where clause', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor

		await todos.insert({ title: 'Done task', completed: true })
		await todos.insert({ title: 'Active task', completed: false })
		await todos.insert({ title: 'Another active', completed: false })

		const active = await todos.where({ completed: false }).exec()
		expect(active.length).toBe(2)
		expect(active.every((t) => t.completed === false)).toBe(true)
	})

	test('multiple collections work independently', async () => {
		const multiSchema = defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: {
						title: t.string(),
					},
				},
				notes: {
					fields: {
						content: t.string(),
					},
				},
			},
		})

		app = createApp({
			schema: multiSchema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const notes = (app as Record<string, unknown>).notes as CollectionAccessor

		const todo = await todos.insert({ title: 'My todo' })
		const note = await notes.insert({ content: 'My note' })

		expect(todo.title).toBe('My todo')
		expect(note.content).toBe('My note')
	})

	test('close releases resources', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		await app.close()

		// After close, getStore should fail gracefully
		expect(() => app.getStore()).toThrow()
	})
})
