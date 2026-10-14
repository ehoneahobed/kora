import { describe, expect, test, vi } from 'vitest'
import type { AuthClient, AuthState } from '../client/auth-client'
import { createAuthSession } from './create-auth-session'

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
		sendVerificationEmail: vi.fn(async () => ({ sent: true, alreadyVerified: false })),
		verifyEmail: vi.fn(async (token: string) => {
			if (token === 'expired') throw new Error('This verification link has expired.')
			return { email: 'a@b.com' }
		}),
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

	test('passes email verification through, and rejects with the reason', async () => {
		const client = createMockClient()
		const session = createAuthSession(client)
		await vi.waitFor(() => expect(session.getSnapshot().isLoading).toBe(false))
		expect(await session.sendVerificationEmail()).toEqual({ sent: true, alreadyVerified: false })
		expect(await session.verifyEmail('ok')).toEqual({ email: 'a@b.com' })
		await expect(session.verifyEmail('expired')).rejects.toThrow('expired')
		expect(session.getSnapshot().error).toMatch(/expired/)
		session.destroy()
	})

	test('a successful retry clears the error for subscribers', async () => {
		const client = createMockClient()
		let fail = true
		;(
			client as unknown as { sendVerificationEmail: () => Promise<unknown> }
		).sendVerificationEmail = vi.fn(async () => {
			if (fail) throw new Error('smtp down')
			return { sent: true, alreadyVerified: false }
		})
		const session = createAuthSession(client)
		await vi.waitFor(() => expect(session.getSnapshot().isLoading).toBe(false))
		const errors: Array<string | null> = []
		session.subscribe(() => errors.push(session.getSnapshot().error))
		await expect(session.sendVerificationEmail()).rejects.toThrow('smtp down')
		fail = false
		await session.sendVerificationEmail()
		expect(errors.at(-1)).toBeNull()
		expect(session.getSnapshot().error).toBeNull()
		session.destroy()
	})
})
