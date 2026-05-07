import { describe, expect, test } from 'vitest'
import { encodeJwt } from '../../tokens/jwt'
import {
	ExternalJwtProvider,
	ExternalAuthOperationNotSupportedError,
	ExternalTokenValidationError,
} from './external-jwt-provider'
import { createClerkAdapter } from './clerk-adapter'
import { createSupabaseAdapter } from './supabase-adapter'

// ============================================================================
// Test helpers
// ============================================================================

const TEST_SECRET = 'kora-external-test-secret-must-be-32-chars-long'

/** Create a valid HS256 JWT with the given claims */
function createTestToken(
	claims: Record<string, unknown>,
	secret: string = TEST_SECRET,
): string {
	return encodeJwt(claims, secret)
}

/** Create a token with standard claims and a future expiration */
function createValidToken(
	overrides: Record<string, unknown> = {},
	secret: string = TEST_SECRET,
): string {
	const nowSeconds = Math.floor(Date.now() / 1000)
	return createTestToken(
		{
			sub: 'user-123',
			email: 'alice@example.com',
			name: 'Alice',
			iat: nowSeconds,
			exp: nowSeconds + 3600,
			...overrides,
		},
		secret,
	)
}

// ============================================================================
// ExternalJwtProvider — construction
// ============================================================================

describe('ExternalJwtProvider construction', () => {
	test('requires at least jwtSecret or validateToken', () => {
		expect(
			() =>
				new ExternalJwtProvider({
					providerName: 'test',
				}),
		).toThrow(ExternalTokenValidationError)
	})

	test('accepts jwtSecret alone', () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test',
			jwtSecret: TEST_SECRET,
		})
		expect(provider).toBeInstanceOf(ExternalJwtProvider)
	})

	test('accepts validateToken alone', () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test',
			validateToken: async () => null,
		})
		expect(provider).toBeInstanceOf(ExternalJwtProvider)
	})

	test('accepts both jwtSecret and validateToken', () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test',
			jwtSecret: TEST_SECRET,
			validateToken: async () => null,
		})
		expect(provider).toBeInstanceOf(ExternalJwtProvider)
	})
})

// ============================================================================
// ExternalJwtProvider — validateAccessToken with jwtSecret (HS256)
// ============================================================================

describe('ExternalJwtProvider.validateAccessToken (HS256)', () => {
	const provider = new ExternalJwtProvider({
		providerName: 'test-hs256',
		jwtSecret: TEST_SECRET,
	})

	test('returns userId and deviceId for a valid token', async () => {
		const token = createValidToken({ sub: 'user-abc' })
		const result = await provider.validateAccessToken(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('user-abc')
		expect(result?.deviceId).toBe('external-test-hs256-user-abc')
	})

	test('returns null for a token signed with wrong secret', async () => {
		const token = createValidToken({ sub: 'user-abc' }, 'wrong-secret-that-is-long-enough')
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('returns null for a malformed token', async () => {
		const result = await provider.validateAccessToken('not.a.valid.jwt')
		expect(result).toBeNull()
	})

	test('returns null for an empty string', async () => {
		const result = await provider.validateAccessToken('')
		expect(result).toBeNull()
	})

	test('returns null for an expired token', async () => {
		const pastExp = Math.floor(Date.now() / 1000) - 3600
		const token = createTestToken({
			sub: 'user-abc',
			iat: pastExp - 3600,
			exp: pastExp,
		})
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('returns null when sub claim is missing', async () => {
		const token = createTestToken({
			email: 'alice@example.com',
			exp: Math.floor(Date.now() / 1000) + 3600,
		})
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('returns null when sub claim is empty string', async () => {
		const token = createValidToken({ sub: '' })
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('returns null when sub claim is not a string', async () => {
		const token = createValidToken({ sub: 12345 })
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})
})

// ============================================================================
// ExternalJwtProvider — validateAccessToken with custom validateToken
// ============================================================================

describe('ExternalJwtProvider.validateAccessToken (custom validator)', () => {
	test('uses custom validateToken when provided', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'custom',
			validateToken: async (token) => {
				if (token === 'magic-token') {
					return { sub: 'custom-user-1', role: 'admin' }
				}
				return null
			},
		})

		const result = await provider.validateAccessToken('magic-token')
		expect(result).not.toBeNull()
		expect(result?.userId).toBe('custom-user-1')
		expect(result?.deviceId).toBe('external-custom-custom-user-1')
	})

	test('returns null when custom validator returns null', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'custom',
			validateToken: async () => null,
		})

		const result = await provider.validateAccessToken('any-token')
		expect(result).toBeNull()
	})

	test('returns null when custom validator throws', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'custom',
			validateToken: async () => {
				throw new Error('Network error')
			},
		})

		const result = await provider.validateAccessToken('any-token')
		expect(result).toBeNull()
	})

	test('custom validateToken takes precedence over jwtSecret', async () => {
		let customCalled = false
		const provider = new ExternalJwtProvider({
			providerName: 'both',
			jwtSecret: TEST_SECRET,
			validateToken: async () => {
				customCalled = true
				return { sub: 'custom-wins' }
			},
		})

		const result = await provider.validateAccessToken('any-token')
		expect(customCalled).toBe(true)
		expect(result?.userId).toBe('custom-wins')
	})
})

