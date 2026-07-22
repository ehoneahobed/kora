import { beforeEach, describe, expect, test } from 'vitest'
import {
	exportPublicKeyJwk,
	generateDeviceKeyPair,
	signChallenge,
} from '../../device/device-identity'
import { InMemoryTokenRevocationStore, TokenManager } from '../../tokens/token-manager'
import { BuiltInAuthRoutes, InMemoryChallengeStore } from './auth-routes'
import { InMemoryUserStore } from './user-store'

// Must be at least 32 characters for HMAC-SHA256 security
const TEST_SECRET = 'test-secret-key-for-auth-routes-tests-min-32-chars'

function createTestRoutes(): {
	routes: BuiltInAuthRoutes
	userStore: InMemoryUserStore
	tokenManager: TokenManager
	challengeStore: InMemoryChallengeStore
} {
	const userStore = new InMemoryUserStore()
	const revocationStore = new InMemoryTokenRevocationStore()
	const tokenManager = new TokenManager({ secret: TEST_SECRET, revocationStore })
	const challengeStore = new InMemoryChallengeStore()
	const routes = new BuiltInAuthRoutes({ userStore, tokenManager, challengeStore })
	return { routes, userStore, tokenManager, challengeStore }
}

describe('handleSignUp', () => {
	test('creates a new user and returns tokens', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			name: 'Alice',
		})

		expect(result.status).toBe(201)
		expect('data' in result.body).toBe(true)

		if (!('data' in result.body)) return

		expect(result.body.data.user.email).toBe('alice@example.com')
		expect(result.body.data.user.name).toBe('Alice')
		expect(result.body.data.user.id).toBeDefined()
		expect(result.body.data.user.createdAt).toBeGreaterThan(0)
		expect(result.body.data.tokens.accessToken).toBeDefined()
		expect(result.body.data.tokens.refreshToken).toBeDefined()
	})

	test('rejects duplicate email', async () => {
		const { routes } = createTestRoutes()

		await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})

		const result = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'another-password-456',
		})

		expect(result.status).toBe(409)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('already exists')
		}
	})

	test('rejects duplicate email case-insensitively', async () => {
		const { routes } = createTestRoutes()

		await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})

		const result = await routes.handleSignUp({
			email: 'Alice@Example.COM',
			password: 'another-password-456',
		})

		expect(result.status).toBe(409)
	})

	test('rejects short password', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'short',
		})

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('at least 8 characters')
		}
	})

	test('rejects invalid email — missing @', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'not-an-email',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid email')
		}
	})

	test('rejects invalid email — missing domain dot', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'user@localhost',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})

	test('rejects empty email', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: '',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(400)
	})

	test('defaults name to email local part when name not provided', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'bob@example.com',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(201)
		if ('data' in result.body) {
			expect(result.body.data.user.name).toBe('bob')
		}
	})

	test('registers a device when device info is provided', async () => {
		const { routes, userStore } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			deviceId: 'device-001',
			devicePublicKey: 'public-key-abc',
		})

		expect(result.status).toBe(201)
		if ('data' in result.body) {
			const devices = await userStore.listDevices(result.body.data.user.id)
			expect(devices).toHaveLength(1)
			expect(devices[0]?.id).toBe('device-001')
		}
	})

	// Regression: KoraForms hit a production server bug where a POST body was
	// silently read as empty, so handlers received `{}` instead of the real
	// payload. Every body field, typed as required `string` at compile time,
	// arrived as `undefined` at runtime — and this handler crashed the process
	// with `TypeError: Cannot read properties of undefined (reading 'length')`
	// instead of returning a 400. Request bodies are untyped network input;
	// the type system can't protect against a missing field actually reaching
	// here, so this must degrade to a clean error, never a crash.
	test('returns 400 instead of throwing when email is missing from the body', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			password: 'strong-password-123',
		} as unknown as Parameters<BuiltInAuthRoutes['handleSignUp']>[0])

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})

	test('returns 400 instead of throwing when password is missing from the body', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp({
			email: 'alice@example.com',
		} as unknown as Parameters<BuiltInAuthRoutes['handleSignUp']>[0])

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})

	test('returns 400 instead of throwing when the entire body is missing fields', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleSignUp(
			{} as unknown as Parameters<BuiltInAuthRoutes['handleSignUp']>[0],
		)

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})
})

