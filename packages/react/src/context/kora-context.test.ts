import type { Store } from '@kora/store'
import type { SyncEngine } from '@kora/sync'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KoraAppLike } from '../types'
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

function createMockApp(options?: {
	syncEngine?: SyncEngine | null
	readyDelay?: number
}): { app: KoraAppLike; store: Store; resolve: () => void } {
	const store = createMockStore()
	const syncEngine = options?.syncEngine ?? null
	let resolveReady: () => void
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve
	})

	const app: KoraAppLike = {
		ready,
		getStore: () => store,
		getSyncEngine: () => syncEngine,
	}

	return { app, store, resolve: resolveReady! }
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
	describe('store prop (backward compat)', () => {
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

	describe('app prop', () => {
		it('renders children after app.ready resolves', async () => {
			const { app, resolve } = createMockApp()

			render(
				createElement(
					KoraProvider,
					{ app },
					createElement('div', { 'data-testid': 'child' }, 'Ready!'),
				),
			)

			// Before ready, children should not be rendered
			expect(screen.queryByTestId('child')).toBeNull()

			// Resolve ready
			await act(async () => {
				resolve()
			})

			// Now children should be rendered
			await waitFor(() => {
				expect(screen.getByTestId('child').textContent).toBe('Ready!')
			})
		})

		it('provides store and syncEngine from app after ready', async () => {
			const syncEngine = createMockSyncEngine()
			const { app, resolve } = createMockApp({ syncEngine })

			render(createElement(KoraProvider, { app }, createElement(ContextReader)))

			await act(async () => {
				resolve()
			})

			await waitFor(() => {
				expect(screen.getByTestId('has-store').textContent).toBe('yes')
				expect(screen.getByTestId('has-sync').textContent).toBe('yes')
			})
		})

		it('provides null syncEngine when app has no sync configured', async () => {
			const { app, resolve } = createMockApp({ syncEngine: null })

			render(createElement(KoraProvider, { app }, createElement(ContextReader)))

			await act(async () => {
				resolve()
			})

			await waitFor(() => {
				expect(screen.getByTestId('has-store').textContent).toBe('yes')
				expect(screen.getByTestId('has-sync').textContent).toBe('no')
			})
		})

		it('renders fallback while app.ready is pending', async () => {
			const { app, resolve } = createMockApp()
			const fallback = createElement('div', { 'data-testid': 'loading' }, 'Loading...')

			render(
				createElement(
					KoraProvider,
					{ app, fallback },
					createElement('div', { 'data-testid': 'child' }, 'Ready!'),
				),
			)

			// Fallback should be shown
			expect(screen.getByTestId('loading').textContent).toBe('Loading...')
			expect(screen.queryByTestId('child')).toBeNull()

			// Resolve ready
			await act(async () => {
				resolve()
			})

			// Children should replace fallback
			await waitFor(() => {
				expect(screen.getByTestId('child').textContent).toBe('Ready!')
				expect(screen.queryByTestId('loading')).toBeNull()
			})
		})

		it('renders nothing (null) before ready when no fallback provided', () => {
			const { app } = createMockApp()

			const { container } = render(
				createElement(
					KoraProvider,
					{ app },
					createElement('div', { 'data-testid': 'child' }, 'Ready!'),
				),
			)

			expect(screen.queryByTestId('child')).toBeNull()
			expect(container.innerHTML).toBe('')
		})
	})

	describe('error handling', () => {
		it('throws when neither app nor store is provided', () => {
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

			expect(() => {
				render(
					createElement(
						KoraProvider,
						{} as Record<string, unknown>,
						createElement('div', null, 'child'),
					),
				)
			}).toThrow('KoraProvider requires either an "app" or "store" prop')

			spy.mockRestore()
		})
	})
})
