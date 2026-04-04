import type { Store } from '@kora/store'
import type { SyncEngine } from '@kora/sync'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider, useKoraContext } from './kora-context'

afterEach(() => {
	cleanup()
})

function createMockStore(): Store {
	return {
		collection: vi.fn(),
		getSchema: vi.fn(),
		getVersionVector: vi.fn(),
		getNodeId: vi.fn(),
	} as unknown as Store
}

function createMockSyncEngine(): SyncEngine {
	return {
		getStatus: vi.fn().mockReturnValue({
			status: 'offline',
			pendingOperations: 0,
			lastSyncedAt: null,
		}),
		start: vi.fn(),
		stop: vi.fn(),
	} as unknown as SyncEngine
}

/** Test component that reads from context and renders status */
function ContextReader(): ReturnType<typeof createElement> {
	const ctx = useKoraContext()
	return createElement(
		'div',
		null,
		createElement('span', { 'data-testid': 'has-store' }, ctx.store ? 'yes' : 'no'),
		createElement('span', { 'data-testid': 'has-sync' }, ctx.syncEngine ? 'yes' : 'no'),
	)
}

describe('KoraContext', () => {
	it('renders children within the provider', () => {
		const store = createMockStore()
		render(
			createElement(
				KoraProvider,
				{ store },
				createElement('div', { 'data-testid': 'child' }, 'Hello'),
			),
		)
		expect(screen.getByTestId('child').textContent).toBe('Hello')
	})

	it('provides store via context', () => {
		const store = createMockStore()
		render(createElement(KoraProvider, { store }, createElement(ContextReader)))
		expect(screen.getByTestId('has-store').textContent).toBe('yes')
	})

	it('provides syncEngine as null when not specified', () => {
		const store = createMockStore()
		render(createElement(KoraProvider, { store }, createElement(ContextReader)))
		expect(screen.getByTestId('has-sync').textContent).toBe('no')
	})

	it('provides syncEngine when specified', () => {
		const store = createMockStore()
		const syncEngine = createMockSyncEngine()
		render(createElement(KoraProvider, { store, syncEngine }, createElement(ContextReader)))
		expect(screen.getByTestId('has-sync').textContent).toBe('yes')
	})

	it('throws when useKoraContext is used outside provider', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => {
			render(createElement(ContextReader))
		}).toThrow('useKoraContext must be used within a <KoraProvider>')

		spy.mockRestore()
	})
})
