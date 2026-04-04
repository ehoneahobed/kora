import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { RecordNotFoundError } from '../../src/errors'
import { Store } from '../../src/store/store'
import { fullSchema } from '../fixtures/test-schema'

describe('Integration: CRUD operations', () => {
	let store: Store

	beforeEach(async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: fullSchema, adapter, nodeId: 'int-test-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('full CRUD lifecycle', async () => {
		const todos = store.collection('todos')

		// Insert
		const record = await todos.insert({
			title: 'Integration test',
			priority: 'high',
			tags: ['test', 'integration'],
		})
		expect(record.id).toBeDefined()
		expect(record.title).toBe('Integration test')
		expect(record.priority).toBe('high')
		expect(record.tags).toEqual(['test', 'integration'])
		expect(record.completed).toBe(false) // default
		expect(record.count).toBe(0) // default

		// FindById
		const found = await todos.findById(record.id)
		expect(found).not.toBeNull()
		expect(found?.title).toBe('Integration test')
		expect(found?.tags).toEqual(['test', 'integration'])

		// Update
		const updated = await todos.update(record.id, {
			title: 'Updated title',
			completed: true,
		})
		expect(updated.title).toBe('Updated title')
		expect(updated.completed).toBe(true)
		expect(updated.priority).toBe('high') // unchanged

		// Query
		const active = await todos.where({ completed: false }).exec()
		expect(active).toHaveLength(0)

		const completed = await todos.where({ completed: true }).exec()
		expect(completed).toHaveLength(1)

		// Delete
		await todos.delete(record.id)
		const afterDelete = await todos.findById(record.id)
		expect(afterDelete).toBeNull()

		// Count excludes deleted
		const count = await todos.where({}).exec()
		expect(count).toHaveLength(0)
	})

	test('operations are persisted in the ops log', async () => {
		const todos = store.collection('todos')
		const record = await todos.insert({ title: 'Op log test' })
		await todos.update(record.id, { title: 'Updated' })
		await todos.delete(record.id)

		// Three operations: insert, update, delete
		const ops = await store.getOperationRange('int-test-node', 1, 3)
		expect(ops).toHaveLength(3)
		expect(ops[0]?.type).toBe('insert')
		expect(ops[1]?.type).toBe('update')
		expect(ops[2]?.type).toBe('delete')
	})

	test('version vector is updated correctly', async () => {
		const todos = store.collection('todos')
		await todos.insert({ title: 'VV 1' })
		await todos.insert({ title: 'VV 2' })

		const vv = store.getVersionVector()
		expect(vv.get('int-test-node')).toBe(2)

		await todos.insert({ title: 'VV 3' })
		const vv2 = store.getVersionVector()
		expect(vv2.get('int-test-node')).toBe(3)
	})

	test('multiple collections work independently', async () => {
		const todos = store.collection('todos')
		const projects = store.collection('projects')

		await todos.insert({ title: 'Todo 1' })
		await projects.insert({ name: 'Project 1' })

		const todoResults = await todos.where({}).exec()
		const projectResults = await projects.where({}).exec()

		expect(todoResults).toHaveLength(1)
		expect(projectResults).toHaveLength(1)
	})

	test('query with operators', async () => {
		const todos = store.collection('todos')
		await todos.insert({ title: 'A', count: 1 })
		await todos.insert({ title: 'B', count: 5 })
		await todos.insert({ title: 'C', count: 10 })

		const results = await todos.where({ count: { $gt: 3 } }).exec()
		expect(results).toHaveLength(2)

		const inResults = await todos.where({ title: { $in: ['A', 'C'] } }).exec()
		expect(inResults).toHaveLength(2)
	})

	test('query with orderBy and limit', async () => {
		const todos = store.collection('todos')
		await todos.insert({ title: 'C' })
		await todos.insert({ title: 'A' })
		await todos.insert({ title: 'B' })

		const results = await todos.where({}).orderBy('title', 'asc').limit(2).exec()

		expect(results).toHaveLength(2)
		expect(results[0]?.title).toBe('A')
		expect(results[1]?.title).toBe('B')
	})
})
