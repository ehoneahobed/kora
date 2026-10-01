import { describe, expect, test, vi } from 'vitest'
import type { AuthContext, AuthProvider } from '../types'
import { MixedAuthProvider } from './mixed-auth-provider'

function createMockPrimary(result: AuthContext | null): AuthProvider {
	return {
		authenticate: vi.fn().mockResolvedValue(result),
	}
}

describe('MixedAuthProvider', () => {
	test('delegates to primary when token is valid', async () => {
		const ctx: AuthContext = { userId: 'user-1', scopes: { forms: {} } }
		const primary = createMockPrimary(ctx)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: { responses: {} },
		})

		const result = await auth.authenticate('valid-token')
		expect(result).toEqual(ctx)
		expect(primary.authenticate).toHaveBeenCalledWith('valid-token')
	})

	test('falls back to anonymous when token is empty', async () => {
		const primary = createMockPrimary({ userId: 'user-1' })
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: { responses: {} },
		})

		const result = await auth.authenticate('')
		expect(result?.userId).toMatch(/^anon-/)
		expect(result?.scopes).toEqual({ responses: {} })
		// Primary should NOT be called for empty tokens
		expect(primary.authenticate).not.toHaveBeenCalled()
	})

	// Inverted (beta.13): a presented but invalid/expired token used to be silently
	// downgraded to anonymous, so a signed-in user whose access token had expired
	// synced their private writes against the anonymous grant. It is now rejected
	// and the client refreshes before reconnecting.
	test('rejects (does not downgrade) a token the primary rejects', async () => {
		const primary = createMockPrimary(null)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: { responses: {} },
		})

		const result = await auth.authenticate('invalid-token')
		expect(result).toBeNull()
		expect(primary.authenticate).toHaveBeenCalledWith('invalid-token')
	})

	test('anonymous grants are fresh copies per session', async () => {
		const anonymousScopes = { forms: { status: 'published' } }
		const auth = new MixedAuthProvider({ primary: createMockPrimary(null), anonymousScopes })
		const a = await auth.authenticate('')
		if (a?.scopes?.forms) a.scopes.forms.status = 'draft'
		const b = await auth.authenticate('')
		expect(b?.scopes).toEqual({ forms: { status: 'published' } })
		expect(anonymousScopes.forms.status).toBe('published')
	})

	test('each anonymous connection gets a unique userId', async () => {
		const primary = createMockPrimary(null)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: { responses: {} },
		})

		const result1 = await auth.authenticate('')
		const result2 = await auth.authenticate('')
		expect(result1?.userId).not.toEqual(result2?.userId)
	})

	test('uses custom anonymous prefix', async () => {
		const primary = createMockPrimary(null)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: { responses: {} },
			anonymousPrefix: 'guest',
		})

		const result = await auth.authenticate('')
		expect(result?.userId).toMatch(/^guest-/)
	})

	test('anonymous scopes restrict to specified collections', async () => {
		const primary = createMockPrimary(null)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: {
				responses: {},
				forms: { status: 'published' },
			},
		})

		const result = await auth.authenticate('')
		expect(result?.scopes).toEqual({
			responses: {},
			forms: { status: 'published' },
		})
	})

	test('authenticated users get their own scopes, not anonymous ones', async () => {
		const ctx: AuthContext = {
			userId: 'user-1',
			scopes: { forms: { userId: 'user-1' }, responses: { formOwnerId: 'user-1' } },
		}
		const primary = createMockPrimary(ctx)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: { responses: {} },
		})

		const result = await auth.authenticate('valid-token')
		expect(result?.scopes).toEqual({
			forms: { userId: 'user-1' },
			responses: { formOwnerId: 'user-1' },
		})
	})

	test('always allows a token-less (anonymous) connection', async () => {
		const primary = createMockPrimary(null)
		const auth = new MixedAuthProvider({
			primary,
			anonymousScopes: {},
		})

		const result = await auth.authenticate('')
		expect(result).not.toBeNull()
		expect(result?.userId).toBeTruthy()
	})
})
