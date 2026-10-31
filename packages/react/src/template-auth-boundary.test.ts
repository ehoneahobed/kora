import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The scaffolded templates ship this component; it is tested here, where React Testing Library is.
import { AuthBoundary } from '../../cli/templates/react-sync/src/AuthBoundary'
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
