import { describe, expect, test } from 'vitest'
import type { SyncStatusInfo } from '../types'
import { summarizeSyncStatus } from './summarize'

const status = (overrides: Partial<SyncStatusInfo>): SyncStatusInfo => ({
	status: 'synced',
	reconnecting: false,
	pendingOperations: 0,
	lastSyncedAt: 1000,
	lastSuccessfulPush: null,
	lastSuccessfulPull: null,
	conflicts: 0,
	clockSkewMs: null,
	...overrides,
})

describe('summarizeSyncStatus', () => {
	test('synced with nothing pending is ok; pending writes are never called synced', () => {
		expect(summarizeSyncStatus(status({}))).toMatchObject({
			state: 'synced',
			tone: 'ok',
			title: 'Synced',
		})
		const saving = summarizeSyncStatus(status({ pendingOperations: 3 }))
		expect(saving).toMatchObject({ state: 'saving', tone: 'working', pending: 3 })
		expect(saving.detail).toBe('3 changes on the way to the server')
	})

	test('offline is calm: working tone, and the detail says the data is on this device', () => {
		expect(summarizeSyncStatus(status({ status: 'offline' }))).toMatchObject({
			tone: 'working',
			title: 'Offline',
			detail: 'Everything is saved on this device',
		})
		expect(summarizeSyncStatus(status({ status: 'offline', pendingOperations: 1 })).detail).toBe(
			'1 change saved on this device',
		)
	})

	test('a first download in progress is downloading, so apps do not show an empty state', () => {
		const summary = summarizeSyncStatus(
			status({
				status: 'syncing',
				initialSync: { complete: false, receivedBatches: 1, totalBatches: 4, progress: 0.25 },
			}),
		)
		expect(summary).toMatchObject({ state: 'downloading', downloading: true, progress: 0.25 })
		expect(summary.detail).toBe('Getting your data · 25%')
		expect(
			summarizeSyncStatus(
				status({
					initialSync: { complete: true, receivedBatches: 4, totalBatches: 4, progress: 1 },
				}),
			).downloading,
		).toBe(false)
	})

	test('states someone must act on have the attention tone', () => {
		for (const s of [
			'auth-required',
			'encryption-locked',
			'clock-error',
			'schema-mismatch',
			'error',
		] as const) {
			expect(summarizeSyncStatus(status({ status: s })).tone).toBe('attention')
		}
		expect(summarizeSyncStatus(status({ localDurability: 'degraded' })).state).toBe(
			'storage-at-risk',
		)
	})

	test('an app without sync is local only and ok', () => {
		expect(
			summarizeSyncStatus(status({ status: 'offline' }), { syncConfigured: false }),
		).toMatchObject({
			state: 'local-only',
			tone: 'ok',
		})
	})
})