// ============================================================================
// ExternalJwtProvider — claims mapping
// ============================================================================

describe('ExternalJwtProvider claim mapping', () => {
	test('default mapping extracts sub, email, and name', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test',
			jwtSecret: TEST_SECRET,
		})

		const token = createValidToken({
			sub: 'user-mapped',
			email: 'mapped@example.com',
			name: 'Mapped User',
		})
		const result = await provider.validateAccessToken(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('user-mapped')
	})

	test('custom mapClaims transforms claims correctly', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'custom-claims',
			jwtSecret: TEST_SECRET,
			mapClaims: (claims) => ({
				userId: `prefixed-${claims['sub'] as string}`,
				email: claims['email_address'] as string,
				name: `${claims['given_name'] as string} ${claims['family_name'] as string}`,
				metadata: { tenant: claims['tenant_id'] },
			}),
		})

		const token = createValidToken({
			sub: 'raw-id',
			email_address: 'custom@example.com',
			given_name: 'John',
			family_name: 'Doe',
			tenant_id: 'tenant-abc',
		})
		const result = await provider.validateAccessToken(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('prefixed-raw-id')
		expect(result?.deviceId).toBe('external-custom-claims-prefixed-raw-id')
	})

	test('returns null when custom mapClaims throws', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'bad-map',
			jwtSecret: TEST_SECRET,
			mapClaims: () => {
				throw new Error('mapping exploded')
			},
		})

		const token = createValidToken()
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('returns null when custom mapClaims returns empty userId', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'empty-id',
			jwtSecret: TEST_SECRET,
			mapClaims: () => ({
				userId: '',
			}),
		})

		const token = createValidToken()
		const result = await provider.validateAccessToken(token)
		expect(result).toBeNull()
	})
})

// ============================================================================
// ExternalJwtProvider — unsupported operations
// ============================================================================

