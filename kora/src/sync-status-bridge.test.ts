import { SimpleEventEmitter } from '@korajs/core/internal'
import type { SyncStatusInfo } from '@korajs/sync'
import { describe, expect, it, vi } from 'vitest'
import { createSyncStatusBridge } from './sync-status-bridge'

function createMockEngine(initial: Partial<SyncStatusInfo> = {}): {
	getStatus: () => SyncStatusInfo
	setStatus: (status: SyncStatusInfo) => void
} {
	let status: SyncStatusInfo = {
		status: 'offline',
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		...initial,
	}
	return {
		getStatus: () => status,
		setStatus: (next) => {
			status = next
		},
	}
}

describe('createSyncStatusBridge', () => {
	it('exposes offline status before engine is available', () => {
		const emitter = new SimpleEventEmitter()
		const bridge = createSyncStatusBridge(emitter, () => null)
		expect(bridge.status.status).toBe('offline')
	})

	it('notifies subscribers when sync events fire', () => {
		const emitter = new SimpleEventEmitter()
		const engine = createMockEngine({ status: 'offline' })
		const bridge = createSyncStatusBridge(emitter, () => engine)

		const listener = vi.fn()
		bridge.subscribe(listener)
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'offline' }))

		engine.setStatus({
			status: 'syncing',
			pendingOperations: 2,
			lastSyncedAt: null,
			lastSuccessfulPush: null,
			lastSuccessfulPull: null,
			conflicts: 0,
		})
		emitter.emit({ type: 'sync:sent', operations: [], batchSize: 1 })

		expect(bridge.status.status).toBe('syncing')
		expect(listener).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: 'syncing', pendingOperations: 2 }),
		)
	})

	it('does not notify when serialized status is unchanged', () => {
		const emitter = new SimpleEventEmitter()
		const engine = createMockEngine({ status: 'synced', pendingOperations: 0, lastSyncedAt: 100 })
		const bridge = createSyncStatusBridge(emitter, () => engine)

		const listener = vi.fn()
		bridge.subscribe(listener)
		listener.mockClear()

		emitter.emit({ type: 'sync:received', operations: [], batchSize: 0 })
		expect(listener).not.toHaveBeenCalled()
	})

	it('destroy stops listening to events', () => {
		const emitter = new SimpleEventEmitter()
		const engine = createMockEngine()
		const bridge = createSyncStatusBridge(emitter, () => engine) as ReturnType<
			typeof createSyncStatusBridge
		> & {
			destroy(): void
		}

		const listener = vi.fn()
		bridge.subscribe(listener)
		listener.mockClear()

		bridge.destroy()
		engine.setStatus({
			status: 'connected',
			pendingOperations: 0,
			lastSyncedAt: null,
			lastSuccessfulPush: null,
			lastSuccessfulPull: null,
			conflicts: 0,
		})
		emitter.emit({ type: 'sync:connected', nodeId: 'n1' })
		expect(listener).not.toHaveBeenCalled()
	})
})
