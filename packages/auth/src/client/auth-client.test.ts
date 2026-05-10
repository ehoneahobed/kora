import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from './auth-client'
import type { AuthState } from './auth-client'
import type { AuthTokenStorage } from './auth-client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake JWT with the given payload claims.
 * The signature is garbage -- we never verify on the client.
 */
function fakeJwt(payload: Record<string, unknown>): string {
	const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
	const body = btoa(JSON.stringify(payload))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
	return `${header}.${body}.fake-signature`
}

/** Returns a JWT whose `exp` is in the future. */
function validAccessToken(sub = 'user-123'): string {
	return fakeJwt({
		sub,
		type: 'access',
		iat: Math.floor(Date.now() / 1000) - 60,
		exp: Math.floor(Date.now() / 1000) + 3600,
	})
}

/** Returns a JWT whose `exp` is in the past. */
function expiredAccessToken(sub = 'user-123'): string {
	return fakeJwt({
		sub,
		type: 'access',
		iat: Math.floor(Date.now() / 1000) - 7200,
		exp: Math.floor(Date.now() / 1000) - 60,
	})
}

function validRefreshToken(): string {
	return fakeJwt({
		sub: 'user-123',
		type: 'refresh',
		iat: Math.floor(Date.now() / 1000) - 60,
		exp: Math.floor(Date.now() / 1000) + 86400,
	})
}

const USER_PROFILE = {
	id: 'user-123',
	email: 'test@example.com',
	name: 'Test User',
}

const TOKEN_RESPONSE = {
	accessToken: validAccessToken(),
	refreshToken: validRefreshToken(),
}

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

