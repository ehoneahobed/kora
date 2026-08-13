import type { AuthSyncBinding, AuthSyncState } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { KoraAppLike } from '../types'
import { AuthBoundKoraProvider } from './auth-bound-kora-provider'

afterEach(cleanup)

function authController(initial: AuthSyncState): {
	binding: AuthSyncBinding
	set(next: AuthSyncState): void
} {
	let state = initial
	const listeners = new Set<() => void>()
	return {
		binding: {
			auth: async () => ({ token: state.state === 'authenticated' ? state.token : '' }),
			resolveSyncState: async () => state,
			subscribe(listener) {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		},
		set(next) {
			state = next
			for (const listener of listeners) listener()
		},
	}
}

function mockApp(userId: string, lifecycle: string[]): KoraAppLike & { close(): Promise<void> } {
	const store = { collection: vi.fn() } as unknown as Store
	return {
		ready: Promise.resolve(),
		getStore: () => store,
		getSyncEngine: () => null,
		async close() {
			lifecycle.push(`close:${userId}`)
		},
	}
}

describe('AuthBoundKoraProvider', () => {
	test('closes user A before creating user B and hides the stale provider tree', async () => {
		const auth = authController({ state: 'authenticated', userId: 'a', token: 'token-a' })
		const lifecycle: string[] = []
		const createApp = vi.fn((session: Extract<AuthSyncState, { state: 'authenticated' }>) => {
			lifecycle.push(`create:${session.userId}`)
			return mockApp(session.userId, lifecycle)
		})

		render(
			createElement(
				AuthBoundKoraProvider,
				{
					authClient: auth.binding,
					createApp,
					signedOut: createElement('span', null, 'signed out'),
				},
				createElement('span', null, 'private app'),
			),
		)
		await screen.findByText('private app')

		auth.set({ state: 'authenticated', userId: 'b', token: 'token-b' })
		await waitFor(() => expect(createApp).toHaveBeenCalledTimes(2))
		expect(lifecycle).toEqual(['create:a', 'close:a', 'create:b'])
	})

	test('does not replace the app for a same-user token refresh', async () => {
		const auth = authController({ state: 'authenticated', userId: 'a', token: 'token-1' })
		const createApp = vi.fn(() => mockApp('a', []))
		render(
			createElement(
				StrictMode,
				null,
				createElement(
					AuthBoundKoraProvider,
					{ authClient: auth.binding, createApp },
					createElement('span', null, 'private app'),
				),
			),
		)
		await screen.findByText('private app')
		const callsAfterStrictMode = createApp.mock.calls.length
		auth.set({ state: 'authenticated', userId: 'a', token: 'token-2' })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(createApp).toHaveBeenCalledTimes(callsAfterStrictMode)
	})

	test('closes the authenticated app and renders signed-out content on sign-out', async () => {
		const auth = authController({ state: 'authenticated', userId: 'a', token: 'token-a' })
		const close = vi.fn(async () => {})
		const app = { ...mockApp('a', []), close }
		render(
			createElement(
				AuthBoundKoraProvider,
				{
					authClient: auth.binding,
					createApp: () => app,
					signedOut: createElement('span', null, 'signed out'),
				},
				createElement('span', null, 'private app'),
			),
		)
		await screen.findByText('private app')
		auth.set({ state: 'signed-out', mayConnectAnonymously: false })
		await screen.findByText('signed out')
		expect(screen.queryByText('private app')).toBeNull()
		expect(close).toHaveBeenCalledTimes(1)
	})
})
