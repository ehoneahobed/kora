import type { KoraEventEmitter } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import type { SyncStatusInfo } from '../types'
import {
	OFFLINE_SYNC_STATUS,
	createSyncStatusController,
	stabilizeSyncStatus,
} from './sync-status-controller'

function createStatus(overrides: Partial<SyncStatusInfo> = {}): SyncStatusInfo {
	return {
		...OFFLINE_SYNC_STATUS,
		status: 'connected',
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
		const listeners: Array<(status: SyncStatusInfo) => void> = []
		const controller = createSyncStatusController({
			subscribeSyncStatus: (onStatus) => {
				listeners.push(onStatus)
				onStatus(createStatus({ status: 'syncing' }))
				return () => {
					listeners.length = 0
				}
			},
			events: null,
		})

		expect(controller.getSnapshot().status).toBe('syncing')
		for (const listener of listeners) {
			listener(createStatus({ status: 'synced' }))
		}
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
		const events: KoraEventEmitter = {
			on: (type, handler) => {
				const set = handlers.get(type) ?? new Set()
				set.add(handler as () => void)
				handlers.set(type, set)
				return () => set.delete(handler as () => void)
			},
			off: (type, handler) => {
				handlers.get(type)?.delete(handler as () => void)
			},
			emit: () => {},
		}

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

describe('stable status identities (DX-5)', () => {
	test('live engine reads return the same object while the status is unchanged', () => {
		const engine = { getStatus: vi.fn(() => createStatus({ status: 'synced' })) }
		const controller = createSyncStatusController({
			syncEngine: engine,
			subscribeSyncStatus: null,
			events: null,
		})
		const first = controller.getSnapshot()
		expect(controller.getSnapshot()).toBe(first)
		engine.getStatus.mockReturnValue(createStatus({ status: 'syncing' }))
		const next = controller.getSnapshot()
		expect(next).not.toBe(first)
		expect(next.status).toBe('syncing')
		expect(next.initialSync).toBe(first.initialSync)
		controller.destroy()
	})

	test('carries unchanged nested values over by reference and defaults Phase 2/3 fields', () => {
		const held = { nodeId: 'n', operationCount: 1, reason: 'other-user' as const, principal: 'u' }
		const a = stabilizeSyncStatus(createStatus({ heldNodes: [{ ...held }] }), OFFLINE_SYNC_STATUS)
		const b = stabilizeSyncStatus(createStatus({ heldNodes: [{ ...held }] }), a)
		expect(b).toBe(a)
		const c = stabilizeSyncStatus(
			createStatus({ heldNodes: [{ ...held }], pendingOperations: 3 }),
			b,
		)
		expect(c).not.toBe(b)
		expect(c.heldNodes).toBe(a.heldNodes)

		const legacy = stabilizeSyncStatus(
			{
				status: 'synced',
				reconnecting: false,
				pendingOperations: 0,
				lastSyncedAt: null,
				lastSuccessfulPush: null,
				lastSuccessfulPull: null,
				conflicts: 0,
				clockSkewMs: null,
			},
			null,
		)
		expect(legacy).toMatchObject({
			heldOperations: 0,
			heldNodes: [],
			localDurability: 'durable',
			serverProtocolVersion: null,
			protocolDeprecated: false,
		})
	})
})
