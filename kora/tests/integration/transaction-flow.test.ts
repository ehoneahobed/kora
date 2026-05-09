import { defineSchema, t } from '@korajs/core'
import type { KoraEvent, Operation } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp, TransactionProxy } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
				count: t.number().default(0),
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

describe('Transaction flow (end-to-end)', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('app.transaction() commits multiple operations atomically', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const projects = (app as Record<string, unknown>).projects as CollectionAccessor

		const ops = await app.transaction(async (tx: TransactionProxy) => {
			await tx.todos.insert({ title: 'Task 1' })
			await tx.todos.insert({ title: 'Task 2' })
			await tx.projects.insert({ name: 'Project A' })
		})

		expect(ops.length).toBe(3)

		// All operations share same transactionId
		const txId = ops[0]?.transactionId
		expect(txId).toBeDefined()
		for (const op of ops) {
			expect(op.transactionId).toBe(txId)
		}

		// Data should be visible after commit
		const allTodos = await todos.where({}).exec()
		expect(allTodos.length).toBe(2)

		const allProjects = await projects.where({}).exec()
		expect(allProjects.length).toBe(1)
	})

	test('app.transaction() rolls back on error', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor

		// Pre-insert a record
		await todos.insert({ title: 'Existing' })

		await expect(
			app.transaction(async (tx: TransactionProxy) => {
				await tx.todos.insert({ title: 'Will be rolled back' })
				throw new Error('Intentional error')
			}),
		).rejects.toThrow('Intentional error')

		// Only the pre-existing record should be there
		const all = await todos.where({}).exec()
		expect(all.length).toBe(1)
		expect(all[0]?.title).toBe('Existing')
	})

	test('transaction emits operation:created events after commit', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const events: KoraEvent[] = []
		app.events.on('operation:created', (event) => {
			events.push(event)
		})

		await app.transaction(async (tx: TransactionProxy) => {
			await tx.todos.insert({ title: 'Event test' })
			await tx.projects.insert({ name: 'Event project' })
		})

		expect(events.length).toBe(2)
		// Both events should have the same transactionId
		const txId = (events[0] as { operation: Operation }).operation.transactionId
		expect(txId).toBeDefined()
		expect((events[1] as { operation: Operation }).operation.transactionId).toBe(txId)
	})

	test('update within transaction with existing record', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const record = await todos.insert({ title: 'Original' })

		await app.transaction(async (tx: TransactionProxy) => {
			await tx.todos.update(record.id, { title: 'Updated', completed: true })
		})

		const updated = await todos.findById(record.id)
		expect(updated?.title).toBe('Updated')
		expect(updated?.completed).toBe(true)
	})

	test('delete within transaction', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const record = await todos.insert({ title: 'To delete' })

		await app.transaction(async (tx: TransactionProxy) => {
			await tx.todos.delete(record.id)
		})

		const deleted = await todos.findById(record.id)
		expect(deleted).toBeNull()
	})

	test('insert + update same record within transaction', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor

		const ops = await app.transaction(async (tx: TransactionProxy) => {
			const record = await tx.todos.insert({ title: 'New' })
			await tx.todos.update(record.id, { completed: true })
		})

		expect(ops.length).toBe(2)

		// Record should exist with completed = true
		const allTodos = await todos.where({}).exec()
		expect(allTodos.length).toBe(1)
		expect(allTodos[0]?.completed).toBe(true)
	})

	test('insert + delete same record within transaction', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor

		await app.transaction(async (tx: TransactionProxy) => {
			const record = await tx.todos.insert({ title: 'Ephemeral' })
			await tx.todos.delete(record.id)
		})

		// Record should not exist
		const all = await todos.where({}).exec()
		expect(all.length).toBe(0)
	})

	test('app.mutation() attaches mutationName to all operations', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const ops = await app.mutation('create-todo-with-project', async (tx: TransactionProxy) => {
			await tx.todos.insert({ title: 'Mutated task' })
			await tx.projects.insert({ name: 'Mutated project' })
		})

		expect(ops.length).toBe(2)
		for (const op of ops) {
			expect(op.mutationName).toBe('create-todo-with-project')
			expect(op.transactionId).toBeDefined()
		}
	})

	test('mutation name survives serialization round-trip', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		await app.mutation('test-mutation', async (tx: TransactionProxy) => {
			await tx.todos.insert({ title: 'Named mutation' })
		})

		// Read back from store
		const storeInstance = app.getStore()
		const ops = await storeInstance.getOperationRange(storeInstance.getNodeId(), 1, 100)
		const mutOps = ops.filter((op) => op.mutationName === 'test-mutation')
		expect(mutOps.length).toBe(1)
	})

	test('transaction with atomic ops', async () => {
		const { op } = await import('@korajs/core')

		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = (app as Record<string, unknown>).todos as CollectionAccessor
		const record = await todos.insert({ title: 'Counter', count: 10 })

		await app.transaction(async (tx: TransactionProxy) => {
			await tx.todos.update(record.id, { count: op.increment(5) })
		})

		const updated = await todos.findById(record.id)
		expect(updated?.count).toBe(15)
	})
})
