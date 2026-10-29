import type { KoraEvent, Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTestAdapter } from '../../tests/fixtures/test-adapter'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import type { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { PersistenceError } from '../errors'
import { Store } from './store'

describe('Store write durability state', () => {
	let adapter: BetterSqlite3Adapter & { ensureDurable?: () => Promise<void> }
	let store: Store
	let events: KoraEvent[]

	beforeEach(async () => {
		adapter = await createTestAdapter()
		const emitter = new SimpleEventEmitter()
		events = []
		emitter.on('store:write-durability', (event) => events.push(event))
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'durability-test', emitter })
		await store.open()
	})

	afterEach(async () => {
		// A test may leave a rejecting mock installed; closing the native adapter does
		// not need the IndexedDB-only barrier.
		adapter.ensureDurable = undefined
		await store.close()
	})

	test('reports restored after a later successful barrier for a transient failure', async () => {
		adapter.ensureDurable = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new PersistenceError('quota exceeded'))
			.mockResolvedValue(undefined)

		await expect(store.collection('todos').insert({ title: 'first' })).rejects.toMatchObject({
			code: 'WRITE_NOT_DURABLE',
		})
		await store.collection('todos').insert({ title: 'second' })

		expect(events.map((event) => ('state' in event ? event.state : null))).toEqual([
			'failing',
			'restored',
		])
	})

	test('never reports restored in the same store after its snapshot lineage is superseded', async () => {
		adapter.ensureDurable = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(
				new PersistenceError('snapshot refused', { code: 'SNAPSHOT_SUPERSEDED' }),
			)
			.mockResolvedValue(undefined)

		await expect(
			store.collection('todos').insert({ title: 'stale lineage' }),
		).rejects.toMatchObject({
			code: 'WRITE_NOT_DURABLE',
		})
		await store.collection('todos').insert({ title: 'defensive later barrier' })

		expect(events.map((event) => ('state' in event ? event.state : null))).toEqual(['failing'])
	})

	test('uses one barrier for insertMany and one for an outer transaction', async () => {
		adapter.ensureDurable = vi.fn().mockResolvedValue(undefined)

		await store.collection('todos').insertMany([{ title: 'one' }, { title: 'two' }])
		expect(adapter.ensureDurable).toHaveBeenCalledTimes(1)

		await store.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'three' })
			await tx.collection('todos').insert({ title: 'four' })
		})
		expect(adapter.ensureDurable).toHaveBeenCalledTimes(2)
	})

	test('does not await a local durability barrier for remote sync applies', async () => {
		adapter.ensureDurable = vi.fn().mockResolvedValue(undefined)
		const remote: Operation = {
			id: 'remote-insert-1',
			nodeId: 'remote-device',
			type: 'insert',
			collection: 'todos',
			recordId: 'remote-record-1',
			data: { title: 'remote', completed: false },
			previousData: null,
			timestamp: { wallTime: 1_000, logical: 0, nodeId: 'remote-device' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}

		await expect(store.applyRemoteOperation(remote)).resolves.toBe('applied')
		expect(adapter.ensureDurable).not.toHaveBeenCalled()
	})
})
