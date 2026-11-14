import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { StoreReadOnlyError } from '../errors'
import { Store } from './store'

describe('Store read-only mode', () => {
	let store: Store

	beforeEach(async () => {
		store = new Store({
			schema: minimalSchema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'device',
		})
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('refuses local writes with the reason, before anything is recorded', async () => {
		store.setReadOnly('previewing as Ama')
		expect(store.getReadOnlyReason()).toBe('previewing as Ama')
		const error = await store
			.collection('todos')
			.insert({ title: 'x' })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(StoreReadOnlyError)
		expect((error as StoreReadOnlyError).reason).toBe('previewing as Ama')
		expect((error as Error).message).toContain('previewing as Ama')
		await expect(
			store.transaction(async (tx) => {
				await tx.collection('todos').insert({ title: 'y' })
			}),
		).rejects.toMatchObject({ code: 'STORE_READ_ONLY' })
		expect(await store.collection('todos').where({}).exec()).toHaveLength(0)
	})

	test('incoming changes from other devices still apply while read-only', async () => {
		store.setReadOnly('previewing as Ama')
		const op: Operation = {
			id: 'remote-op-1',
			nodeId: 'other-device',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-1',
			data: { title: 'From the other till' },
			previousData: null,
			timestamp: { wallTime: 1, logical: 0, nodeId: 'other-device' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}
		await store.applyRemoteOperation(op)
		expect((await store.collection('todos').findById('rec-1'))?.title).toBe('From the other till')
	})

	test('null or a blank reason makes it writable again', async () => {
		store.setReadOnly('x')
		store.setReadOnly(null)
		await expect(store.collection('todos').insert({ title: 'ok' })).resolves.toMatchObject({
			title: 'ok',
		})
		store.setReadOnly('  ')
		expect(store.getReadOnlyReason()).toBeNull()
	})
})
