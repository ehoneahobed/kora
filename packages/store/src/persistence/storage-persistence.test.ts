import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import { StoragePersistence } from './storage-persistence'

function recorder(): { emitter: SimpleEventEmitter; events: KoraEvent[] } {
	const emitter = new SimpleEventEmitter()
	const events: KoraEvent[] = []
	emitter.on('storage:persistence', (event) => events.push(event))
	return { emitter, events }
}

describe('StoragePersistence (NEW-STORE-4)', () => {
	test('check() reads persisted() and never calls persist()', async () => {
		let persistCalls = 0
		const { emitter, events } = recorder()
		const p = new StoragePersistence({
			emitter,
			storage: {
				persisted: async () => false,
				persist: async () => {
					persistCalls++
					return true
				},
			},
		})
		expect(p.status().state).toBe('unknown')
		const status = await p.check()
		expect(status).toEqual({ state: 'best-effort', persisted: false, requested: false })
		expect(persistCalls).toBe(0)
		expect(events).toEqual([{ type: 'storage:persistence', state: 'checked', persisted: false }])
	})

	test('request() surfaces the grant through status and the event', async () => {
		const { emitter, events } = recorder()
		const p = new StoragePersistence({
			emitter,
			storage: { persisted: async () => false, persist: async () => true },
		})
		const status = await p.request()
		expect(status).toEqual({ state: 'persisted', persisted: true, requested: true })
		expect(events.at(-1)).toEqual({
			type: 'storage:persistence',
			state: 'requested',
			persisted: true,
		})
	})

	test('a pending prompt never blocks: requestInBackground returns at once and dedups', async () => {
		let calls = 0
		const p = new StoragePersistence({
			storage: {
				persisted: async () => false,
				persist: () => {
					calls++
					return new Promise<boolean>(() => {})
				},
			},
		})
		p.requestInBackground('first-write')
		p.requestInBackground('sign-in')
		void p.request()
		expect(calls).toBe(1)
		expect(p.status()).toMatchObject({ state: 'unknown', requested: true })
	})

	test('a throwing persist()/persisted() becomes state "error", never a rejection', async () => {
		const { emitter, events } = recorder()
		const p = new StoragePersistence({
			emitter,
			storage: {
				persisted: async () => {
					throw new Error('denied')
				},
				persist: async () => {
					throw new Error('nope')
				},
			},
		})
		await expect(p.check()).resolves.toMatchObject({ state: 'error', lastError: 'denied' })
		await expect(p.request()).resolves.toMatchObject({ state: 'error', lastError: 'nope' })
		expect(events.map((e) => (e.type === 'storage:persistence' ? e.state : ''))).toEqual([
			'error',
			'error',
		])
	})

	test('no StorageManager: unsupported, and no event outside browsers', async () => {
		const { emitter, events } = recorder()
		const p = new StoragePersistence({ emitter, storage: null })
		await expect(p.check()).resolves.toMatchObject({ state: 'unsupported' })
		await expect(p.request()).resolves.toMatchObject({ state: 'unsupported' })
		expect(events).toEqual([])
	})

	test('a later check never downgrades a granted request', async () => {
		let granted = false
		const p = new StoragePersistence({
			storage: {
				persisted: async () => false,
				persist: async () => {
					granted = true
					return true
				},
			},
		})
		await p.request()
		await p.check()
		expect(granted).toBe(true)
		expect(p.status().persisted).toBe(true)
	})
})