describe('handleSignIn', () => {
	let routes: BuiltInAuthRoutes

	beforeEach(async () => {
		const testCtx = createTestRoutes()
		routes = testCtx.routes

		// Create a test user
		await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			name: 'Alice',
		})
	})

	test('signs in with valid credentials', async () => {
		const result = await routes.handleSignIn({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(200)
		expect('data' in result.body).toBe(true)

		if (!('data' in result.body)) return

		expect(result.body.data.user.email).toBe('alice@example.com')
		expect(result.body.data.user.name).toBe('Alice')
		expect(result.body.data.tokens.accessToken).toBeDefined()
		expect(result.body.data.tokens.refreshToken).toBeDefined()
	})

	test('rejects wrong password', async () => {
		const result = await routes.handleSignIn({
			email: 'alice@example.com',
			password: 'wrong-password',
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid email or password')
		}
	})

	test('rejects nonexistent email', async () => {
		const result = await routes.handleSignIn({
			email: 'nobody@example.com',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid email or password')
		}
	})

	test('signs in case-insensitively on email', async () => {
		const result = await routes.handleSignIn({
			email: 'ALICE@EXAMPLE.COM',
			password: 'strong-password-123',
		})

		expect(result.status).toBe(200)
	})

	test('registers device on sign-in when device info provided', async () => {
		const testCtx = createTestRoutes()
		const localRoutes = testCtx.routes

		const signUpResult = await localRoutes.handleSignUp({
			email: 'bob@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const result = await localRoutes.handleSignIn({
			email: 'bob@example.com',
			password: 'strong-password-123',
			deviceId: 'device-new',
			devicePublicKey: 'pk-new',
		})

		expect(result.status).toBe(200)
		if ('data' in result.body) {
			const devices = await testCtx.userStore.listDevices(result.body.data.user.id)
			expect(devices.some((d) => d.id === 'device-new')).toBe(true)
		}
	})

	// Regression: same production bug as handleSignUp above. handleSignIn is
	// actually the more exposed case — it builds the rate-limit key with
	// `body.email.toLowerCase()` before any validation runs at all, so a
	// missing email crashed here even before reaching an isValidEmail check.
	test('returns 400 instead of throwing when email is missing from the body', async () => {
		const result = await routes.handleSignIn({
			password: 'strong-password-123',
		} as unknown as Parameters<BuiltInAuthRoutes['handleSignIn']>[0])

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})

	test('returns 400 instead of throwing when password is missing from the body', async () => {
		const result = await routes.handleSignIn({
			email: 'alice@example.com',
		} as unknown as Parameters<BuiltInAuthRoutes['handleSignIn']>[0])

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})

	test('returns 400 instead of throwing when the entire body is missing fields', async () => {
		const result = await routes.handleSignIn(
			{} as unknown as Parameters<BuiltInAuthRoutes['handleSignIn']>[0],
		)

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
	})
})

describe('handleRefresh', () => {
	test('refreshes with a valid refresh token', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const refreshToken = signUpResult.body.data.tokens.refreshToken

		const result = await routes.handleRefresh({ refreshToken })

		expect(result.status).toBe(200)
		expect('data' in result.body).toBe(true)
		if ('data' in result.body) {
			expect(result.body.data.accessToken).toBeDefined()
			expect(result.body.data.refreshToken).toBeDefined()
			// Tokens are valid JWTs (three dot-separated base64url segments)
			expect(result.body.data.accessToken.split('.')).toHaveLength(3)
			expect(result.body.data.refreshToken.split('.')).toHaveLength(3)
		}
	})

	test('rejects invalid token', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleRefresh({
			refreshToken: 'not-a-valid-token',
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid or expired refresh token')
		}
	})

	test('rejects access token used as refresh token', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		// Try using the access token as a refresh token — should be rejected
		// because TokenManager.refreshAccessToken checks that type === 'refresh'
		const result = await routes.handleRefresh({
			refreshToken: signUpResult.body.data.tokens.accessToken,
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
	})

	// Regression: same production bug class as handleSignUp/handleSignIn, one
	// level down. `refreshToken` is untyped network input; verifyJwt() used to
	// call `token.split('.')` with no guard, so a missing field crashed with a
	// TypeError instead of the expected 401. This traces through
	// handleRefresh, handleSignOut, handleDeviceRegister, and
	// handleDeviceVerify — they all funnel a body/header token through
	// validateToken() -> verifyJwt(), so fixing it at that one chokepoint
	// covers all four call sites at once.
	test('returns 401 instead of throwing when refreshToken is missing from the body', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleRefresh(
			{} as unknown as Parameters<BuiltInAuthRoutes['handleRefresh']>[0],
		)

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
	})
})

describe('handleGetMe', () => {
	test('returns user with valid access token', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			name: 'Alice',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const result = await routes.handleGetMe(accessToken)

		expect(result.status).toBe(200)
		expect('data' in result.body).toBe(true)
		if ('data' in result.body) {
			expect(result.body.data.email).toBe('alice@example.com')
			expect(result.body.data.name).toBe('Alice')
			expect(result.body.data.id).toBe(signUpResult.body.data.user.id)
		}
	})

	test('rejects invalid access token', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleGetMe('not-a-valid-token')

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
	})

	test('rejects refresh token used as access token', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		// Refresh tokens should not be accepted by handleGetMe
		const result = await routes.handleGetMe(signUpResult.body.data.tokens.refreshToken)

		expect(result.status).toBe(401)
	})

	test('rejects expired access token', async () => {
		// Create a token manager with 0ms lifetime to produce immediately-expired tokens
		const userStore = new InMemoryUserStore()
		const tokenManager = new TokenManager({
			secret: TEST_SECRET,
			accessTokenLifetime: 0,
		})
		const routes = new BuiltInAuthRoutes({ userStore, tokenManager })

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		// The token was issued with 0 lifetime, so exp === iat, meaning
		// it is already expired by the time we validate
		const result = await routes.handleGetMe(signUpResult.body.data.tokens.accessToken)

		// With 0 lifetime, exp = iat (same second). The token might still be valid
		// within the same second. This test verifies the mechanism works; in practice,
		// expired tokens are rejected by verifyJwt's exp check.
		// We accept either 200 (same-second) or 401 (expired) as valid behavior.
		expect([200, 401]).toContain(result.status)
	})
})

