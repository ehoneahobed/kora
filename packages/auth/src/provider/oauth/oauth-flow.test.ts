import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
	InMemoryOAuthStateStore,
	OAuthManager,
	githubProvider,
	googleProvider,
	microsoftProvider,
} from './oauth-flow'
import {
	OAuthCodeExchangeError,
	OAuthProviderNotFoundError,
	OAuthStateMismatchError,
	OAuthUserInfoError,
} from './oauth-types'
import type { OAuthProviderConfig } from './oauth-types'

// Mock fetch
const mockFetch = vi.fn()

function createTestProvider(overrides?: Partial<OAuthProviderConfig>): OAuthProviderConfig {
	return {
		providerId: 'test',
		clientId: 'test-client-id',
		clientSecret: 'test-client-secret',
		authorizationUrl: 'https://auth.example.com/authorize',
		tokenUrl: 'https://auth.example.com/token',
		userInfoUrl: 'https://auth.example.com/userinfo',
		scopes: ['openid', 'email'],
		redirectUri: 'http://localhost:3000/callback',
		...overrides,
	}
}

describe('OAuthManager', () => {
	let manager: OAuthManager
	let stateStore: InMemoryOAuthStateStore

	beforeEach(() => {
		stateStore = new InMemoryOAuthStateStore()
		mockFetch.mockReset()
		manager = new OAuthManager({
			providers: [createTestProvider()],
			stateStore,
			fetch: mockFetch as unknown as typeof fetch,
		})
	})

	// --- getAuthorizationUrl ---

	describe('getAuthorizationUrl', () => {
		test('generates valid authorization URL', async () => {
			const { url, state } = await manager.getAuthorizationUrl('test')

			expect(state).toBeTruthy()
			expect(state.length).toBeGreaterThan(20)

			const parsed = new URL(url)
			expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/authorize')
			expect(parsed.searchParams.get('client_id')).toBe('test-client-id')
			expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:3000/callback')
			expect(parsed.searchParams.get('response_type')).toBe('code')
			expect(parsed.searchParams.get('scope')).toBe('openid email')
			expect(parsed.searchParams.get('state')).toBe(state)
		})

		test('stores state for CSRF validation', async () => {
			const { state } = await manager.getAuthorizationUrl('test')
			const stored = await stateStore.consume(state)
			expect(stored).not.toBeNull()
			expect(stored?.provider).toBe('test')
		})

		test('includes metadata in state', async () => {
			const { state } = await manager.getAuthorizationUrl('test', { returnTo: '/dashboard' })
			const stored = await stateStore.consume(state)
			expect(stored?.metadata).toEqual({ returnTo: '/dashboard' })
		})

		test('adds PKCE challenge for public native clients', async () => {
			const pkceStore = new InMemoryOAuthStateStore()
			const pkceManager = new OAuthManager({
				providers: [createTestProvider({ clientSecret: undefined, pkce: true })],
				stateStore: pkceStore,
				fetch: mockFetch as unknown as typeof fetch,
			})

			const { url, state } = await pkceManager.getAuthorizationUrl('test')
			const parsed = new URL(url)
			const stored = await pkceStore.consume(state)

			expect(parsed.searchParams.get('code_challenge')).toBeTruthy()
			expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
			expect(stored?.codeVerifier).toBeTruthy()
			expect(stored?.codeVerifier).not.toBe(parsed.searchParams.get('code_challenge'))
		})

		test('throws for unknown provider', async () => {
			await expect(manager.getAuthorizationUrl('unknown')).rejects.toThrow(
				OAuthProviderNotFoundError,
			)
		})
	})

	// --- handleCallback ---

	describe('handleCallback', () => {
		test('exchanges code for tokens and fetches user info', async () => {
			const { state } = await manager.getAuthorizationUrl('test')

			// Mock token exchange
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					access_token: 'at-123',
					token_type: 'Bearer',
					expires_in: 3600,
					refresh_token: 'rt-456',
				}),
			})

			// Mock user info
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: 'user-ext-1',
					email: 'alice@example.com',
					name: 'Alice',
				}),
			})

			const result = await manager.handleCallback('test', 'auth-code', state)

			expect(result.tokens.accessToken).toBe('at-123')
			expect(result.tokens.tokenType).toBe('Bearer')
			expect(result.tokens.expiresIn).toBe(3600)
			expect(result.tokens.refreshToken).toBe('rt-456')

			expect(result.userInfo.providerId).toBe('user-ext-1')
			expect(result.userInfo.email).toBe('alice@example.com')
			expect(result.userInfo.name).toBe('Alice')
		})

		test('returns state metadata', async () => {
			const { state } = await manager.getAuthorizationUrl('test', { returnTo: '/settings' })

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ access_token: 'at', token_type: 'Bearer' }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'u1', email: 'a@b.com' }),
				})

			const result = await manager.handleCallback('test', 'code', state)
			expect(result.stateMetadata).toEqual({ returnTo: '/settings' })
		})

		test('sends PKCE verifier without client secret for public clients', async () => {
			const pkceManager = new OAuthManager({
				providers: [createTestProvider({ clientSecret: undefined, pkce: true })],
				stateStore: new InMemoryOAuthStateStore(),
				fetch: mockFetch as unknown as typeof fetch,
			})
			const { state } = await pkceManager.getAuthorizationUrl('test')

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ access_token: 'at', token_type: 'Bearer' }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'u1', email: 'a@b.com' }),
				})

			await pkceManager.handleCallback('test', 'code', state)

			const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
			const body = new URLSearchParams(init.body as string)
			expect(body.get('code_verifier')).toBeTruthy()
			expect(body.has('client_secret')).toBe(false)
		})

		test('rejects invalid state (CSRF protection)', async () => {
			await expect(manager.handleCallback('test', 'code', 'bogus-state')).rejects.toThrow(
				OAuthStateMismatchError,
			)
		})

		test('rejects state from different provider', async () => {
			const mgr = new OAuthManager({
				providers: [
					createTestProvider({ providerId: 'provider-a' }),
					createTestProvider({ providerId: 'provider-b' }),
				],
				stateStore,
				fetch: mockFetch as unknown as typeof fetch,
			})

			const { state } = await mgr.getAuthorizationUrl('provider-a')

			await expect(mgr.handleCallback('provider-b', 'code', state)).rejects.toThrow(
				OAuthStateMismatchError,
			)
		})

		test('state is single-use', async () => {
			const { state } = await manager.getAuthorizationUrl('test')

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ access_token: 'at', token_type: 'Bearer' }),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ id: 'u1' }),
				})

			await manager.handleCallback('test', 'code', state)

			// Second use should fail
			await expect(manager.handleCallback('test', 'code', state)).rejects.toThrow(
				OAuthStateMismatchError,
			)
		})

		test('throws on token exchange failure', async () => {
			const { state } = await manager.getAuthorizationUrl('test')

			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 400,
				text: async () => '{"error":"invalid_grant"}',
			})

			await expect(manager.handleCallback('test', 'bad-code', state)).rejects.toThrow(
				OAuthCodeExchangeError,
			)
		})

		test('throws on user info fetch failure', async () => {
			const { state } = await manager.getAuthorizationUrl('test')

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({ access_token: 'at', token_type: 'Bearer' }),
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 401,
				})

			await expect(manager.handleCallback('test', 'code', state)).rejects.toThrow(
				OAuthUserInfoError,
			)
		})

		test('throws on network error during token exchange', async () => {
			const { state } = await manager.getAuthorizationUrl('test')

			mockFetch.mockRejectedValueOnce(new Error('network down'))

			await expect(manager.handleCallback('test', 'code', state)).rejects.toThrow(
				OAuthCodeExchangeError,
			)
		})
	})

	// --- getProviderIds ---

	describe('getProviderIds', () => {
		test('returns registered provider IDs', () => {
			expect(manager.getProviderIds()).toEqual(['test'])
		})
	})
})

