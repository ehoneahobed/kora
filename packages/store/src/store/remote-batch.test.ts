import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import type { StorageAdapter, Transaction } from '../types'
import { Store } from './store'

/**
 * `Store.applyRemoteBatch` (C3): a delivery batch in one storage transaction, one
 * savepoint per step, and nothing published before the commit.
 */

/** Delegates to better-sqlite3; a statement matching `poison` fails inside transactions. */
class PoisonableAdapter extends BetterSqlite3Adapter {
	poison: ((sql: string, params: unknown[] | undefined) => boolean) | null = null
	transactions = 0

	override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		this.transactions += 1
		return super.transaction((tx) =>
			fn({
				execute: async (sql, params) => {
					if (this.poison?.(sql, params)) throw new Error(`poisoned statement: ${sql}`)
					await tx.execute(sql, params)
				},
				query: (sql, params) => tx.query(sql, params),
			}),
		)
	}
}

function insert(recordId: string, seq: number, nodeId = 'author'): Operation {
	return {
		id: `insert-${recordId}-${nodeId}`,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId,
		data: { title: recordId, completed: false },
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function update(recordId: string, seq: number, title: string): Operation {
	return {
		id: `update-${recordId}-${seq}`,
		nodeId: 'author',
		type: 'update',
		collection: 'todos',
		recordId,
		data: { title },
		previousData: { title: recordId },
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'author' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('Store.applyRemoteBatch', () => {
	let adapter: PoisonableAdapter
	let store: Store
	let emitter: SimpleEventEmitter
	let applied: string[]
	let notifications: number[]
	let unsubscribe: () => void

	beforeEach(async () => {
		adapter = new PoisonableAdapter(':memory:')
		emitter = new SimpleEventEmitter()
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'device', emitter })
		await store.open()
		applied = []
		emitter.on('operation:applied', (event) => applied.push(event.operation.id))
		notifications = []
		unsubscribe = store
			.collection('todos')
			.where({})
			.subscribe((rows) => notifications.push(rows.length))
		await new Promise((resolve) => setTimeout(resolve, 0))
		notifications.length = 0
	})

	afterEach(async () => {
		unsubscribe()
		await store.close()
	})

	const rows = async (): Promise<string[]> =>
		(await store.collection('todos').where({}).exec()).map((row) => String(row.id)).sort()
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

	test('applies every step and the watermark in one transaction, then publishes', async () => {
		const before = adapter.transactions
		const outcome = await store.applyRemoteBatch(async (batch) => {
			for (let i = 1; i <= 20; i++) await batch.applyRemoteOperation(insert(`r${i}`, i))
			await batch.saveDeliveryWatermark('', 20)
			// Nothing is published while the transaction is open.
			expect(applied).toEqual([])
			return 'done'
		})
		expect(outcome).toEqual({ value: 'done' })
		expect(adapter.transactions - before).toBe(1)
		expect(applied).toHaveLength(20)
		expect(await rows()).toHaveLength(20)
		expect(await store.loadDeliveryWatermark('')).toBe(20)
		expect(store.getVersionVector().get('author')).toBe(20)
		await settle()
		// Coalesced: the query never saw a partial batch.
		expect(notifications).toEqual([20])
	})

	test('a batch that throws mid-way leaves no operation, no watermark and publishes nothing', async () => {
		await expect(
			store.applyRemoteBatch(async (batch) => {
				for (let i = 1; i <= 5; i++) await batch.applyRemoteOperation(insert(`r${i}`, i))
				await batch.saveDeliveryWatermark('', 10)
				batch.afterCommit(() => applied.push('caller-effect'))
				throw new Error('crash before commit')
			}),
		).rejects.toThrow('crash before commit')
		await settle()
		expect(await rows()).toEqual([])
		expect(await store.loadDeliveryWatermark('')).toBe(0)
		expect(applied).toEqual([])
		expect(notifications).toEqual([])
		expect(store.getVersionVector().get('author')).toBeUndefined()
		// The log holds none of them: a re-delivery applies them as new.
		expect(await store.getOperationRange('author', 1, 5)).toEqual([])
		const outcome = await store.applyRemoteBatch(async (batch) =>
			batch.applyRemoteOperation(insert('r1', 1)),
		)
		expect(outcome).toEqual({ value: 'applied' })
	})

	test('a failing step is undone alone (its partial writes and effects) and the batch goes on', async () => {
		// The poisoned operation fails at its version-vector write, after its log row and
		// fold were written: the savepoint must take those back.
		adapter.poison = (sql, params) =>
			sql.includes('_kora_version_vector') && params?.[0] === 'poison'
		const outcome = await store.applyRemoteBatch(async (batch) => {
			await batch.applyRemoteOperation(insert('a', 1))
			const failure = await batch.applyRemoteOperation(insert('bad', 1, 'poison')).then(
				() => null,
				(error: unknown) => error,
			)
			await batch.applyRemoteOperation(insert('b', 2))
			return failure
		})
		expect(outcome?.value).toBeInstanceOf(Error)
		adapter.poison = null
		expect(await rows()).toEqual(['a', 'b'])
		expect(await store.getOperationRange('poison', 1, 1)).toEqual([])
		expect(applied).toEqual(['insert-a-author', 'insert-b-author'])
		expect(store.getVersionVector().get('poison')).toBeUndefined()
	})

	test('later steps read the batch own earlier writes (duplicate, update, retraction)', async () => {
		await store.applyRemoteBatch(async (batch) => {
			expect(await batch.applyRemoteOperation(insert('x', 1))).toBe('applied')
			expect(await batch.applyRemoteOperation(insert('x', 1))).toBe('duplicate')
			await batch.applyRemoteOperation(update('x', 2, 'renamed'))
			expect((await batch.findMaterializedRow('todos', 'x'))?.record.title).toBe('renamed')
			await batch.applyScopeRetraction('todos', 'x', 3)
			expect((await batch.findMaterializedRow('todos', 'x'))?.deleted).toBe(true)
			// Delivered after the retraction: shows the record again (#54 ordering).
			await batch.applyRemoteOperation(update('x', 4, 'back'), { deliveryPosition: 4 })
		})
		const row = await store.collection('todos').findById('x')
		expect(row?.title).toBe('back')
	})

	test('refuses to batch under the legacy materialization', async () => {
		const legacy = new Store({
			schema: minimalSchema,
			adapter: new BetterSqlite3Adapter(':memory:') as StorageAdapter,
			nodeId: 'legacy',
			materialization: 'legacy',
		})
		await legacy.open()
		expect(await legacy.applyRemoteBatch(async () => 'never')).toBeNull()
		await legacy.close()
	})
})
