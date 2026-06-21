import { op } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'
import { fullSchema } from '../fixtures/test-schema'

describe('Integration: Atomic operations', () => {
	let store: Store

	beforeEach(async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: fullSchema, adapter, nodeId: 'atomic-test-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('op.increment updates a number field', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Counter test',
			count: 10,
		})

		const updated = await todos.update(record.id, {
			count: op.increment(5),
		})
		expect(updated.count).toBe(15)

		// Verify persisted correctly
		const found = await todos.findById(record.id)
		expect(found?.count).toBe(15)
	})

	test('op.decrement updates a number field', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Decrement test',
			count: 10,
		})

		const updated = await todos.update(record.id, {
			count: op.decrement(3),
		})
		expect(updated.count).toBe(7)
	})

	test('op.increment with default value (0)', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Default count test',
			// count defaults to 0
		})
		expect(record.count).toBe(0)

		const updated = await todos.update(record.id, {
			count: op.increment(1),
		})
		expect(updated.count).toBe(1)
	})

	test('op.append adds to array field', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Tags test',
			tags: ['initial'],
		})

		const updated = await todos.update(record.id, {
			tags: op.append('new-tag'),
		})
		expect(updated.tags).toEqual(['initial', 'new-tag'])
	})

	test('op.remove removes from array field', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Tags remove test',
			tags: ['keep', 'remove-me', 'also-keep'],
		})

		const updated = await todos.update(record.id, {
			tags: op.remove('remove-me'),
		})
		expect(updated.tags).toEqual(['keep', 'also-keep'])
	})

	test('atomic ops can be mixed with regular updates', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Mixed test',
			count: 5,
			completed: false,
		})

		const updated = await todos.update(record.id, {
			count: op.increment(10),
			completed: true, // regular update
			title: 'Updated title', // regular update
		})

		expect(updated.count).toBe(15)
		expect(updated.completed).toBe(true)
		expect(updated.title).toBe('Updated title')
	})

	test('operation preserves atomicOps metadata', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Op metadata test',
			count: 10,
		})

		// Update with atomic op
		await todos.update(record.id, {
			count: op.increment(5),
		})

		// Retrieve the operation from the log using the node's sequence range
		const ops = await store.getOperationRange('atomic-test-node', 1, 100)
		const updateOps = ops.filter((o) => o.type === 'update')
		expect(updateOps).toHaveLength(1)

		const updateOp = updateOps[0]
		if (!updateOp) {
			throw new Error('expected one update operation in op log')
		}
		expect(updateOp.data).toEqual({ count: 15 })
		expect(updateOp.previousData).toEqual({ count: 10 })
		expect(updateOp.atomicOps).toEqual({
			count: { type: 'increment', value: 5 },
		})
	})

	test('multiple sequential increments accumulate', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Sequential increments',
			count: 0,
		})

		await todos.update(record.id, { count: op.increment(1) })
		await todos.update(record.id, { count: op.increment(1) })
		await todos.update(record.id, { count: op.increment(1) })

		const found = await todos.findById(record.id)
		expect(found?.count).toBe(3)
	})

	test('op.max keeps the higher value', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Max test',
			count: 50,
		})

		// Try to set max with a lower value — should keep 50
		const updated1 = await todos.update(record.id, {
			count: op.max(30),
		})
		expect(updated1.count).toBe(50)

		// Try to set max with a higher value — should update to 100
		const updated2 = await todos.update(record.id, {
			count: op.max(100),
		})
		expect(updated2.count).toBe(100)
	})

	test('op.min keeps the lower value', async () => {
		const todos = store.collection('todos')

		const record = await todos.insert({
			title: 'Min test',
			count: 50,
		})

		// Try to set min with a higher value — should keep 50
		const updated1 = await todos.update(record.id, {
			count: op.min(100),
		})
		expect(updated1.count).toBe(50)

		// Try to set min with a lower value — should update to 10
		const updated2 = await todos.update(record.id, {
			count: op.min(10),
		})
		expect(updated2.count).toBe(10)
	})
})
