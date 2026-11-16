import { describe, expect, test, vi } from 'vitest'
import { InMemoryTokenRevocationStore, TokenManager } from '../tokens/token-manager'
import { BuiltInProvider } from './adapter'
import { BuiltInAuthRoutes } from './built-in/auth-routes'
import { InMemoryUserStore } from './built-in/user-store'

// Hashing is not under test here; see password-hash.test-double.ts.
vi.mock('./built-in/password-hash', () => import('./built-in/password-hash.test-double'))

const SECRET = 'adapter-test-secret-at-least-thirty-two-chars'

function setup(): {
	provider: BuiltInProvider
	routes: BuiltInAuthRoutes
	tokenManager: TokenManager
} {
	const userStore = new InMemoryUserStore()
	const tokenManager = new TokenManager({
		secret: SECRET,
		revocationStore: new InMemoryTokenRevocationStore(),
	})
	const config = { userStore, tokenManager }
	return {
		provider: new BuiltInProvider(config),
		routes: new BuiltInAuthRoutes(config),
		tokenManager,
	}
}

describe('BuiltInProvider.validateAccessToken', () => {
	test('accepts a live access token', async () => {
		const { provider } = setup()
		const { user, tokens } = await provider.signUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		const result = await provider.validateAccessToken(tokens.accessToken)
		expect(result?.userId).toBe(user.id)
	})

	test('refuses a refresh token', async () => {
		const { provider } = setup()
		const { tokens } = await provider.signUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		expect(await provider.validateAccessToken(tokens.refreshToken)).toBeNull()
	})

	test('refuses an access token after sign-out', async () => {
		const { provider, routes } = setup()
		const { tokens } = await provider.signUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		const signOut = await routes.handleSignOut(tokens.accessToken, {
			refreshToken: tokens.refreshToken,
		})
		expect(signOut.status).toBe(200)
		expect(await provider.validateAccessToken(tokens.accessToken)).toBeNull()
	})

	test('refuses an access token after every session of the user is revoked', async () => {
		const { provider, tokenManager } = setup()
		const { user, tokens } = await provider.signUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		await tokenManager.revokeAllForUser(user.id)
		expect(await provider.validateAccessToken(tokens.accessToken)).toBeNull()
	})
})