function createMockLocalStorage(): Storage {
	const store = new Map<string, string>()
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value)
		},
		removeItem: (key: string) => {
			store.delete(key)
		},
		clear: () => {
			store.clear()
		},
		get length() {
			return store.size
		},
		key: (index: number) => {
			const keys = Array.from(store.keys())
			return keys[index] ?? null
		},
	}
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('AuthClient', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let mockStorage: Storage

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		mockStorage = createMockLocalStorage()
		vi.stubGlobal('window', { localStorage: mockStorage })
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	function createClient(config?: Partial<{ serverUrl: string; storageKey: string }>): AuthClient {
		return new AuthClient({
			serverUrl: config?.serverUrl ?? 'http://localhost:3001',
			storageKey: config?.storageKey ?? 'kora_auth',
		})
	}

	function createAsyncStorage(): AuthTokenStorage & {
		accessToken: string | null
		refreshToken: string | null
	} {
		return {
			accessToken: null,
			refreshToken: null,
			async getAccessToken() {
				return this.accessToken
			},
			async getRefreshToken() {
				return this.refreshToken
			},
			async setTokens(access: string, refresh: string) {
				this.accessToken = access
				this.refreshToken = refresh
			},
			async clear() {
				this.accessToken = null
				this.refreshToken = null
			},
		}
	}

	function mockFetchResponse(body: unknown, status = 200): void {
		fetchMock.mockResolvedValueOnce({
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		})
	}

	// -----------------------------------------------------------------------
	// initialize()
	// -----------------------------------------------------------------------

	describe('initialize()', () => {
		it('sets state to unauthenticated when no stored tokens exist', async () => {
			const client = createClient()
			await client.initialize()

			expect(client.state).toBe('unauthenticated')
			expect(client.currentUser).toBeNull()
			expect(client.isAuthenticated).toBe(false)
		})

		it('restores session with valid stored tokens', async () => {
			// Pre-populate storage with valid tokens
			mockStorage.setItem('kora_auth_access_token', validAccessToken())
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())

			// Mock the /auth/me response
			mockFetchResponse(USER_PROFILE)

			const client = createClient()
			await client.initialize()

			expect(client.state).toBe('authenticated')
			expect(client.currentUser).toEqual(USER_PROFILE)
			expect(client.isAuthenticated).toBe(true)
		})

		it('auto-refreshes when access token is expired but refresh token is valid', async () => {
			// Pre-populate with expired access, valid refresh
			mockStorage.setItem('kora_auth_access_token', expiredAccessToken())
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())

			// First call: /auth/refresh returns new tokens
			const newAccessToken = validAccessToken()
			mockFetchResponse({
				accessToken: newAccessToken,
				refreshToken: validRefreshToken(),
			})

			// Second call: /auth/me with new token
			mockFetchResponse(USER_PROFILE)

			const client = createClient()
			await client.initialize()

			expect(client.state).toBe('authenticated')
			expect(client.currentUser).toEqual(USER_PROFILE)

			// Verify refresh was called
			expect(fetchMock).toHaveBeenCalledTimes(2)
			const firstCallUrl = fetchMock.mock.calls[0]?.[0] as string
			expect(firstCallUrl).toContain('/auth/refresh')
		})

		it('sets state to unauthenticated when refresh fails', async () => {
			mockStorage.setItem('kora_auth_access_token', expiredAccessToken())
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())

			// Refresh returns error
			mockFetchResponse({ error: 'Token revoked' }, 401)

			const client = createClient()
			await client.initialize()

			expect(client.state).toBe('unauthenticated')
			expect(client.currentUser).toBeNull()
		})
	})

	// -----------------------------------------------------------------------
	// signUp()
	// -----------------------------------------------------------------------

	describe('signUp()', () => {
		it('creates account and sets authenticated state', async () => {
			const client = createClient()
			await client.initialize()

			// /auth/signup response
			mockFetchResponse(TOKEN_RESPONSE)
			// /auth/me response
			mockFetchResponse(USER_PROFILE)

			const user = await client.signUp({
				email: 'test@example.com',
				password: 'password123',
				name: 'Test User',
			})

			expect(user).toEqual(USER_PROFILE)
			expect(client.state).toBe('authenticated')
			expect(client.currentUser).toEqual(USER_PROFILE)

			// Tokens should be stored
			expect(mockStorage.getItem('kora_auth_access_token')).toBeTruthy()
			expect(mockStorage.getItem('kora_auth_refresh_token')).toBeTruthy()
		})
	})

	// -----------------------------------------------------------------------
	// signIn()
	// -----------------------------------------------------------------------

	describe('signIn()', () => {
		it('authenticates and stores tokens', async () => {
			const client = createClient()
			await client.initialize()

			// /auth/signin response
			mockFetchResponse(TOKEN_RESPONSE)
			// /auth/me response
			mockFetchResponse(USER_PROFILE)

			const user = await client.signIn({
				email: 'test@example.com',
				password: 'password123',
			})

			expect(user).toEqual(USER_PROFILE)
			expect(client.state).toBe('authenticated')
			expect(client.isAuthenticated).toBe(true)
		})

		it('passes device identity fields to the auth server', async () => {
			const client = createClient()
			await client.initialize()

			mockFetchResponse(TOKEN_RESPONSE)
			mockFetchResponse(USER_PROFILE)

			await client.signIn({
				email: 'test@example.com',
				password: 'password123',
				deviceId: 'device-1',
				devicePublicKey: '{"kty":"EC"}',
			})

			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			expect(JSON.parse(init.body as string)).toMatchObject({
				email: 'test@example.com',
				password: 'password123',
				deviceId: 'device-1',
				devicePublicKey: '{"kty":"EC"}',
			})
		})

		it('throws AuthError on invalid credentials', async () => {
			const client = createClient()
			await client.initialize()

			mockFetchResponse({ error: 'Invalid email or password' }, 401)

			await expect(client.signIn({ email: 'bad@example.com', password: 'wrong' })).rejects.toThrow(
				'Invalid email or password',
			)

			expect(client.state).toBe('unauthenticated')
		})

		it('throws AuthError on network failure', async () => {
			const client = createClient()
			await client.initialize()

			fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

			await expect(
				client.signIn({ email: 'test@example.com', password: 'password123' }),
			).rejects.toThrow(/Network request/)

			// State should remain unauthenticated (not crash)
			expect(client.state).toBe('unauthenticated')
		})
	})

	// -----------------------------------------------------------------------
	// signOut()
	// -----------------------------------------------------------------------

	describe('signOut()', () => {
		it('clears state and tokens', async () => {
			// Start authenticated
			mockStorage.setItem('kora_auth_access_token', validAccessToken())
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())
			mockFetchResponse(USER_PROFILE)

			const client = createClient()
			await client.initialize()
			expect(client.state).toBe('authenticated')

			await client.signOut()

			expect(client.state).toBe('unauthenticated')
			expect(client.currentUser).toBeNull()
			expect(client.isAuthenticated).toBe(false)
			expect(mockStorage.getItem('kora_auth_access_token')).toBeNull()
			expect(mockStorage.getItem('kora_auth_refresh_token')).toBeNull()
		})
	})

	// -----------------------------------------------------------------------
	// onAuthChange()
	// -----------------------------------------------------------------------

	describe('onAuthChange()', () => {
		it('notifies listener on sign in', async () => {
			const client = createClient()
			await client.initialize()

			const states: AuthState[] = []
			client.onAuthChange((state) => {
				states.push(state)
			})

			// Sign in
			mockFetchResponse(TOKEN_RESPONSE)
			mockFetchResponse(USER_PROFILE)
			await client.signIn({ email: 'test@example.com', password: 'password123' })

			expect(states).toContain('authenticated')
		})

		it('notifies listener on sign out', async () => {
			// Start authenticated
			mockStorage.setItem('kora_auth_access_token', validAccessToken())
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())
			mockFetchResponse(USER_PROFILE)

			const client = createClient()
			await client.initialize()

			const states: AuthState[] = []
			client.onAuthChange((state) => {
				states.push(state)
			})

			await client.signOut()

			expect(states).toContain('unauthenticated')
		})

		it('returns an unsubscribe function that stops notifications', async () => {
			const client = createClient()
			await client.initialize()

			const states: AuthState[] = []
			const unsub = client.onAuthChange((state) => {
				states.push(state)
			})

			// Unsubscribe before sign-in
			unsub()

			mockFetchResponse(TOKEN_RESPONSE)
			mockFetchResponse(USER_PROFILE)
			await client.signIn({ email: 'test@example.com', password: 'password123' })

			// Listener should NOT have been called
			expect(states).toHaveLength(0)
		})
	})

	// -----------------------------------------------------------------------
	// getAccessToken()
	// -----------------------------------------------------------------------

	describe('getAccessToken()', () => {
		it('returns stored token when still valid', async () => {
			const token = validAccessToken()
			mockStorage.setItem('kora_auth_access_token', token)
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())
			mockFetchResponse(USER_PROFILE)

			const client = createClient()
			await client.initialize()

			const result = await client.getAccessToken()
			expect(result).toBe(token)
		})

		it('auto-refreshes expired token and returns new one', async () => {
			// Sign in first to get authenticated state
			const client = createClient()
			await client.initialize()

			mockFetchResponse(TOKEN_RESPONSE)
			mockFetchResponse(USER_PROFILE)
			await client.signIn({ email: 'test@example.com', password: 'password123' })

			// Now simulate the stored access token being expired by replacing it
			const expiredToken = expiredAccessToken()
			mockStorage.setItem('kora_auth_access_token', expiredToken)

			// Mock the refresh response
			const freshToken = validAccessToken('user-123')
			mockFetchResponse({
				accessToken: freshToken,
				refreshToken: validRefreshToken(),
			})

			const result = await client.getAccessToken()
			expect(result).toBe(freshToken)
		})

		it('returns null when no tokens are available', async () => {
			const client = createClient()
			await client.initialize()

			const result = await client.getAccessToken()
			expect(result).toBeNull()
		})

		it('supports async custom token storage for mobile runtimes', async () => {
			const storage = createAsyncStorage()
			storage.accessToken = validAccessToken()
			storage.refreshToken = validRefreshToken()
			mockFetchResponse(USER_PROFILE)

			const client = new AuthClient({
				serverUrl: 'http://localhost:3001',
				storage,
			})
			await client.initialize()

			expect(client.state).toBe('authenticated')
			expect(await client.getAccessToken()).toBe(storage.accessToken)
		})
	})

	// -----------------------------------------------------------------------
	// getSyncToken()
	// -----------------------------------------------------------------------

	describe('getSyncToken()', () => {
		it('is an alias for getAccessToken', async () => {
			const token = validAccessToken()
			mockStorage.setItem('kora_auth_access_token', token)
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())
			mockFetchResponse(USER_PROFILE)

			const client = createClient()
			await client.initialize()

			const result = await client.getSyncToken()
			expect(result).toBe(token)
		})
	})

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------

	describe('edge cases', () => {
		it('does not crash when listener throws', async () => {
			const client = createClient()
			await client.initialize()

			const goodStates: AuthState[] = []
			client.onAuthChange(() => {
				throw new Error('Listener error')
			})
			client.onAuthChange((state) => {
				goodStates.push(state)
			})

			mockFetchResponse(TOKEN_RESPONSE)
			mockFetchResponse(USER_PROFILE)

			// Should not throw even though the first listener throws
			await client.signIn({ email: 'test@example.com', password: 'password123' })

			// The second listener still received the notification
			expect(goodStates).toContain('authenticated')
		})

		it('strips trailing slash from serverUrl', async () => {
			const client = new AuthClient({ serverUrl: 'http://localhost:3001/' })
			await client.initialize()

			mockFetchResponse(TOKEN_RESPONSE)
			mockFetchResponse(USER_PROFILE)
			await client.signIn({ email: 'test@example.com', password: 'password123' })

			const calledUrl = fetchMock.mock.calls[0]?.[0] as string
			expect(calledUrl).toBe('http://localhost:3001/auth/signin')
		})

		it('uses custom fetch implementation when provided', async () => {
			const customFetch = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ data: TOKEN_RESPONSE }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ data: USER_PROFILE }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					}),
				)

			const client = new AuthClient({
				serverUrl: 'http://localhost:3001',
				fetch: customFetch,
			})
			await client.initialize()
			await client.signIn({ email: 'test@example.com', password: 'password123' })

			expect(customFetch).toHaveBeenCalled()
			expect(fetchMock).not.toHaveBeenCalled()
		})

		it('works offline during initialize with valid unexpired token', async () => {
			mockStorage.setItem('kora_auth_access_token', validAccessToken('user-456'))
			mockStorage.setItem('kora_auth_refresh_token', validRefreshToken())

			// /auth/me fails (offline)
			fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

			const client = createClient()
			await client.initialize()

			// Should still be authenticated with minimal user info from token
			expect(client.state).toBe('authenticated')
			expect(client.currentUser?.id).toBe('user-456')
		})
	})
})
