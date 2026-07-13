import { describe, expect, test, vi } from 'vitest'
import { createAuthSession } from './create-auth-session'
import type { AuthClient, AuthState } from '../client/auth-client'

function createMockClient(initialState: AuthState = 'unauthenticated'): AuthClient {
	let state = initialState
	const listeners = new Set<(state: AuthState) => void>()

	return {
		state,
		currentUser: null,
		initialize: vi.fn(async () => {
			state = 'unauthenticated'
			for (const listener of listeners) listener(state)
		}),
		onAuthChange: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		signIn: vi.fn(async () => {
			state = 'authenticated'
			for (const listener of listeners) listener(state)
		}),
		signUp: vi.fn(async () => {}),
		signOut: vi.fn(async () => {
			state = 'unauthenticated'
			for (const listener of listeners) listener(state)
		}),
		signInWithOAuth: vi.fn(async () => ({ url: 'https://example.com', state: 'abc' })),
		completeOAuthSignIn: vi.fn(async () => {}),
		getOAuthAuthorizationUrl: vi.fn(async () => ({ url: 'https://example.com', state: 'abc' })),
		linkOAuth: vi.fn(async () => null),
		listLinkedAccounts: vi.fn(async () => []),
		unlinkOAuth: vi.fn(async () => {}),
	} as unknown as AuthClient
}

describe('createAuthSession', () => {
	test('initializes and exposes loading then ready snapshot', async () => {
		const client = createMockClient()
		const session = createAuthSession(client)

		expect(session.getSnapshot().isLoading).toBe(true)

		await vi.waitFor(() => {
			expect(session.getSnapshot().isLoading).toBe(false)
		})

		session.destroy()
	})

	test('notifies subscribers when auth state changes', async () => {
		const client = createMockClient()
		const session = createAuthSession(client)
		const states: boolean[] = []

		session.subscribe(() => {
			states.push(session.getSnapshot().isAuthenticated)
		})

		await vi.waitFor(() => expect(session.getSnapshot().isLoading).toBe(false))
		await session.signIn({ email: 'a@b.com', password: 'secret' })

		expect(states.at(-1)).toBe(true)
		session.destroy()
	})
})
