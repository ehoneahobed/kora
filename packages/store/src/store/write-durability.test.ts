import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { PersistenceError, WriteNotDurableError } from '../errors'
import { Store } from './store'

/** An adapter whose durability barrier the test controls, like the IndexedDB fallback's. */
class BarrierAdapter extends BetterSqlite3Adapter {
	barrierCalls = 0
	failWith: unknown = null
	gate: Promise<void> | null = null

	async ensureDurable(): Promise<void> {
		this.barrierCalls++
		if (this.gate) await this.gate
		if (this.failWith) throw this.failWith
	}
}

describe('durable local writes (offline readiness A0)', () => {
	let store: Store | null = null
	afterEach(async () => {
		await store?.close()
		store = null
	})

	async function open(
		adapter: BetterSqlite3Adapter,
	): Promise<{ store: Store; events: KoraEvent[] }> {
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('store:write-durability', (event) => events.push(event))
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'n1', emitter })
		await store.open()
		return { store, events }
	}

	test('a write resolves only after the barrier, and is visible before it', async () => {
		const adapter = new BarrierAdapter(':memory:')
		const { store: s } = await open(adapter)
		let release: () => void = () => {}
		adapter.gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let resolved = false
		const pending = s
			.collection('todos')
			.insert({ title: 'a' })
			.then((row) => {
				resolved = true
				return row
			})
		await new Promise((r) => setTimeout(r, 20))
		expect(resolved).toBe(false)
		// Visible while the barrier is still pending.
		expect(await s.collection('todos').where({}).count()).toBe(1)
		release()
		await pending
		expect(resolved).toBe(true)
	})

	test('an adapter without a barrier pays nothing', async () => {
		const { store: s } = await open(new BetterSqlite3Adapter(':memory:'))
		await s.collection('todos').insert({ title: 'a' })
		expect(s.getWriteDurability().state).toBe('durable')
	})

	test('insertMany and transaction wait once for the whole write', async () => {
		const adapter = new BarrierAdapter(':memory:')
		const { store: s } = await open(adapter)
		await s.collection('todos').insertMany([{ title: 'a' }, { title: 'b' }, { title: 'c' }])
		expect(adapter.barrierCalls).toBe(1)
		await s.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'd' })
			await tx.collection('todos').insert({ title: 'e' })
		})
		expect(adapter.barrierCalls).toBe(2)
	})

	test('a failed save rejects with WriteNotDurableError, keeps the write, and recovers', async () => {
		const adapter = new BarrierAdapter(':memory:')
		const { store: s, events } = await open(adapter)
		adapter.failWith = new PersistenceError('quota', { quotaExceeded: true })
		const error = await s
			.collection('todos')
			.insert({ title: 'kept' })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(WriteNotDurableError)
		const failure = error as WriteNotDurableError
		expect(failure.code).toBe('WRITE_NOT_DURABLE')
		expect(failure.reason).toBe('save-failed')
		expect(failure.operationId).toBeTruthy()
		// Not rolled back: the record exists and must not be retried.
		expect(await s.collection('todos').where({ title: 'kept' }).count()).toBe(1)
		expect(s.getWriteDurability().state).toBe('failing')
		expect(events.at(-1)).toMatchObject({ state: 'failing', reason: 'save-failed' })

		adapter.failWith = null
		await s.collection('todos').insert({ title: 'next' })
		expect(s.getWriteDurability().state).toBe('durable')
		expect(events.at(-1)).toMatchObject({ state: 'durable' })
	})

	test('a superseded snapshot reports snapshot-superseded', async () => {
		const adapter = new BarrierAdapter(':memory:')
		const { store: s } = await open(adapter)
		adapter.failWith = new PersistenceError('replaced', { code: 'SNAPSHOT_SUPERSEDED' })
		const error = await s
			.collection('todos')
			.insert({ title: 'x' })
			.catch((e: unknown) => e)
		expect((error as WriteNotDurableError).reason).toBe('snapshot-superseded')
		expect(s.getWriteDurability()).toMatchObject({
			state: 'failing',
			reason: 'snapshot-superseded',
		})
	})
})
