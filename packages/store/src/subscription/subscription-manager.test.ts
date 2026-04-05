import type { Operation } from '@korajs/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CollectionRecord } from '../types'
import { SubscriptionManager } from './subscription-manager'

function makeOp(collection: string): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'insert',
		collection,
		recordId: 'rec-1',
		data: { title: 'Test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('SubscriptionManager', () => {
	let manager: SubscriptionManager

	beforeEach(() => {
		manager = new SubscriptionManager()
	})

	test('register returns an unsubscribe function', () => {
		const unsub = manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)
		expect(typeof unsub).toBe('function')
		expect(manager.size).toBe(1)

		unsub()
		expect(manager.size).toBe(0)
	})

	test('notify + flush calls callback with new results', async () => {
		const results: CollectionRecord[][] = []
		const mockData: CollectionRecord[] = [
			{ id: 'rec-1', title: 'Test', createdAt: 1000, updatedAt: 1000 },
		]

		manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			(r) => results.push([...r]),
			async () => mockData,
		)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		expect(results).toHaveLength(1)
		expect(results[0]).toEqual(mockData)
	})

	test('does not call callback if results unchanged', async () => {
		const callback = vi.fn()
		const data: CollectionRecord[] = [
			{ id: 'rec-1', title: 'Test', createdAt: 1000, updatedAt: 1000 },
		]

		const unsub = manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			callback,
			async () => data,
		)

		// First flush: callback called (lastResults was [])
		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(1)

		// Second flush with same data: callback NOT called
		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(1)

		unsub()
	})

	test('calls callback when results change', async () => {
		const callback = vi.fn()
		let data: CollectionRecord[] = [{ id: 'rec-1', title: 'V1', createdAt: 1000, updatedAt: 1000 }]

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => data)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(1)

		// Change data
		data = [{ id: 'rec-1', title: 'V2', createdAt: 1000, updatedAt: 2000 }]
		manager.notify('todos', makeOp('todos'))
		await manager.flush()
		expect(callback).toHaveBeenCalledTimes(2)
		expect(callback).toHaveBeenLastCalledWith(data)
	})

	test('only notifies subscriptions for the affected collection', async () => {
		const todoCallback = vi.fn()
		const projectCallback = vi.fn()

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, todoCallback, async () => [
			{ id: 'r1', title: 'T', createdAt: 1000, updatedAt: 1000 },
		])
		manager.register(
			{ collection: 'projects', where: {}, orderBy: [] },
			projectCallback,
			async () => [{ id: 'r2', name: 'P', createdAt: 1000, updatedAt: 1000 }],
		)

		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		expect(todoCallback).toHaveBeenCalledTimes(1)
		expect(projectCallback).not.toHaveBeenCalled()
	})

	test('batches multiple notifications in same flush', async () => {
		const callback = vi.fn()
		let callCount = 0

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => {
			callCount++
			return [{ id: `r${callCount}`, title: `T${callCount}`, createdAt: 1000, updatedAt: 1000 }]
		})

		// Two notifications before flush
		manager.notify('todos', makeOp('todos'))
		manager.notify('todos', makeOp('todos'))
		await manager.flush()

		// Should execute only once despite two notifications
		expect(callCount).toBe(1)
		expect(callback).toHaveBeenCalledTimes(1)
	})

	test('microtask-based auto-flush', async () => {
		const callback = vi.fn()
		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => [
			{ id: 'r1', title: 'T', createdAt: 1000, updatedAt: 1000 },
		])

		manager.notify('todos', makeOp('todos'))

		// Wait for microtask to flush
		await new Promise<void>((resolve) => queueMicrotask(resolve))
		// Need another tick for the async flush to complete
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(callback).toHaveBeenCalledTimes(1)
	})

	test('clear removes all subscriptions', () => {
		manager.register(
			{ collection: 'todos', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)
		manager.register(
			{ collection: 'projects', where: {}, orderBy: [] },
			() => {},
			async () => [],
		)

		expect(manager.size).toBe(2)
		manager.clear()
		expect(manager.size).toBe(0)
	})

	test('handles executeFn errors gracefully', async () => {
		const callback = vi.fn()

		manager.register({ collection: 'todos', where: {}, orderBy: [] }, callback, async () => {
			throw new Error('Query failed')
		})

		manager.notify('todos', makeOp('todos'))
		// Should not throw
		await manager.flush()
		expect(callback).not.toHaveBeenCalled()
	})

	test('empty flush is a no-op', async () => {
		await manager.flush() // should not throw
	})
})