describe('ExternalJwtProvider unsupported operations', () => {
	const provider = new ExternalJwtProvider({
		providerName: 'my-provider',
		jwtSecret: TEST_SECRET,
	})

	test('signUp throws ExternalAuthOperationNotSupportedError', async () => {
		await expect(
			provider.signUp({ email: 'test@example.com', password: 'password123' }),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)

		await expect(
			provider.signUp({ email: 'test@example.com', password: 'password123' }),
		).rejects.toThrow(/signUp.*my-provider/)
	})

	test('signIn throws ExternalAuthOperationNotSupportedError', async () => {
		await expect(
			provider.signIn({ email: 'test@example.com', password: 'password123' }),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)

		await expect(
			provider.signIn({ email: 'test@example.com', password: 'password123' }),
		).rejects.toThrow(/signIn.*my-provider/)
	})

	test('refreshTokens throws ExternalAuthOperationNotSupportedError', async () => {
		await expect(
			provider.refreshTokens('some-refresh-token'),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})

	test('getUser throws ExternalAuthOperationNotSupportedError', async () => {
		await expect(
			provider.getUser('user-123'),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})

	test('revokeDevice throws ExternalAuthOperationNotSupportedError', async () => {
		await expect(
			provider.revokeDevice('access-token', 'device-123'),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})

	test('listDevices throws ExternalAuthOperationNotSupportedError', async () => {
		await expect(
			provider.listDevices('access-token'),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})

	test('error messages include operation name and provider name', async () => {
		try {
			await provider.signUp({ email: 'test@example.com', password: 'password123' })
			expect.unreachable('Should have thrown')
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(ExternalAuthOperationNotSupportedError)
			const authError = error as ExternalAuthOperationNotSupportedError
			expect(authError.message).toContain('signUp')
			expect(authError.message).toContain('my-provider')
			expect(authError.code).toBe('AUTH_EXTERNAL_OPERATION_NOT_SUPPORTED')
			expect(authError.context).toEqual({ operation: 'signUp', provider: 'my-provider' })
		}
	})
})

// ============================================================================
// ExternalJwtProvider — toSyncAuthProvider
// ============================================================================

describe('ExternalJwtProvider.toSyncAuthProvider', () => {
	test('authenticate returns userId and metadata for valid token', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test-sync',
			jwtSecret: TEST_SECRET,
		})
		const syncAuth = provider.toSyncAuthProvider()

		const token = createValidToken({
			sub: 'sync-user-1',
			email: 'sync@example.com',
			name: 'Sync User',
		})
		const result = await syncAuth.authenticate(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('sync-user-1')
		expect(result?.metadata).toEqual({
			provider: 'test-sync',
			email: 'sync@example.com',
			name: 'Sync User',
		})
	})

	test('authenticate returns null for invalid token', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test-sync',
			jwtSecret: TEST_SECRET,
		})
		const syncAuth = provider.toSyncAuthProvider()

		const result = await syncAuth.authenticate('invalid-token')
		expect(result).toBeNull()
	})

	test('authenticate returns null when mapClaims fails', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test-sync',
			jwtSecret: TEST_SECRET,
			mapClaims: () => {
				throw new Error('boom')
			},
		})
		const syncAuth = provider.toSyncAuthProvider()

		const token = createValidToken()
		const result = await syncAuth.authenticate(token)
		expect(result).toBeNull()
	})

	test('authenticate returns null when userId is empty', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test-sync',
			jwtSecret: TEST_SECRET,
			mapClaims: () => ({ userId: '' }),
		})
		const syncAuth = provider.toSyncAuthProvider()

		const token = createValidToken()
		const result = await syncAuth.authenticate(token)
		expect(result).toBeNull()
	})

	test('authenticate includes custom metadata from mapClaims', async () => {
		const provider = new ExternalJwtProvider({
			providerName: 'test-sync',
			jwtSecret: TEST_SECRET,
			mapClaims: (claims) => ({
				userId: claims['sub'] as string,
				email: 'custom@test.com',
				name: 'Custom Name',
				metadata: { role: 'admin', orgId: 'org-1' },
			}),
		})
		const syncAuth = provider.toSyncAuthProvider()

		const token = createValidToken()
		const result = await syncAuth.authenticate(token)

		expect(result).not.toBeNull()
		expect(result?.metadata).toEqual({
			provider: 'test-sync',
			email: 'custom@test.com',
			name: 'Custom Name',
			role: 'admin',
			orgId: 'org-1',
		})
	})
})

// ============================================================================
// Clerk adapter
// ============================================================================

