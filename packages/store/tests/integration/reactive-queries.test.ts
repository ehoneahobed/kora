import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'
import type { CollectionRecord } from '../../src/types'
import { minimalSchema } from '../fixtures/test-schema'

/** Wait for microtask + async flush to complete */
async function tick(ms = 15): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe('Integration: Reactive queries', () => {
	let store: Store

	beforeEach(async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'reactive-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('subscribe receives initial results', async () => {
		const todos = store.collection('todos')
		await todos.insert({ title: 'Existing' })

		const results: CollectionRecord[][] = []
		const unsub = todos.where({}).subscribe((r) => results.push([...r]))

		await tick()

		expect(results).toHaveLength(1)
		expect(results[0]).toHaveLength(1)
		expect(results[0]?.[0]?.title).toBe('Existing')

		unsub()
	})

	test('subscribe fires on matching insert', async () => {
		const todos = store.collection('todos')
		const results: CollectionRecord[][] = []
		const unsub = todos.where({ completed: false }).subscribe((r) => results.push([...r]))

		await tick()
		expect(results).toHaveLength(1)
		expect(results[0]).toHaveLength(0)

		// Insert matching record
		await todos.insert({ title: 'New todo' })
		await tick()

		expect(results).toHaveLength(2)
		expect(results[1]).toHaveLength(1)

		unsub()
	})

	test('subscribe does not fire on non-matching insert', async () => {
		const todos = store.collection('todos')
		const results: CollectionRecord[][] = []
		const unsub = todos.where({ completed: true }).subscribe((r) => results.push([...r]))

		await tick()
		expect(results).toHaveLength(1) // initial (empty)

		// Insert non-matching record
		await todos.insert({ title: 'Not completed' })
		await tick()

		// Should still be 1 — no change in result set (both are empty)
		expect(results).toHaveLength(1)

		unsub()
	})

	test('subscribe fires when update changes matching status', async () => {
		const todos = store.collection('todos')
		const record = await todos.insert({ title: 'Toggle' })

		const results: CollectionRecord[][] = []
		const unsub = todos.where({ completed: false }).subscribe((r) => results.push([...r]))

		await tick()
		expect(results).toHaveLength(1)
		expect(results[0]).toHaveLength(1)

		// Update to non-matching
		await todos.update(record.id, { completed: true })
		await tick()

		expect(results).toHaveLength(2)
		expect(results[1]).toHaveLength(0) // no longer matches

		unsub()
	})

	test('subscribe fires on delete', async () => {
		const todos = store.collection('todos')
		const record = await todos.insert({ title: 'To delete' })

		const results: CollectionRecord[][] = []
		const unsub = todos.where({}).subscribe((r) => results.push([...r]))

		await tick()
		expect(results[0]).toHaveLength(1)

		await todos.delete(record.id)
		await tick()

		expect(results).toHaveLength(2)
		expect(results[1]).toHaveLength(0)

		unsub()
	})

	test('unsubscribe stops further notifications', async () => {
		const todos = store.collection('todos')

		const results: CollectionRecord[][] = []
		const unsub = todos.where({}).subscribe((r) => results.push([...r]))

		await tick()
		expect(results).toHaveLength(1)

		unsub()

		await todos.insert({ title: 'After unsub' })
		await tick()

		// No additional callback
		expect(results).toHaveLength(1)
	})

	test('multiple subscriptions on different conditions', async () => {
		const todos = store.collection('todos')

		const completedResults: CollectionRecord[][] = []
		const activeResults: CollectionRecord[][] = []

		const unsub1 = todos.where({ completed: true }).subscribe((r) => completedResults.push([...r]))
		const unsub2 = todos.where({ completed: false }).subscribe((r) => activeResults.push([...r]))

		await tick()

		await todos.insert({ title: 'Active', completed: false })
		await tick()

		expect(activeResults.length).toBeGreaterThanOrEqual(2)
		// Completed subscription may still be at initial (empty both times = no callback)
		const lastActive = activeResults[activeResults.length - 1]
		expect(lastActive).toHaveLength(1)

		unsub1()
		unsub2()
	})
})