// --- User Info Normalization ---

describe('user info normalization', () => {
	const mockTokenResponse = {
		ok: true,
		json: async () => ({ access_token: 'at', token_type: 'Bearer' }),
	}

	test('normalizes Google user info', async () => {
		const stateStore = new InMemoryOAuthStateStore()
		const mockFn = vi.fn()
		const mgr = new OAuthManager({
			providers: [googleProvider({ clientId: 'c', clientSecret: 's', redirectUri: 'r' })],
			stateStore,
			fetch: mockFn as unknown as typeof fetch,
		})

		const { state } = await mgr.getAuthorizationUrl('google')

		mockFn.mockResolvedValueOnce(mockTokenResponse).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				sub: 'google-123',
				email: 'alice@gmail.com',
				email_verified: true,
				name: 'Alice Smith',
				picture: 'https://lh3.google.com/photo',
			}),
		})

		const { userInfo } = await mgr.handleCallback('google', 'code', state)
		expect(userInfo.providerId).toBe('google-123')
		expect(userInfo.provider).toBe('google')
		expect(userInfo.email).toBe('alice@gmail.com')
		expect(userInfo.emailVerified).toBe(true)
		expect(userInfo.name).toBe('Alice Smith')
		expect(userInfo.avatarUrl).toBe('https://lh3.google.com/photo')
	})

	test('normalizes GitHub user info', async () => {
		const stateStore = new InMemoryOAuthStateStore()
		const mockFn = vi.fn()
		const mgr = new OAuthManager({
			providers: [githubProvider({ clientId: 'c', clientSecret: 's', redirectUri: 'r' })],
			stateStore,
			fetch: mockFn as unknown as typeof fetch,
		})

		const { state } = await mgr.getAuthorizationUrl('github')

		mockFn.mockResolvedValueOnce(mockTokenResponse).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: 12345,
				login: 'alice',
				name: 'Alice Smith',
				email: 'alice@github.com',
				avatar_url: 'https://avatars.github.com/u/12345',
			}),
		})

		const { userInfo } = await mgr.handleCallback('github', 'code', state)
		expect(userInfo.providerId).toBe('12345')
		expect(userInfo.provider).toBe('github')
		expect(userInfo.email).toBe('alice@github.com')
		expect(userInfo.emailVerified).toBe(false) // GitHub doesn't confirm
		expect(userInfo.name).toBe('Alice Smith')
	})

	test('normalizes Microsoft user info', async () => {
		const stateStore = new InMemoryOAuthStateStore()
		const mockFn = vi.fn()
		const mgr = new OAuthManager({
			providers: [microsoftProvider({ clientId: 'c', clientSecret: 's', redirectUri: 'r' })],
			stateStore,
			fetch: mockFn as unknown as typeof fetch,
		})

		const { state } = await mgr.getAuthorizationUrl('microsoft')

		mockFn.mockResolvedValueOnce(mockTokenResponse).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				id: 'ms-abc',
				displayName: 'Alice Smith',
				mail: 'alice@company.com',
				userPrincipalName: 'alice@company.onmicrosoft.com',
			}),
		})

		const { userInfo } = await mgr.handleCallback('microsoft', 'code', state)
		expect(userInfo.providerId).toBe('ms-abc')
		expect(userInfo.provider).toBe('microsoft')
		expect(userInfo.email).toBe('alice@company.com')
		expect(userInfo.name).toBe('Alice Smith')
	})
})

