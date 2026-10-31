import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The scaffolded templates ship this component; it is tested here, where React Testing Library is.
import { AuthBoundary, retryImport } from '../../cli/templates/react-sync/src/AuthBoundary'
import { useAuthState } from '../../cli/templates/react-sync/src/auth-state'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function Boom(): never {
	throw new Error('Failed to fetch dynamically imported module: AuthBridge.js')
}

function Probe(): ReturnType<typeof createElement> {
	const state = useAuthState()
	return createElement(
		'p',
		{ 'data-testid': 'probe' },
		`${state.loading ? 'loading' : 'ready'}|${state.error ?? ''}`,
	)
}

describe('the template AuthBoundary (a failed sign-in client chunk)', () => {
	it('keeps the rest of the app mounted, reports once, and tells the screen why', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		render(
			createElement(
				'div',
				null,
				createElement(Probe),
				createElement('span', { 'data-testid': 'list' }, 'task list'),
				createElement(AuthBoundary, null, createElement(Boom)),
			),
		)
		expect(screen.getByTestId('list').textContent).toBe('task list')
		// Still "loading", never mistaken for "signed out", with the reason.
		expect(screen.getByTestId('probe').textContent).toContain('loading|Sign-in is unavailable')
		expect(
			error.mock.calls.some((call) =>
				String(call[0]).includes('[Kora Auth] The sign-in client did not load'),
			),
		).toBe(true)
	})

	it('renders its children when nothing fails', () => {
		render(
			createElement(AuthBoundary, null, createElement('span', { 'data-testid': 'ok' }, 'fine')),
		)
		expect(screen.getByTestId('ok').textContent).toBe('fine')
	})
})

describe('retryImport (a failed request for the sign-in client chunk)', () => {
	const page = () => {
		const store = new Map<string, string>()
		return {
			reload: vi.fn(),
			storage: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
			},
			now: () => 1_000_000,
		}
	}

	it('returns the module without touching the page when the load works', async () => {
		const p = page()
		await expect(retryImport(async () => 'chunk', p)).resolves.toBe('chunk')
		expect(p.reload).not.toHaveBeenCalled()
	})

	it('reloads the page once on a failure and stays pending (a browser cannot import the same URL again)', async () => {
		const p = page()
		const settled = vi.fn()
		retryImport(() => Promise.reject(new Error('network')), p).then(settled, settled)
		await vi.waitFor(() => expect(p.reload).toHaveBeenCalledTimes(1))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(settled).not.toHaveBeenCalled()
	})

	it('after a reload a second failure is thrown, not reloaded again', async () => {
		const p = page()
		p.storage.setItem('kora:chunk-reload:auth', String(p.now() - 1_000))
		await expect(retryImport(() => Promise.reject(new Error('still missing')), p)).rejects.toThrow(
			'still missing',
		)
		expect(p.reload).not.toHaveBeenCalled()
	})

	it('without session storage it throws instead of risking a reload loop', async () => {
		const p = {
			...page(),
			storage: {
				getItem: () => {
					throw new Error('denied')
				},
				setItem: () => {},
			},
		}
		await expect(retryImport(() => Promise.reject(new Error('x')), p)).rejects.toThrow('x')
		expect(p.reload).not.toHaveBeenCalled()
	})
})
