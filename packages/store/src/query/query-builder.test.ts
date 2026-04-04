import { HybridLogicalClock } from '@kora/core'
import type { Operation } from '@kora/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTestAdapter } from '../../tests/fixtures/test-adapter'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import type { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Collection } from '../collection/collection'
import { SubscriptionManager } from '../subscription/subscription-manager'
import { QueryBuilder } from './query-builder'

describe('QueryBuilder', () => {
	let adapter: BetterSqlite3Adapter
	let clock: HybridLogicalClock
	let subManager: SubscriptionManager
	let collection: Collection
	let seq: number
	const nodeId = 'test-node-1'

	beforeEach(async () => {
		adapter = await createTestAdapter()
		clock = new HybridLogicalClock(nodeId)
		subManager = new SubscriptionManager()
		seq = 0

		const def = minimalSchema.collections.todos
		if (!def) throw new Error('Missing todos')
		collection = new Collection(
			'todos',
			def,
			minimalSchema,
			adapter,
			clock,
			nodeId,
			() => ++seq,
			(col, op) => subManager.notify(col, op),
		)
	})

	afterEach(async () => {
		subManager.clear()
		await adapter.close()
	})

	function createBuilder() {
		const def = minimalSchema.collections.todos
		if (!def) throw new Error('Missing todos')
		return new QueryBuilder('todos', def, adapter, subManager)
	}

	describe('exec', () => {
		test('returns all non-deleted records', async () => {
			await collection.insert({ title: 'A' })
			await collection.insert({ title: 'B' })

			const results = await createBuilder().exec()
			expect(results).toHaveLength(2)
		})

		test('filters with where clause', async () => {
			await collection.insert({ title: 'Done', completed: true })
			await collection.insert({ title: 'Not done' })

			const results = await createBuilder().where({ completed: false }).exec()
			expect(results).toHaveLength(1)
			expect(results[0]?.title).toBe('Not done')
		})

		test('orders results', async () => {
			await collection.insert({ title: 'B' })
			await collection.insert({ title: 'A' })

			const results = await createBuilder().orderBy('title', 'asc').exec()
			expect(results[0]?.title).toBe('A')
			expect(results[1]?.title).toBe('B')
		})

		test('limits results', async () => {
			await collection.insert({ title: 'A' })
			await collection.insert({ title: 'B' })
			await collection.insert({ title: 'C' })

			const results = await createBuilder().limit(2).exec()
			expect(results).toHaveLength(2)
		})

		test('offsets results', async () => {
			await collection.insert({ title: 'A' })
			await collection.insert({ title: 'B' })
			await collection.insert({ title: 'C' })

			const results = await createBuilder().orderBy('title', 'asc').offset(1).limit(2).exec()
			expect(results).toHaveLength(2)
			expect(results[0]?.title).toBe('B')
		})

		test('chains where, orderBy, limit', async () => {
			await collection.insert({ title: 'B', completed: true })
			await collection.insert({ title: 'A' })
			await collection.insert({ title: 'C' })

			const results = await createBuilder()
				.where({ completed: false })
				.orderBy('title', 'asc')
				.limit(1)
				.exec()

			expect(results).toHaveLength(1)
			expect(results[0]?.title).toBe('A')
		})

		test('excludes soft-deleted records', async () => {
			const rec = await collection.insert({ title: 'To delete' })
			await collection.insert({ title: 'Keep' })
			await collection.delete(rec.id)

			const results = await createBuilder().exec()
			expect(results).toHaveLength(1)
			expect(results[0]?.title).toBe('Keep')
		})
	})

	describe('count', () => {
		test('returns total count', async () => {
			await collection.insert({ title: 'A' })
			await collection.insert({ title: 'B' })

			const count = await createBuilder().count()
			expect(count).toBe(2)
		})

		test('returns filtered count', async () => {
			await collection.insert({ title: 'A', completed: true })
			await collection.insert({ title: 'B' })

			const count = await createBuilder().where({ completed: false }).count()
			expect(count).toBe(1)
		})

		test('excludes deleted records', async () => {
			const rec = await collection.insert({ title: 'To delete' })
			await collection.insert({ title: 'Keep' })
			await collection.delete(rec.id)

			const count = await createBuilder().count()
			expect(count).toBe(1)
		})
	})

	describe('subscribe', () => {
		test('calls callback immediately with current results', async () => {
			await collection.insert({ title: 'Existing' })

			const results: number[] = []
			const unsub = createBuilder().subscribe((r) => results.push(r.length))

			// Wait for the initial async callback
			await new Promise<void>((resolve) => setTimeout(resolve, 10))

			expect(results).toHaveLength(1)
			expect(results[0]).toBe(1)

			unsub()
		})

		test('calls callback after new insert', async () => {
			const results: number[] = []
			const unsub = createBuilder().subscribe((r) => results.push(r.length))

			// Wait for initial
			await new Promise<void>((resolve) => setTimeout(resolve, 10))
			expect(results[0]).toBe(0)

			// Insert triggers notification via onMutation -> subManager.notify
			await collection.insert({ title: 'New' })
			// The notify schedules a microtask flush — wait for it
			await new Promise<void>((resolve) => setTimeout(resolve, 10))

			expect(results).toHaveLength(2)
			expect(results[1]).toBe(1)

			unsub()
		})

		test('unsubscribe stops notifications', async () => {
			const callback = vi.fn()
			const unsub = createBuilder().subscribe(callback)

			await new Promise<void>((resolve) => setTimeout(resolve, 10))
			unsub()

			await collection.insert({ title: 'After unsub' })
			await subManager.flush()

			// Only initial call
			expect(callback).toHaveBeenCalledTimes(1)
		})
	})

	describe('immutability', () => {
		test('where returns a new QueryBuilder', () => {
			const qb1 = createBuilder()
			const qb2 = qb1.where({ completed: true })
			expect(qb1).not.toBe(qb2)
			expect(qb1.getDescriptor().where).toEqual({})
			expect(qb2.getDescriptor().where).toEqual({ completed: true })
		})

		test('orderBy returns a new QueryBuilder', () => {
			const qb1 = createBuilder()
			const qb2 = qb1.orderBy('title')
			expect(qb1.getDescriptor().orderBy).toEqual([])
			expect(qb2.getDescriptor().orderBy).toHaveLength(1)
		})
	})
})
