import type { SyncStatusInfo } from '@korajs/sync'
import { summarizeSyncStatus } from '@korajs/sync/lite'
import { get } from 'svelte/store'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createSyncSummaryStore, useSyncSummary } from './use-sync-summary'

function makeStatus(overrides: Partial<SyncStatusInfo> = {}): SyncStatusInfo {
	return {
		status: 'offline',
		reconnecting: false,
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
	app: unknown
}
const ctx: Ctx = { syncEngine: null, subscribeSyncStatus: null, events: null, app: null }
vi.mock('../context', () => ({ getKoraContext: () => ctx }))
afterEach(() => {
	ctx.syncEngine = null
	ctx.subscribeSyncStatus = null
})

describe('createSyncSummaryStore (Svelte)', () => {
	test('is aliased as useSyncSummary', () => {
		expect(useSyncSummary).toBe(createSyncSummaryStore)
	})

	test('summarizes the live status and updates with it', () => {
		let push: (status: SyncStatusInfo) => void = () => {}
		ctx.subscribeSyncStatus = (listener) => {
			push = listener
			listener(makeStatus({ status: 'connected' }))
			return () => {}
		}
		const store = createSyncSummaryStore()
		const seen: unknown[] = []
		const stop = store.subscribe((summary) => seen.push(summary))
		expect(seen.at(-1)).toEqual(
			summarizeSyncStatus(makeStatus({ status: 'connected' }), { syncConfigured: true }),
		)
		const next = makeStatus({ status: 'syncing', pendingOperations: 4 })
		push(next)
		expect(seen.at(-1)).toEqual(summarizeSyncStatus(next, { syncConfigured: true }))
		stop()
	})

	test('says sync is not configured when there is no engine or bridge', () => {
		expect(get(createSyncSummaryStore())).toEqual(
			summarizeSyncStatus(makeStatus(), { syncConfigured: false }),
		)
	})
})
