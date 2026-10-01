/**
 * AUTH-13 repro: when the access token is expired and the refresh request fails
 * because the device is OFFLINE (fetch rejects), the client wipes its stored
 * refresh token and signs the user out. For an offline-first framework a
 * transient network failure must not destroy the session.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { AuthClient } from '../../src/client/auth-client'
import { createMemoryAuthTokenStorage } from '../../src/client/storage'
import { TokenManager } from '../../src/tokens/token-manager'

function expiredAccessAndValidRefresh() {
	// Access token lifetime of 1ms => already expired when issued (exp == iat).
	const tm = new TokenManager({ secret: 'z'.repeat(64), accessTokenLifetime: 1 })
	return tm.issueTokens('user-1', 'device-1')
}

const offlineFetch = (async () => {
	throw new TypeError('Failed to fetch')
}) as unknown as typeof fetch

describe('AUTH-13: offline refresh failure signs the user out', () => {
	test('initialize() while offline keeps the refresh token and does not sign out', async () => {
		const storage = createMemoryAuthTokenStorage()
		const tokens = expiredAccessAndValidRefresh()
		await storage.setTokens(tokens.accessToken, tokens.refreshToken)
		const client = new AuthClient({ serverUrl: 'http://offline.invalid', storage, fetch: offlineFetch })

		await client.initialize()

		expect.soft(await storage.getRefreshToken()).toBe(tokens.refreshToken)
		expect(client.state).not.toBe('unauthenticated')
	})

	test('getAccessToken() (called by sync on every reconnect) while offline must not wipe the session', async () => {
		const storage = createMemoryAuthTokenStorage()
		const tokens = expiredAccessAndValidRefresh()
		await storage.setTokens(tokens.accessToken, tokens.refreshToken)
		const client = new AuthClient({ serverUrl: 'http://offline.invalid', storage, fetch: offlineFetch })

		await client.getAccessToken()

		expect(await storage.getRefreshToken()).toBe(tokens.refreshToken)
	})
})