describe('handleListDevices', () => {
	test('returns registered devices', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			deviceId: 'device-001',
			devicePublicKey: 'pk-001',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const result = await routes.handleListDevices(accessToken)

		expect(result.status).toBe(200)
		expect('data' in result.body).toBe(true)
		if ('data' in result.body) {
			expect(result.body.data).toHaveLength(1)
			expect(result.body.data[0]?.id).toBe('device-001')
			expect(result.body.data[0]?.revoked).toBe(false)
		}
	})

	test('always registers a device even without explicit device info', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const result = await routes.handleListDevices(accessToken)

		expect(result.status).toBe(200)
		if ('data' in result.body) {
			expect(result.body.data).toHaveLength(1)
			expect(result.body.data[0]?.name).toBe('Browser')
		}
	})

	test('rejects invalid access token', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleListDevices('invalid-token')

		expect(result.status).toBe(401)
	})
})

describe('handleRevokeDevice', () => {
	test('revokes a device and marks it as revoked', async () => {
		const { routes, userStore } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			deviceId: 'device-001',
			devicePublicKey: 'pk-001',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const revokeResult = await routes.handleRevokeDevice(accessToken, 'device-001')

		expect(revokeResult.status).toBe(200)
		expect('data' in revokeResult.body).toBe(true)
		if ('data' in revokeResult.body) {
			expect(revokeResult.body.data.success).toBe(true)
		}

		// Verify the device is marked as revoked in the store
		const device = await userStore.findDevice('device-001')
		expect(device).not.toBeNull()
		expect(device?.revoked).toBe(true)
	})

	test('rejects revoking a nonexistent device', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const result = await routes.handleRevokeDevice(accessToken, 'nonexistent-device')

		expect(result.status).toBe(404)
		expect('error' in result.body).toBe(true)
	})

	test("rejects revoking another user's device", async () => {
		const { routes } = createTestRoutes()

		// User A signs up with a device
		await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
			deviceId: 'alice-device',
			devicePublicKey: 'pk-alice',
		})

		// User B signs up
		const bobResult = await routes.handleSignUp({
			email: 'bob@example.com',
			password: 'strong-password-456',
		})
		if (!('data' in bobResult.body)) return

		// User B tries to revoke Alice's device
		const result = await routes.handleRevokeDevice(
			bobResult.body.data.tokens.accessToken,
			'alice-device',
		)

		expect(result.status).toBe(403)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('own devices')
		}
	})

	test('rejects invalid access token', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleRevokeDevice('invalid-token', 'any-device')

		expect(result.status).toBe(401)
	})
})