// --- Provider Factories ---

describe('provider factories', () => {
	test('googleProvider creates correct config', () => {
		const config = googleProvider({
			clientId: 'goog-id',
			clientSecret: 'goog-secret',
			redirectUri: 'http://localhost/cb',
		})
		expect(config.providerId).toBe('google')
		expect(config.authorizationUrl).toContain('accounts.google.com')
		expect(config.scopes).toContain('openid')
	})

	test('githubProvider creates correct config', () => {
		const config = githubProvider({
			clientId: 'gh-id',
			clientSecret: 'gh-secret',
			redirectUri: 'http://localhost/cb',
		})
		expect(config.providerId).toBe('github')
		expect(config.authorizationUrl).toContain('github.com')
	})

	test('microsoftProvider with custom tenant', () => {
		const config = microsoftProvider({
			clientId: 'ms-id',
			clientSecret: 'ms-secret',
			redirectUri: 'http://localhost/cb',
			tenantId: 'my-tenant',
		})
		expect(config.authorizationUrl).toContain('my-tenant')
		expect(config.tokenUrl).toContain('my-tenant')
	})

	test('microsoftProvider with default tenant', () => {
		const config = microsoftProvider({
			clientId: 'ms-id',
			clientSecret: 'ms-secret',
			redirectUri: 'http://localhost/cb',
		})
		expect(config.authorizationUrl).toContain('common')
	})
})

// --- InMemoryOAuthStateStore ---

describe('InMemoryOAuthStateStore', () => {
	let store: InMemoryOAuthStateStore

	beforeEach(() => {
		store = new InMemoryOAuthStateStore()
	})

	test('stores and consumes state', async () => {
		const state = {
			state: 'abc',
			provider: 'google',
			redirectUri: 'http://localhost/cb',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
		}
		await store.store(state)
		const consumed = await store.consume('abc')
		expect(consumed).toEqual(state)
	})

	test('returns null for non-existent state', async () => {
		expect(await store.consume('nope')).toBeNull()
	})

	test('state is single-use', async () => {
		await store.store({
			state: 'abc',
			provider: 'test',
			redirectUri: 'http://localhost/cb',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
		})
		await store.consume('abc')
		expect(await store.consume('abc')).toBeNull()
	})

	test('returns null for expired state', async () => {
		await store.store({
			state: 'abc',
			provider: 'test',
			redirectUri: 'http://localhost/cb',
			createdAt: Date.now() - 120000,
			expiresAt: Date.now() - 1000,
		})
		expect(await store.consume('abc')).toBeNull()
	})

	test('cleanExpired removes expired states', async () => {
		await store.store({
			state: 'expired',
			provider: 'test',
			redirectUri: 'r',
			createdAt: Date.now() - 120000,
			expiresAt: Date.now() - 1000,
		})
		await store.store({
			state: 'valid',
			provider: 'test',
			redirectUri: 'r',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60000,
		})

		const count = await store.cleanExpired()
		expect(count).toBe(1)
	})
})
