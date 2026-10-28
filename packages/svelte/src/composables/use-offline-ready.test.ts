import { OFFLINE_STATUS_UNKNOWN, type OfflineStatus } from '@korajs/core/bindings'
import { get } from 'svelte/store'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createOfflineReadyStore, useOfflineReady } from './use-offline-ready'

const ctx: { app: unknown } = { app: null }

vi.mock('../context', () => ({
	getKoraContext: () => ctx,
}))

afterEach(() => {
	ctx.app = null
})

describe('createOfflineReadyStore', () => {
	test('is aliased as useOfflineReady', () => {
		expect(useOfflineReady).toBe(createOfflineReadyStore)
	})

	test('is not ready without app.offline', () => {
		expect(get(createOfflineReadyStore()).state).toBe('not-ready')
	})

	test('follows app.offline and stops when the last subscriber leaves', () => {
		let current: OfflineStatus = {
			...OFFLINE_STATUS_UNKNOWN,
			state: 'preparing',
			reasons: ['data-syncing'],
		}
		const listeners = new Set<(next: OfflineStatus) => void>()
		ctx.app = {
			offline: {
				status: () => current,
				subscribe: (listener: (next: OfflineStatus) => void) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
			},
		}
		const store = createOfflineReadyStore()
		const seen: string[] = []
		const stop = store.subscribe((status) => seen.push(status.state))
		current = { ...OFFLINE_STATUS_UNKNOWN, state: 'ready', reasons: [] }
		for (const listener of listeners) listener(current)
		expect(seen).toEqual(['preparing', 'ready'])
		stop()
		expect(listeners.size).toBe(0)
	})
})