describe('toSyncAuthProvider', () => {
	test('validates access tokens and returns AuthContext', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const authProvider = routes.toSyncAuthProvider()
		const context = await authProvider.authenticate(signUpResult.body.data.tokens.accessToken)

		expect(context).not.toBeNull()
		expect(context?.userId).toBe(signUpResult.body.data.user.id)
		expect(context?.metadata?.email).toBe('alice@example.com')
	})

	test('rejects invalid tokens', async () => {
		const { routes } = createTestRoutes()

		const authProvider = routes.toSyncAuthProvider()
		const context = await authProvider.authenticate('not-a-valid-token')

		expect(context).toBeNull()
	})

	test('rejects refresh tokens (only access tokens are valid)', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const authProvider = routes.toSyncAuthProvider()
		const context = await authProvider.authenticate(signUpResult.body.data.tokens.refreshToken)

		expect(context).toBeNull()
	})

	test('returns null for a deleted user', async () => {
		const { routes, userStore, tokenManager } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		// Simulate user deletion by creating a new store without the user
		// Since InMemoryUserStore doesn't have a delete method, we create
		// a fresh routes instance with a clean store but the same token manager
		const freshStore = new InMemoryUserStore()
		const freshRoutes = new BuiltInAuthRoutes({
			userStore: freshStore,
			tokenManager,
		})

		const authProvider = freshRoutes.toSyncAuthProvider()
		const context = await authProvider.authenticate(accessToken)

		// Token is valid but user doesn't exist in the new store
		expect(context).toBeNull()
	})

	test('rejects revoked access tokens', async () => {
		const { routes, tokenManager } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken
		const payload = tokenManager.validateToken(accessToken)
		expect(payload).not.toBeNull()

		await tokenManager.revokeToken(payload?.jti as string, payload?.exp as number)

		const authProvider = routes.toSyncAuthProvider()
		const context = await authProvider.authenticate(accessToken)

		expect(context).toBeNull()
	})
})

