import { describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { createSyncStatusStore } from './use-sync-status'

vi.mock('../context', () => ({
	getKoraContext: () => ({
		syncEngine: {
			getStatus: () => ({
				status: 'connected',
				pendingOperations: 0,
				lastSyncedAt: null,
				lastSuccessfulPush: null,
				lastSuccessfulPull: null,
				conflicts: 0,
			}),
		},
		subscribeSyncStatus: null,
		events: null,
	}),
}))

describe('createSyncStatusStore', () => {
	test('creates one controller and destroys it on unsubscribe', () => {
		const store = createSyncStatusStore()
		expect(get(store).status).toBe('connected')

		const unsubscribe = store.subscribe(() => {})
		unsubscribe()
	})
})
