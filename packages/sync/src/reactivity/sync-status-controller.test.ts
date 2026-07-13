import type { KoraEventEmitter } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { SyncStatusInfo } from '../types'
import { createSyncStatusController, OFFLINE_SYNC_STATUS } from './sync-status-controller'

function createStatus(overrides: Partial<SyncStatusInfo> = {}): SyncStatusInfo {
	return {
		status: 'connected',
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		...overrides,
	}
}

describe('createSyncStatusController', () => {
	test('returns offline status without sync engine', () => {
		const controller = createSyncStatusController({
			syncEngine: null,
			subscribeSyncStatus: null,
			events: null,
		})

		expect(controller.getSnapshot()).toEqual(OFFLINE_SYNC_STATUS)
		controller.destroy()
	})

	test('uses subscribeSyncStatus bridge when provided', () => {
		let listener: ((status: SyncStatusInfo) => void) | null = null
		const controller = createSyncStatusController({
			subscribeSyncStatus: (onStatus) => {
				listener = onStatus
				onStatus(createStatus({ status: 'syncing' }))
				return () => {
					listener = null
				}
			},
			events: null,
		})

		expect(controller.getSnapshot().status).toBe('syncing')
		listener?.(createStatus({ status: 'synced' }))
		expect(controller.getSnapshot().status).toBe('synced')
		controller.destroy()
	})

	test('reads live engine status when no bridge is available', () => {
		const getStatus = vi
			.fn()
			.mockReturnValueOnce(createStatus({ status: 'connected' }))
			.mockReturnValueOnce(createStatus({ status: 'synced' }))
		const engine = { getStatus }

		const controller = createSyncStatusController({
			syncEngine: engine,
			subscribeSyncStatus: null,
			events: null,
		})

		expect(getStatus).toHaveBeenCalled()
		expect(controller.getSnapshot().status).toBe('synced')
		controller.destroy()
	})

	test('refreshes on sync events when emitter is available', () => {
		const handlers = new Map<string, Set<() => void>>()
		const events = {
			on: (type: string, handler: () => void) => {
				const set = handlers.get(type) ?? new Set()
				set.add(handler)
				handlers.set(type, set)
				return () => set.delete(handler)
			},
		} as KoraEventEmitter

		const getStatus = vi
			.fn()
			.mockReturnValueOnce(createStatus({ status: 'connected' }))
			.mockReturnValueOnce(createStatus({ status: 'syncing' }))
		const engine = { getStatus }

		const controller = createSyncStatusController({
			syncEngine: engine,
			subscribeSyncStatus: null,
			events,
		})

		expect(controller.getSnapshot().status).toBe('connected')
		for (const handler of handlers.get('sync:sent') ?? []) {
			handler()
		}
		expect(controller.getSnapshot().status).toBe('syncing')
		controller.destroy()
	})
})
