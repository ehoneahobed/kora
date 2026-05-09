import type { Store } from '@korajs/store'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useApp } from './use-app'

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

function createMockApp(): { app: KoraAppLike; store: Store; resolve: () => void } {
	const store = createMockStore()
	let resolveReady: (() => void) | undefined
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve
	})

	const app: KoraAppLike = {
		ready,
		getStore: () => store,
		getSyncEngine: () => null,
	}

	return { app, store, resolve: resolveReady as () => void }
}

describe('useApp', () => {
	it('returns the app instance from context', async () => {
		const { app, resolve } = createMockApp()
		let capturedApp: KoraAppLike | null = null

		function Consumer(): ReturnType<typeof createElement> {
			capturedApp = useApp()
			return createElement('div', { 'data-testid': 'consumer' }, 'ok')
		}

		render(createElement(KoraProvider, { app }, createElement(Consumer)))

		// Resolve app.ready so KoraProvider renders children
		await act(async () => {
			resolve()
		})

		expect(screen.getByTestId('consumer')).toBeDefined()
		expect(capturedApp).toBe(app)
	})

	it('throws when used outside KoraProvider', () => {
		function Consumer(): ReturnType<typeof createElement> {
			useApp()
			return null
		}

		// Suppress React error boundary console output
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(() => render(createElement(Consumer))).toThrow('useKoraContext')
		} finally {
			consoleSpy.mockRestore()
		}
	})

	it('throws when KoraProvider has no app prop (store-only mode)', () => {
		const store = createMockStore()
		let thrownError: Error | null = null

		function Consumer(): ReturnType<typeof createElement> {
			try {
				useApp()
			} catch (e) {
				thrownError = e as Error
			}
			return createElement('div', null, 'rendered')
		}

		render(createElement(KoraProvider, { store }, createElement(Consumer)))

		expect(thrownError).not.toBeNull()
		expect(thrownError?.message).toContain('useApp()')
		expect(thrownError?.message).toContain('app')
	})

	it('preserves the app identity across re-renders', async () => {
		const { app, resolve } = createMockApp()
		const capturedApps: KoraAppLike[] = []

		function Consumer(): ReturnType<typeof createElement> {
			const a = useApp()
			capturedApps.push(a)
			return createElement('div', null, 'ok')
		}

		const { rerender } = render(createElement(KoraProvider, { app }, createElement(Consumer)))

		await act(async () => {
			resolve()
		})

		// Force a re-render
		rerender(createElement(KoraProvider, { app }, createElement(Consumer)))

		// All captured apps should be the same instance
		expect(capturedApps.length).toBeGreaterThanOrEqual(2)
		for (const a of capturedApps) {
			expect(a).toBe(app)
		}
	})

	it('accepts a generic type parameter for typed apps', async () => {
		const { app, resolve } = createMockApp()

		// Simulate a typed app with extra properties
		interface TypedApp extends KoraAppLike {
			todos: { insert: (data: { title: string }) => Promise<unknown> }
		}

		const typedApp = app as unknown as TypedApp
		;(typedApp as Record<string, unknown>).todos = {
			insert: vi.fn().mockResolvedValue({ id: '1', title: 'test' }),
		}

		let capturedApp: TypedApp | null = null

		function Consumer(): ReturnType<typeof createElement> {
			capturedApp = useApp<TypedApp>()
			return createElement('div', null, 'ok')
		}

		render(createElement(KoraProvider, { app: typedApp }, createElement(Consumer)))

		await act(async () => {
			resolve()
		})

		expect(capturedApp).not.toBeNull()
		expect(capturedApp?.todos).toBeDefined()
		expect(typeof capturedApp?.todos.insert).toBe('function')
	})
})
