import type { SyncStatusInfo } from '@korajs/sync'
import { get } from 'svelte/store'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createSyncStatusStore, useSyncStatus } from './use-sync-status'

function makeStatus(overrides: Partial<SyncStatusInfo> = {}): SyncStatusInfo {
	return {
		status: 'offline',
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		clockSkewMs: null,
		...overrides,
	}
}

interface Ctx {
	syncEngine: { getStatus(): SyncStatusInfo } | null
	subscribeSyncStatus: ((listener: (status: SyncStatusInfo) => void) => () => void) | null
	events: unknown
}

const ctx: Ctx = { syncEngine: null, subscribeSyncStatus: null, events: null }

vi.mock('../context', () => ({
	getKoraContext: () => ctx,
}))

afterEach(() => {
	ctx.syncEngine = null
	ctx.subscribeSyncStatus = null
	ctx.events = null
})

describe('createSyncStatusStore', () => {
	test('is aliased as useSyncStatus', () => {
		expect(useSyncStatus).toBe(createSyncStatusStore)
	})

	test('reports offline when no sync engine is configured', () => {
		const store = createSyncStatusStore()
		expect(get(store).status).toBe('offline')
	})

	test('reads live status from the sync engine', () => {
		ctx.syncEngine = { getStatus: () => makeStatus({ status: 'connected', pendingOperations: 2 }) }
		const store = createSyncStatusStore()
		const value = get(store)
		expect(value.status).toBe('connected')
		expect(value.pendingOperations).toBe(2)
	})

	test('reactively updates when a status bridge pushes changes', () => {
		let push: (status: SyncStatusInfo) => void = () => {}
		ctx.subscribeSyncStatus = (listener) => {
			push = listener
			listener(makeStatus({ status: 'syncing' }))
			return () => {}
		}

		const store = createSyncStatusStore()
		const seen: string[] = []
		const stop = store.subscribe((status) => seen.push(status.status))

		expect(seen.at(-1)).toBe('syncing')
		push(makeStatus({ status: 'synced', pendingOperations: 1 }))
		expect(seen.at(-1)).toBe('synced')
		expect(get(store).pendingOperations).toBe(1)
		stop()
	})

	test('unsubscribes from the status bridge when the store stops', () => {
		const unsubscribe = vi.fn()
		ctx.subscribeSyncStatus = (listener) => {
			listener(makeStatus())
			return unsubscribe
		}

		const store = createSyncStatusStore()
		const stop = store.subscribe(() => {})
		stop()
		expect(unsubscribe).toHaveBeenCalled()
	})
})
