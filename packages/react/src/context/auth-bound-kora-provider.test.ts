import type { AuthSyncBinding, AuthSyncState } from '@korajs/core/bindings'
import type { Store } from '@korajs/store'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { KoraAppLike } from '../types'
import { AuthBoundKoraProvider, classifyKoraInitializationError } from './auth-bound-kora-provider'

afterEach(cleanup)

function authController(initial: AuthSyncState): {
	binding: AuthSyncBinding
	set(next: AuthSyncState): void
} {
	let state = initial
	const listeners = new Set<() => void>()
	return {
		binding: {
			auth: async () => ({ token: state.state === 'authenticated' ? (state.token ?? '') : '' }),
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
	test.each([
		'OPFS_UNAVAILABLE',
		'INDEXEDDB_OPEN_FAILED',
		'DATABASE_OPEN_FAILED',
		'SCHEMA_MISMATCH',
		'WORKER_INIT_ERROR',
	])('preserves structured initialization code %s', (code) => {
		const failure = Object.assign(new Error('Could not open workspace'), { code })
		expect(classifyKoraInitializationError(failure).code).toBe(code)
	})

	test('classifies the browser quota exception without parsing its message', () => {
		const failure = new DOMException('Localized browser message', 'QuotaExceededError')
		expect(classifyKoraInitializationError(failure).code).toBe('STORAGE_QUOTA_EXCEEDED')
	})

	test('renders a classified token-free error and serializes retry after cleanup', async () => {
		const auth = authController({ state: 'authenticated', userId: 'a', token: 'top-secret' })
		const closeFailed = vi.fn(async () => {})
		const failure = Object.assign(new Error('Database could not open'), {
			code: 'WORKER_INIT_ERROR',
			context: { adapter: 'sqlite-wasm', token: 'must-not-leak' },
		})
		const goodApp = mockApp('a', [])
		const createApp = vi
			.fn()
			.mockReturnValueOnce({
				...mockApp('a', []),
				ready: Promise.reject(failure),
				close: closeFailed,
			})
			.mockReturnValueOnce(goodApp)
		const seen: unknown[] = []

		render(
			createElement(
				AuthBoundKoraProvider,
				{
					authClient: auth.binding,
					createApp,
					error: (context) => {
						seen.push(context)
						return createElement(
							'button',
							{ type: 'button', onClick: context.retry },
							context.error.code,
						)
					},
				},
				createElement('span', null, 'private app'),
			),
		)

		await screen.findByRole('button', { name: 'WORKER_INIT_ERROR' })
		expect(closeFailed).toHaveBeenCalledTimes(1)
		expect(seen[0]).toMatchObject({
			error: { code: 'WORKER_INIT_ERROR', metadata: { adapter: 'sqlite-wasm' } },
			session: { userId: 'a' },
		})
		expect(JSON.stringify(seen[0])).not.toContain('top-secret')
		expect(JSON.stringify(seen[0])).not.toContain('must-not-leak')

		fireEvent.click(screen.getByRole('button', { name: 'WORKER_INIT_ERROR' }))
		await screen.findByText('private app')
		expect(createApp).toHaveBeenCalledTimes(2)
		expect(closeFailed).toHaveBeenCalledTimes(1)
	})

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

	test('mounts the user database while authenticated-offline and keeps it across freshness changes', async () => {
		const lifecycle: string[] = []
		const auth = authController({
			state: 'authenticated',
			userId: 'u1',
			token: null,
			offline: true,
			locked: false,
		})
		const createApp = vi.fn((session: { userId: string }) => {
			lifecycle.push(`create:${session.userId}`)
			return mockApp(session.userId, lifecycle)
		})
		render(
			createElement(
				AuthBoundKoraProvider,
				{
					authClient: auth.binding,
					createApp,
					signedOut: createElement('p', null, 'signed out'),
					locked: createElement('p', null, 'locked'),
				},
				createElement('p', null, 'workspace'),
			),
		)
		await screen.findByText('workspace')

		// Locked: the lock screen replaces the UI, the app is NOT closed.
		auth.set({ state: 'authenticated', userId: 'u1', token: null, offline: true, locked: true })
		await screen.findByText('locked')
		// Back online with a fresh token: same app, no re-creation.
		auth.set({ state: 'authenticated', userId: 'u1', token: 'fresh' })
		await screen.findByText('workspace')
		expect(lifecycle).toEqual(['create:u1'])
	})
})

describe('AuthBoundKoraProvider never leaves a rejection unhandled', () => {
	const unhandled: unknown[] = []
	const record = (reason: unknown) => unhandled.push(reason)
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

	test('a resolveSyncState that rejects after a failed open is logged, not unhandled', async () => {
		unhandled.length = 0
		process.on('unhandledRejection', record)
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			let calls = 0
			const binding: AuthSyncBinding = {
				auth: async () => ({ token: 't' }),
				resolveSyncState: async () => {
					calls += 1
					if (calls === 1) return { state: 'authenticated', userId: 'a', token: 't' }
					throw new Error('identity service down')
				},
				subscribe: () => () => {},
			}
			const createApp = vi.fn(() => ({
				...mockApp('a', []),
				ready: Promise.reject(new Error('open failed')),
			}))
			render(
				createElement(
					AuthBoundKoraProvider,
					{ authClient: binding, createApp },
					createElement('span', null, 'app'),
				),
			)
			await waitFor(() => expect(calls).toBe(2))
			await settle()
			expect(unhandled).toEqual([])
			expect(logged).toHaveBeenCalled()
		} finally {
			process.off('unhandledRejection', record)
			logged.mockRestore()
		}
	})

	test("the previous app's close() rejecting on unmount is logged, not unhandled", async () => {
		unhandled.length = 0
		process.on('unhandledRejection', record)
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			const auth = authController({ state: 'authenticated', userId: 'a', token: 't' })
			const app = {
				...mockApp('a', []),
				close: async () => {
					throw new Error('close failed')
				},
			}
			const { unmount } = render(
				createElement(
					AuthBoundKoraProvider,
					{ authClient: auth.binding, createApp: () => app },
					createElement('span', null, 'private app'),
				),
			)
			await screen.findByText('private app')
			unmount()
			await settle()
			expect(unhandled).toEqual([])
			expect(logged).toHaveBeenCalled()
		} finally {
			process.off('unhandledRejection', record)
			logged.mockRestore()
		}
	})

	test('an initialization error dropped because the user signed out meanwhile is logged', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			let calls = 0
			const binding: AuthSyncBinding = {
				auth: async () => ({ token: 't' }),
				resolveSyncState: async () => {
					calls += 1
					return calls === 1
						? { state: 'authenticated', userId: 'a', token: 't' }
						: { state: 'signed-out', mayConnectAnonymously: false }
				},
				subscribe: () => () => {},
			}
			const createApp = vi.fn(() => ({
				...mockApp('a', []),
				ready: Promise.reject(new Error('open failed while signing out')),
			}))
			render(
				createElement(
					AuthBoundKoraProvider,
					{ authClient: binding, createApp },
					createElement('span', null, 'app'),
				),
			)
			await waitFor(() => expect(calls).toBe(2))
			await settle()
			expect(logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain(
				'open failed while signing out',
			)
		} finally {
			logged.mockRestore()
		}
	})
})