describe('createClerkAdapter', () => {
	test('creates an ExternalJwtProvider with provider name "clerk"', () => {
		const adapter = createClerkAdapter({
			validateToken: async () => null,
		})
		expect(adapter).toBeInstanceOf(ExternalJwtProvider)
	})

	test('validates tokens using the provided validateToken function', async () => {
		const adapter = createClerkAdapter({
			validateToken: async (token) => {
				if (token === 'clerk-session-token') {
					return {
						sub: 'user_2abc123',
						email: 'alice@clerk.dev',
						first_name: 'Alice',
						last_name: 'Smith',
						org_id: 'org_xyz',
						org_slug: 'acme',
						org_role: 'admin',
					}
				}
				return null
			},
		})

		const result = await adapter.validateAccessToken('clerk-session-token')
		expect(result).not.toBeNull()
		expect(result?.userId).toBe('user_2abc123')
		expect(result?.deviceId).toBe('external-clerk-user_2abc123')
	})

	test('returns null for invalid Clerk tokens', async () => {
		const adapter = createClerkAdapter({
			validateToken: async () => null,
		})

		const result = await adapter.validateAccessToken('invalid-token')
		expect(result).toBeNull()
	})

	test('default claim mapping extracts Clerk-specific fields', async () => {
		const adapter = createClerkAdapter({
			validateToken: async () => ({
				sub: 'user_clerk1',
				email: 'clerk@example.com',
				first_name: 'Jane',
				last_name: 'Doe',
				org_id: 'org_123',
				org_slug: 'my-org',
				org_role: 'member',
			}),
		})

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate('any')

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('user_clerk1')
		expect(result?.metadata).toEqual({
			provider: 'clerk',
			email: 'clerk@example.com',
			name: 'Jane Doe',
			orgId: 'org_123',
			orgSlug: 'my-org',
			orgRole: 'member',
		})
	})

	test('default claim mapping handles missing optional fields', async () => {
		const adapter = createClerkAdapter({
			validateToken: async () => ({
				sub: 'user_minimal',
			}),
		})

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate('any')

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('user_minimal')
		expect(result?.metadata).toEqual({
			provider: 'clerk',
			email: undefined,
			name: undefined,
		})
	})

	test('default claim mapping handles only first_name present', async () => {
		const adapter = createClerkAdapter({
			validateToken: async () => ({
				sub: 'user_first_only',
				first_name: 'Alice',
			}),
		})

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate('any')

		expect(result?.metadata?.['name']).toBe('Alice')
	})

	test('custom mapClaims overrides default Clerk mapping', async () => {
		const adapter = createClerkAdapter({
			validateToken: async () => ({
				sub: 'user_custom',
				custom_field: 'custom_value',
			}),
			mapClaims: (claims) => ({
				userId: `clerk-${claims['sub'] as string}`,
				metadata: { custom: claims['custom_field'] },
			}),
		})

		const result = await adapter.validateAccessToken('any')
		expect(result?.userId).toBe('clerk-user_custom')
	})

	test('signUp throws for Clerk adapter', async () => {
		const adapter = createClerkAdapter({
			validateToken: async () => null,
		})

		await expect(
			adapter.signUp({ email: 'test@test.com', password: 'pass1234' }),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})
})

// ============================================================================
// Supabase adapter
// ============================================================================

describe('createSupabaseAdapter', () => {
	test('creates an ExternalJwtProvider with provider name "supabase"', () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})
		expect(adapter).toBeInstanceOf(ExternalJwtProvider)
	})

	test('validates tokens using HS256 with the provided JWT secret', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const nowSeconds = Math.floor(Date.now() / 1000)
		const token = createTestToken({
			sub: 'supabase-user-uuid',
			email: 'alice@supabase.io',
			role: 'authenticated',
			aud: 'authenticated',
			iat: nowSeconds,
			exp: nowSeconds + 3600,
			user_metadata: {
				full_name: 'Alice Johnson',
			},
		})

		const result = await adapter.validateAccessToken(token)
		expect(result).not.toBeNull()
		expect(result?.userId).toBe('supabase-user-uuid')
		expect(result?.deviceId).toBe('external-supabase-supabase-user-uuid')
	})

	test('returns null for token signed with wrong secret', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const token = createValidToken(
			{ sub: 'user-wrong' },
			'different-secret-that-is-long-enough-32',
		)
		const result = await adapter.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('returns null for expired Supabase token', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const pastExp = Math.floor(Date.now() / 1000) - 3600
		const token = createTestToken({
			sub: 'expired-user',
			iat: pastExp - 3600,
			exp: pastExp,
		})
		const result = await adapter.validateAccessToken(token)
		expect(result).toBeNull()
	})

	test('default claim mapping extracts Supabase-specific fields', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const nowSeconds = Math.floor(Date.now() / 1000)
		const token = createTestToken({
			sub: 'sb-user-1',
			email: 'sb@example.com',
			role: 'authenticated',
			aud: 'authenticated',
			iat: nowSeconds,
			exp: nowSeconds + 3600,
			user_metadata: {
				full_name: 'Supabase User',
				avatar_url: 'https://example.com/avatar.png',
			},
			app_metadata: {
				provider: 'email',
				providers: ['email'],
			},
		})

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('sb-user-1')
		expect(result?.metadata).toEqual({
			provider: 'supabase',
			email: 'sb@example.com',
			name: 'Supabase User',
			role: 'authenticated',
			aud: 'authenticated',
			appMetadata: {
				provider: 'email',
				providers: ['email'],
			},
		})
	})

	test('default claim mapping falls back to user_metadata.name', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const nowSeconds = Math.floor(Date.now() / 1000)
		const token = createTestToken({
			sub: 'sb-user-name',
			iat: nowSeconds,
			exp: nowSeconds + 3600,
			user_metadata: {
				name: 'Name Only',
			},
		})

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate(token)

		expect(result?.metadata?.['name']).toBe('Name Only')
	})

	test('default claim mapping handles missing user_metadata', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const token = createValidToken({ sub: 'sb-user-no-meta' })

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('sb-user-no-meta')
	})

	test('default claim mapping handles user_metadata that is not an object', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		const token = createValidToken({
			sub: 'sb-user-bad-meta',
			user_metadata: 'not-an-object',
		})

		const syncAuth = adapter.toSyncAuthProvider()
		const result = await syncAuth.authenticate(token)

		expect(result).not.toBeNull()
		expect(result?.userId).toBe('sb-user-bad-meta')
	})

	test('custom mapClaims overrides default Supabase mapping', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
			mapClaims: (claims) => ({
				userId: `sb-${claims['sub'] as string}`,
				email: claims['email'] as string,
			}),
		})

		const token = createValidToken({
			sub: 'custom-mapped',
			email: 'custom@sb.com',
		})
		const result = await adapter.validateAccessToken(token)
		expect(result?.userId).toBe('sb-custom-mapped')
	})

	test('signUp throws for Supabase adapter', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		await expect(
			adapter.signUp({ email: 'test@test.com', password: 'pass1234' }),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})

	test('signIn throws for Supabase adapter', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		await expect(
			adapter.signIn({ email: 'test@test.com', password: 'pass1234' }),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})

	test('refreshTokens throws for Supabase adapter', async () => {
		const adapter = createSupabaseAdapter({
			jwtSecret: TEST_SECRET,
		})

		await expect(
			adapter.refreshTokens('refresh-token'),
		).rejects.toThrow(ExternalAuthOperationNotSupportedError)
	})
})

// ============================================================================
// Error class coverage
// ============================================================================

describe('Error classes', () => {
	test('ExternalAuthOperationNotSupportedError has correct properties', () => {
		const error = new ExternalAuthOperationNotSupportedError('signUp', 'clerk')
		expect(error.name).toBe('ExternalAuthOperationNotSupportedError')
		expect(error.code).toBe('AUTH_EXTERNAL_OPERATION_NOT_SUPPORTED')
		expect(error.context).toEqual({ operation: 'signUp', provider: 'clerk' })
		expect(error.message).toContain('signUp')
		expect(error.message).toContain('clerk')
		expect(error).toBeInstanceOf(Error)
	})

	test('ExternalTokenValidationError has correct properties', () => {
		const error = new ExternalTokenValidationError('bad token', { detail: 'expired' })
		expect(error.name).toBe('ExternalTokenValidationError')
		expect(error.code).toBe('AUTH_EXTERNAL_TOKEN_INVALID')
		expect(error.context).toEqual({ detail: 'expired' })
		expect(error.message).toContain('bad token')
		expect(error).toBeInstanceOf(Error)
	})
})