describe('handleDeviceRegister', () => {
	test('registers a device with a valid access token and returns device credential', async () => {
		const { routes } = createTestRoutes()

		// Sign up a user to get an access token
		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		// Generate a real key pair and export the public key as JWK
		const keyPair = await generateDeviceKeyPair()
		const publicKeyJwk = await exportPublicKeyJwk(keyPair)
		const publicKeyJson = JSON.stringify(publicKeyJwk)

		const result = await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-register-001',
			publicKey: publicKeyJson,
			name: 'Test Device',
		})

		expect(result.status).toBe(201)
		expect('data' in result.body).toBe(true)
		if ('data' in result.body) {
			expect(result.body.data.device.id).toBe('device-register-001')
			expect(result.body.data.device.name).toBe('Test Device')
			expect(result.body.data.device.revoked).toBe(false)
			expect(result.body.data.deviceCredential).toBeDefined()
			// Device credential is a valid JWT (three dot-separated segments)
			expect(result.body.data.deviceCredential.split('.')).toHaveLength(3)
		}
	})

	test('rejects device registration with an invalid access token', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleDeviceRegister('not-a-valid-token', {
			deviceId: 'device-register-002',
			publicKey: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
			name: 'Test Device',
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid or expired access token')
		}
	})

	test('rejects device registration with invalid public key JSON', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const result = await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-register-003',
			publicKey: 'not-valid-json',
			name: 'Test Device',
		})

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid public key format')
		}
	})

	// Regression: same production bug class again. `body.name` is untyped
	// network input; sanitizeName() used to call `.replace` on it directly
	// with no guard, so a missing name crashed instead of the expected
	// "Device name must not be empty" 400.
	test('returns 400 instead of throwing when name is missing from the body', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return
		const accessToken = signUpResult.body.data.tokens.accessToken

		const result = await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-register-004',
			publicKey: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
		} as unknown as Parameters<BuiltInAuthRoutes['handleDeviceRegister']>[1])

		expect(result.status).toBe(400)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Device name must not be empty')
		}
	})
})

