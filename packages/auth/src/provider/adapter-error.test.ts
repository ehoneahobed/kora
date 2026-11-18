import { KoraError } from '@korajs/core'
import { describe, expect, expectTypeOf, test } from 'vitest'
import type { AuthUser } from '../client/auth-client'
import type { AuthEvent } from '../types'
import { AuthProviderError } from './adapter'

describe('auth conventions', () => {
	test('AuthProviderError is a KoraError and keeps its name and status', () => {
		const error = new AuthProviderError('Invalid credentials', 401)
		expect(error).toBeInstanceOf(KoraError)
		expect(error.name).toBe('AuthProviderError')
		expect(error.status).toBe(401)
		expect(error.code).toBe('AUTH_PROVIDER_ERROR')
	})

	test("AuthEvent carries the client's AuthUser (what currentUser returns)", () => {
		type SignedIn = Extract<AuthEvent, { type: 'auth:signed-in' }>
		expectTypeOf<SignedIn['user']>().toEqualTypeOf<AuthUser>()
		const event: AuthEvent = {
			type: 'auth:signed-in',
			user: { id: 'u1', email: 'a@example.com', name: null, emailVerified: true },
		}
		expect(event.type).toBe('auth:signed-in')
	})
})
