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

describe('retryImport (a dropped request for the sign-in client chunk)', () => {
	it('tries again after a failure and returns the module', async () => {
		vi.useFakeTimers()
		const load = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValueOnce('chunk')
		const loaded = retryImport(load)
		await vi.advanceTimersByTimeAsync(500)
		await expect(loaded).resolves.toBe('chunk')
		expect(load).toHaveBeenCalledTimes(2)
		vi.useRealTimers()
	})

	it('gives up after the last try with the last error', async () => {
		vi.useFakeTimers()
		const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('still missing'))
		const loaded = retryImport(load, 3)
		const outcome = expect(loaded).rejects.toThrow('still missing')
		await vi.advanceTimersByTimeAsync(2000)
		await outcome
		expect(load).toHaveBeenCalledTimes(3)
		vi.useRealTimers()
	})
})
