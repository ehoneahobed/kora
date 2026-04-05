import { defineSchema, t } from '@kora/core'
import type { KoraEvent, Operation } from '@kora/core'
import type { CollectionAccessor } from '@kora/store'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

describe('Sync wiring', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('sync control is created when sync config provided', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		expect(app.sync).not.toBeNull()
		expect(app.getSyncEngine()).not.toBeNull()
	})

	test('sync engine receives local operations via event wiring', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const syncEngine = app.getSyncEngine()
		expect(syncEngine).not.toBeNull()

		// Insert a record — should enqueue to sync engine's outbound queue
		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		await todos.insert({ title: 'Sync test' })

		// The outbound queue should have the operation
		const queue = syncEngine?.getOutboundQueue()
		expect(queue?.totalPending).toBe(1)
	})

	test('multiple mutations all queue for sync', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const record = await todos.insert({ title: 'First' })
		await todos.update(record.id, { completed: true })
		await todos.insert({ title: 'Second' })

		const queue = app.getSyncEngine()?.getOutboundQueue()
		expect(queue?.totalPending).toBe(3)
	})

	test('sync status reports offline before connect', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const status = app.sync?.getStatus()
		expect(status?.status).toBe('offline')
	})

	test('sync status tracks pending operations', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		await todos.insert({ title: 'Pending op' })

		const status = app.sync?.getStatus()
		expect(status?.pendingOperations).toBe(1)
	})

	test('close stops sync engine', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		// SyncEngine is in disconnected state (not started)
		const syncEngine = app.getSyncEngine()
		expect(syncEngine?.getState()).toBe('disconnected')

		await app.close()

		// After close, getSyncEngine returns null
		expect(app.getSyncEngine()).toBeNull()
	})

	test('no sync wiring when sync not configured', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		expect(app.sync).toBeNull()
		expect(app.getSyncEngine()).toBeNull()

		// Mutations should still work (local-only)
		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const record = await todos.insert({ title: 'Local only' })
		expect(record.title).toBe('Local only')
	})

	test('operation:created events include correct operation data', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'wss://localhost:9999' },
		})
		await app.ready

		const operations: Operation[] = []
		app.events.on('operation:created', (e) => operations.push(e.operation))

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		await todos.insert({ title: 'Op test' })

		expect(operations.length).toBe(1)
		const op = operations[0]
		expect(op).toBeDefined()
		expect(op?.type).toBe('insert')
		expect(op?.collection).toBe('todos')
		expect(op?.data).toBeDefined()
		expect((op?.data as Record<string, unknown>)?.title).toBe('Op test')
	})
})
