import type { KoraEventEmitter } from '@korajs/core'
import type { Store } from '@korajs/store'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useSyncStatus } from './use-sync-status'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function createMockStore(): Store {
	return {
		collection: vi.fn(),
		getSchema: vi.fn(),
		getVersionVector: vi.fn(),
		getNodeId: vi.fn(),
	} as unknown as Store
}

function createMockSyncEngine(initialStatus?: Partial<SyncStatusInfo>): {
	syncEngine: SyncEngine
	setStatus: (status: SyncStatusInfo) => void
} {
	let currentStatus: SyncStatusInfo = {
		status: 'offline',
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		clockSkewMs: null,
		...initialStatus,
	}

	const syncEngine = {
		getStatus: vi.fn(() => currentStatus),
		start: vi.fn(),
		stop: vi.fn(),
	} as unknown as SyncEngine

	const setStatus = (status: SyncStatusInfo): void => {
		currentStatus = status
	}

	return { syncEngine, setStatus }
}

function createMockEmitter(): KoraEventEmitter & { emitSyncEvent(): void } {
	const handlers = new Map<string, Set<(event: unknown) => void>>()
	return {
		on(type: string, handler: (event: unknown) => void) {
			if (!handlers.has(type)) {
				handlers.set(type, new Set())
			}
			handlers.get(type)?.add(handler)
			return () => {
				handlers.get(type)?.delete(handler)
			}
		},
		emitSyncEvent() {
			for (const handler of handlers.get('sync:sent') ?? []) {
				handler({ type: 'sync:sent', operations: [], batchSize: 0 })
			}
		},
	} as KoraEventEmitter & { emitSyncEvent(): void }
}

function SyncStatusDisplay(): ReturnType<typeof createElement> {
	const status = useSyncStatus()
	return createElement(
		'div',
		null,
		createElement('span', { 'data-testid': 'status' }, status.status),
		createElement('span', { 'data-testid': 'pending' }, String(status.pendingOperations)),
		createElement('span', { 'data-testid': 'synced-at' }, String(status.lastSyncedAt)),
	)
}

describe('useSyncStatus', () => {
	it('returns offline status when no syncEngine is provided', () => {
		const store = createMockStore()
		render(createElement(KoraProvider, { store }, createElement(SyncStatusDisplay)))
		expect(screen.getByTestId('status').textContent).toBe('offline')
		expect(screen.getByTestId('pending').textContent).toBe('0')
		expect(screen.getByTestId('synced-at').textContent).toBe('null')
	})

	it('returns engine status when syncEngine is provided', () => {
		const store = createMockStore()
		const { syncEngine } = createMockSyncEngine({
			status: 'synced',
			pendingOperations: 3,
			lastSyncedAt: 12345,
		})

		render(createElement(KoraProvider, { store, syncEngine }, createElement(SyncStatusDisplay)))

		expect(screen.getByTestId('status').textContent).toBe('synced')
		expect(screen.getByTestId('pending').textContent).toBe('3')
		expect(screen.getByTestId('synced-at').textContent).toBe('12345')
	})

	it('re-renders when status changes via sync events', async () => {
		const store = createMockStore()
		const { syncEngine, setStatus } = createMockSyncEngine({ status: 'offline' })
		const events = createMockEmitter()

		const app: KoraAppLike = {
			ready: Promise.resolve(),
			getStore: () => store,
			getSyncEngine: () => syncEngine,
			events,
		}

		render(createElement(KoraProvider, { app }, createElement(SyncStatusDisplay)))

		await waitFor(() => {
			expect(screen.getByTestId('status').textContent).toBe('offline')
		})

		setStatus({
			status: 'syncing',
			pendingOperations: 5,
			lastSyncedAt: null,
			lastSuccessfulPush: null,
			lastSuccessfulPull: null,
			conflicts: 0,
			clockSkewMs: null,
		})

		await act(async () => {
			events.emitSyncEvent()
		})

		expect(screen.getByTestId('status').textContent).toBe('syncing')
		expect(screen.getByTestId('pending').textContent).toBe('5')
	})

	it('re-renders when app.sync.subscribeStatus pushes updates', async () => {
		const store = createMockStore()
		const listeners = new Set<(status: SyncStatusInfo) => void>()

		const app: KoraAppLike = {
			ready: Promise.resolve(),
			getStore: () => store,
			getSyncEngine: () => null,
			sync: {
				subscribeStatus(listener) {
					listeners.add(listener)
					listener({
						status: 'offline',
						pendingOperations: 0,
						lastSyncedAt: null,
						lastSuccessfulPush: null,
						lastSuccessfulPull: null,
						conflicts: 0,
						clockSkewMs: null,
					})
					return () => {
						listeners.delete(listener)
					}
				},
			},
		}

		render(createElement(KoraProvider, { app }, createElement(SyncStatusDisplay)))

		await waitFor(() => {
			expect(screen.getByTestId('status').textContent).toBe('offline')
		})

		await act(async () => {
			for (const listener of listeners) {
				listener({
					status: 'synced',
					pendingOperations: 1,
					lastSyncedAt: 99,
					lastSuccessfulPush: null,
					lastSuccessfulPull: null,
					conflicts: 0,
					clockSkewMs: null,
				})
			}
		})

		await waitFor(() => {
			expect(screen.getByTestId('status').textContent).toBe('synced')
		})
		expect(screen.getByTestId('pending').textContent).toBe('1')
	})

	it('returns stable reference when status unchanged', () => {
		const store = createMockStore()
		const { syncEngine } = createMockSyncEngine({ status: 'synced' })
		const events = createMockEmitter()

		let renderCount = 0
		function RenderCounter(): ReturnType<typeof createElement> {
			useSyncStatus()
			renderCount++
			return createElement('span', { 'data-testid': 'count' }, String(renderCount))
		}

		const app: KoraAppLike = {
			ready: Promise.resolve(),
			getStore: () => store,
			getSyncEngine: () => syncEngine,
			events,
		}

		render(createElement(KoraProvider, { app }, createElement(RenderCounter)))

		const initialRenderCount = renderCount

		act(() => {
			events.emitSyncEvent()
		})

		expect(renderCount).toBe(initialRenderCount)
	})

	it('unsubscribes from subscribeStatus on unmount', async () => {
		const store = createMockStore()
		const unsubscribe = vi.fn()

		const app: KoraAppLike = {
			ready: Promise.resolve(),
			getStore: () => store,
			getSyncEngine: () => null,
			sync: {
				subscribeStatus: () => unsubscribe,
			},
		}

		const { unmount } = render(
			createElement(KoraProvider, { app }, createElement(SyncStatusDisplay)),
		)

		await screen.findByTestId('status')

		unmount()
		expect(unsubscribe).toHaveBeenCalled()
	})
})