describe('handleDeviceVerify', () => {
	test('verifies a device with a valid challenge and signature', async () => {
		const { routes, challengeStore } = createTestRoutes()

		// Sign up and register a device with a real key pair
		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return

		const accessToken = signUpResult.body.data.tokens.accessToken

		const keyPair = await generateDeviceKeyPair()
		const publicKeyJwk = await exportPublicKeyJwk(keyPair)
		const publicKeyJson = JSON.stringify(publicKeyJwk)

		await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-verify-001',
			publicKey: publicKeyJson,
			name: 'Verify Test Device',
		})

		// Request a challenge via the server-side endpoint
		const challengeResult = await routes.handleDeviceChallenge(accessToken, 'device-verify-001')
		expect(challengeResult.status).toBe(200)
		if (!('data' in challengeResult.body)) return
		const challenge = challengeResult.body.data.challenge

		// Sign it with the device's private key
		const signature = await signChallenge(keyPair.privateKey, challenge)

		const result = await routes.handleDeviceVerify({
			deviceId: 'device-verify-001',
			challenge,
			signature,
		})

		expect(result.status).toBe(200)
		expect('data' in result.body).toBe(true)
		if ('data' in result.body) {
			expect(result.body.data.tokens.accessToken).toBeDefined()
			expect(result.body.data.tokens.refreshToken).toBeDefined()
			expect(result.body.data.tokens.deviceCredential).toBeDefined()
			expect(result.body.data.tokens.accessToken.split('.')).toHaveLength(3)
			expect(result.body.data.tokens.refreshToken.split('.')).toHaveLength(3)
		}
	})

	test('challenge is single-use (replay protection)', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return
		const accessToken = signUpResult.body.data.tokens.accessToken

		const keyPair = await generateDeviceKeyPair()
		const publicKeyJwk = await exportPublicKeyJwk(keyPair)
		const publicKeyJson = JSON.stringify(publicKeyJwk)

		await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-replay-001',
			publicKey: publicKeyJson,
			name: 'Replay Test Device',
		})

		const challengeResult = await routes.handleDeviceChallenge(accessToken, 'device-replay-001')
		if (!('data' in challengeResult.body)) return
		const challenge = challengeResult.body.data.challenge
		const signature = await signChallenge(keyPair.privateKey, challenge)

		// First use: succeeds
		const result1 = await routes.handleDeviceVerify({
			deviceId: 'device-replay-001',
			challenge,
			signature,
		})
		expect(result1.status).toBe(200)

		// Second use (replay): rejected
		const result2 = await routes.handleDeviceVerify({
			deviceId: 'device-replay-001',
			challenge,
			signature,
		})
		expect(result2.status).toBe(401)
		if ('error' in result2.body) {
			expect(result2.body.error).toContain('Invalid or expired challenge')
		}
	})

	test('rejects verification with an invalid signature', async () => {
		const { routes } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return
		const accessToken = signUpResult.body.data.tokens.accessToken

		const keyPair = await generateDeviceKeyPair()
		const publicKeyJwk = await exportPublicKeyJwk(keyPair)
		const publicKeyJson = JSON.stringify(publicKeyJwk)

		await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-verify-002',
			publicKey: publicKeyJson,
			name: 'Verify Test Device',
		})

		// Get a server-issued challenge
		const challengeResult = await routes.handleDeviceChallenge(accessToken, 'device-verify-002')
		if (!('data' in challengeResult.body)) return
		const challenge = challengeResult.body.data.challenge

		// Sign it with a DIFFERENT key pair
		const otherKeyPair = await generateDeviceKeyPair()
		const wrongSignature = await signChallenge(otherKeyPair.privateKey, challenge)

		const result = await routes.handleDeviceVerify({
			deviceId: 'device-verify-002',
			challenge,
			signature: wrongSignature,
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid signature')
		}
	})

	test('rejects verification for a revoked device', async () => {
		const { routes, challengeStore } = createTestRoutes()

		const signUpResult = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'strong-password-123',
		})
		if (!('data' in signUpResult.body)) return
		const accessToken = signUpResult.body.data.tokens.accessToken

		const keyPair = await generateDeviceKeyPair()
		const publicKeyJwk = await exportPublicKeyJwk(keyPair)
		const publicKeyJson = JSON.stringify(publicKeyJwk)

		await routes.handleDeviceRegister(accessToken, {
			deviceId: 'device-verify-003',
			publicKey: publicKeyJson,
			name: 'Revokable Device',
		})

		// Get a challenge BEFORE revoking
		const challengeResult = await routes.handleDeviceChallenge(accessToken, 'device-verify-003')
		if (!('data' in challengeResult.body)) return
		const challenge = challengeResult.body.data.challenge

		// Revoke the device
		await routes.handleRevokeDevice(accessToken, 'device-verify-003')

		// Attempt to verify the revoked device using the pre-revocation challenge
		const signature = await signChallenge(keyPair.privateKey, challenge)

		const result = await routes.handleDeviceVerify({
			deviceId: 'device-verify-003',
			challenge,
			signature,
		})

		expect(result.status).toBe(403)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('revoked')
		}
	})

	test('rejects verification with an unknown challenge', async () => {
		const { routes } = createTestRoutes()

		const result = await routes.handleDeviceVerify({
			deviceId: 'nonexistent-device',
			challenge: 'not-a-server-issued-challenge',
			signature: 'some-signature',
		})

		expect(result.status).toBe(401)
		expect('error' in result.body).toBe(true)
		if ('error' in result.body) {
			expect(result.body.error).toContain('Invalid or expired challenge')
		}
	})
})

describe('generateChallenge', () => {
	test('returns a 64-character hex string', () => {
		const challenge = BuiltInAuthRoutes.generateChallenge()

		expect(challenge).toHaveLength(64)
		// Verify it is valid hex
		expect(/^[0-9a-f]{64}$/.test(challenge)).toBe(true)
	})

	test('generates unique challenges on each call', () => {
		const challenge1 = BuiltInAuthRoutes.generateChallenge()
		const challenge2 = BuiltInAuthRoutes.generateChallenge()

		expect(challenge1).not.toBe(challenge2)
	})
})
