import { defineSchema, t } from '@kora/core'
import type { KoraEvent } from '@kora/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './create-app'
import type { KoraApp } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
		projects: {
			fields: {
				name: t.string(),
				active: t.boolean().default(true),
			},
		},
	},
})

describe('createApp', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) {
			await app.close()
		}
	})

	test('returns a KoraApp object', () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		expect(app).toBeDefined()
		expect(app.ready).toBeInstanceOf(Promise)
		expect(app.events).toBeDefined()
		expect(app.sync).toBeNull()
	})

	test('ready resolves after store opens', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await expect(app.ready).resolves.toBeUndefined()
	})

	test('collection accessors are available after ready', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		// Accessing the collection accessor should work
		const todos = (app as Record<string, unknown>).todos as import('@kora/store').CollectionAccessor
		expect(todos).toBeDefined()
		expect(typeof todos.insert).toBe('function')
		expect(typeof todos.findById).toBe('function')
		expect(typeof todos.update).toBe('function')
		expect(typeof todos.delete).toBe('function')
		expect(typeof todos.where).toBe('function')
	})

	test('collection accessors throw before ready', () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})

		expect(() => (app as Record<string, unknown>).todos).toThrow(
			'Cannot access collection "todos" before app.ready resolves',
		)
	})

	test('defines accessors for all collections in schema', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		// Both collections should be accessible
		expect((app as Record<string, unknown>).todos).toBeDefined()
		expect((app as Record<string, unknown>).projects).toBeDefined()
	})

	test('insert and findById work through collection accessor', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as import('@kora/store').CollectionAccessor
		const record = await todos.insert({ title: 'Test Todo' })
		expect(record.id).toBeDefined()
		expect(record.title).toBe('Test Todo')
		expect(record.completed).toBe(false)

		const found = await todos.findById(record.id)
		expect(found).not.toBeNull()
		expect(found?.title).toBe('Test Todo')
	})

	test('emits operation:created events on mutations', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const events: KoraEvent[] = []
		app.events.on('operation:created', (e) => events.push(e))

		const todos = (app as Record<string, unknown>).todos as import('@kora/store').CollectionAccessor
		await todos.insert({ title: 'Event Test' })

		expect(events.length).toBe(1)
		expect(events[0]?.type).toBe('operation:created')
	})

	test('getStore returns the Store instance after ready', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const store = app.getStore()
		expect(store).toBeDefined()
		expect(typeof store.collection).toBe('function')
		expect(typeof store.getNodeId).toBe('function')
	})

	test('getStore throws before ready', () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})

		expect(() => app.getStore()).toThrow('Store not initialized')
	})

	test('getSyncEngine returns null when sync not configured', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		expect(app.getSyncEngine()).toBeNull()
	})

	test('close is safe to call multiple times', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		await app.close()
		// Second close should not throw
		await app.close()
	})

	test('sync control is created when sync config provided', () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:8080' },
		})

		expect(app.sync).not.toBeNull()
		expect(typeof app.sync?.connect).toBe('function')
		expect(typeof app.sync?.disconnect).toBe('function')
		expect(typeof app.sync?.getStatus).toBe('function')
	})

	test('sync status returns offline before connect', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:8080' },
		})
		await app.ready

		const status = app.sync?.getStatus()
		expect(status?.status).toBe('offline')
		expect(status?.pendingOperations).toBe(0)
	})

	test('auto-detects adapter in Node.js environment', async () => {
		app = createApp({ schema })
		await app.ready

		// In Node.js, auto-detection should pick better-sqlite3
		const store = app.getStore()
		expect(store).toBeDefined()
	})

	test('creates reconnection manager when sync configured', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: {
				url: 'wss://localhost:9999',
				reconnectInterval: 500,
				maxReconnectInterval: 5000,
			},
		})
		await app.ready

		// Sync control should be available and not crash
		expect(app.sync).not.toBeNull()
		expect(app.sync?.getStatus().status).toBe('offline')
	})

	test('autoReconnect false is accepted without error', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: {
				url: 'wss://localhost:9999',
				autoReconnect: false,
			},
		})
		await app.ready

		expect(app.sync).not.toBeNull()
	})

	test('disconnect prevents auto-reconnection', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		// Disconnect sets intentional flag — should not throw
		await app.sync?.disconnect()
		expect(app.sync?.getStatus().status).toBe('offline')
	})

	test('devtools true wires instrumenter', async () => {
		const events: KoraEvent[] = []

		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			devtools: true,
		})

		// Instrumenter is wired synchronously, events still flow
		app.events.on('operation:created', (e) => events.push(e))
		await app.ready

		const todos = (app as Record<string, unknown>).todos as import('@kora/store').CollectionAccessor
		await todos.insert({ title: 'DevTools Test' })

		expect(events.length).toBe(1)
	})

	test('devtools false does not affect functionality', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			devtools: false,
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as import('@kora/store').CollectionAccessor
		const record = await todos.insert({ title: 'No DevTools' })
		expect(record.title).toBe('No DevTools')
	})

	test('close cleans up reconnection and devtools resources', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
			devtools: true,
		})
		await app.ready

		// Close should clean up without hanging or throwing
		await app.close()

		// Second close should still be safe
		await app.close()
	})
})
