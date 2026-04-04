import type { Store } from '@kora/store'
import type { SyncEngine, SyncStatusInfo } from '@kora/sync'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
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

	it('re-renders when status changes', async () => {
		vi.useFakeTimers()
		const store = createMockStore()
		const { syncEngine, setStatus } = createMockSyncEngine({ status: 'offline' })

		render(createElement(KoraProvider, { store, syncEngine }, createElement(SyncStatusDisplay)))

		expect(screen.getByTestId('status').textContent).toBe('offline')

		// Change status
		setStatus({ status: 'syncing', pendingOperations: 5, lastSyncedAt: null })

		// Advance timer to trigger poll
		await act(async () => {
			vi.advanceTimersByTime(600)
		})

		expect(screen.getByTestId('status').textContent).toBe('syncing')
		expect(screen.getByTestId('pending').textContent).toBe('5')

		vi.useRealTimers()
	})

	it('returns stable reference when status unchanged', async () => {
		vi.useFakeTimers()
		const store = createMockStore()
		const { syncEngine } = createMockSyncEngine({ status: 'synced' })

		let renderCount = 0
		function RenderCounter(): ReturnType<typeof createElement> {
			const status = useSyncStatus()
			renderCount++
			return createElement('span', { 'data-testid': 'status' }, status.status)
		}

		render(createElement(KoraProvider, { store, syncEngine }, createElement(RenderCounter)))

		const initialRenderCount = renderCount

		// Advance timer — status hasn't changed, should not re-render
		await act(async () => {
			vi.advanceTimersByTime(600)
		})

		expect(renderCount).toBe(initialRenderCount)

		vi.useRealTimers()
	})

	it('cleans up polling interval on unmount', async () => {
		vi.useFakeTimers()
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
		const store = createMockStore()
		const { syncEngine } = createMockSyncEngine()

		const { unmount } = render(
			createElement(KoraProvider, { store, syncEngine }, createElement(SyncStatusDisplay)),
		)

		unmount()

		expect(clearIntervalSpy).toHaveBeenCalled()

		vi.useRealTimers()
	})
})
