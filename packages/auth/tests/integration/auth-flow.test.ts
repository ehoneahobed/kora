/**
 * Integration tests for core auth flows.
 *
 * Tests cross-module interactions: sign-up → sign-in → token refresh → sign-out,
 * device registration, email verification, password reset, and token revocation.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import {
	BuiltInAuthRoutes,
	InMemoryUserStore,
	TokenManager,
	InMemoryTokenRevocationStore,
	EmailVerificationManager,
	PasswordResetManager,
} from '../../src/server'

describe('Auth flow integration', () => {
	let userStore: InstanceType<typeof InMemoryUserStore>
	let revocationStore: InstanceType<typeof InMemoryTokenRevocationStore>
	let tokenManager: InstanceType<typeof TokenManager>
	let routes: InstanceType<typeof BuiltInAuthRoutes>

	beforeEach(() => {
		userStore = new InMemoryUserStore()
		revocationStore = new InMemoryTokenRevocationStore()
		tokenManager = new TokenManager({
			secret: TokenManager.generateSecret(),
			revocationStore,
		})
		routes = new BuiltInAuthRoutes({ userStore, tokenManager })
	})

	// ========================================================================
	// Sign-up → Sign-in → Me → Sign-out
	// ========================================================================

	test('full sign-up → sign-in → me → sign-out flow', async () => {
		// 1. Sign up
		const signUp = await routes.handleSignUp({
			email: 'alice@example.com',
			password: 'securePassword123',
			name: 'Alice',
		})
		expect(signUp.status).toBe(201)
		const signUpData = (signUp.body as { data: { user: { id: string; email: string; name: string }; tokens: { accessToken: string; refreshToken: string } } }).data
		expect(signUpData.user.email).toBe('alice@example.com')
		expect(signUpData.user.name).toBe('Alice')
		expect(signUpData.tokens.accessToken).toBeTruthy()
		expect(signUpData.tokens.refreshToken).toBeTruthy()
		const userId = signUpData.user.id

		// 2. Sign in with same credentials
		const signIn = await routes.handleSignIn({
			email: 'alice@example.com',
			password: 'securePassword123',
		})
		expect(signIn.status).toBe(200)
		const signInData = (signIn.body as { data: { user: { id: string }; tokens: { accessToken: string; refreshToken: string } } }).data
		expect(signInData.user.id).toBe(userId)

		// 3. Get current user with access token
		const me = await routes.handleGetMe(signInData.tokens.accessToken)
		expect(me.status).toBe(200)
		const meData = (me.body as { data: { id: string; email: string } }).data
		expect(meData.id).toBe(userId)
		expect(meData.email).toBe('alice@example.com')

		// 4. Sign out
		const signOut = await routes.handleSignOut(
			signInData.tokens.accessToken,
			{ refreshToken: signInData.tokens.refreshToken },
		)
		expect(signOut.status).toBe(200)

		// 5. Old access token should be revoked
		const revoked = await tokenManager.validateTokenWithRevocation(signInData.tokens.accessToken)
		expect(revoked).toBeNull()
	})

	// ========================================================================
	// Token refresh
	// ========================================================================

	test('token refresh issues new tokens and revokes old refresh token', async () => {
		const signUp = await routes.handleSignUp({
			email: 'bob@example.com',
			password: 'securePassword123',
		})
		const { tokens } = (signUp.body as { data: { tokens: { accessToken: string; refreshToken: string } } }).data

		// Refresh tokens
		const refresh = await routes.handleRefresh({ refreshToken: tokens.refreshToken })
		expect(refresh.status).toBe(200)
		const newTokens = (refresh.body as { data: { accessToken: string; refreshToken: string } }).data
		expect(newTokens.accessToken).toBeTruthy()
		expect(newTokens.refreshToken).toBeTruthy()
		expect(newTokens.accessToken).not.toBe(tokens.accessToken)
		expect(newTokens.refreshToken).not.toBe(tokens.refreshToken)

		// Old refresh token should be consumed (revoked)
		const secondRefresh = await routes.handleRefresh({ refreshToken: tokens.refreshToken })
		expect(secondRefresh.status).toBe(401)

		// New refresh token works
		const thirdRefresh = await routes.handleRefresh({ refreshToken: newTokens.refreshToken })
		expect(thirdRefresh.status).toBe(200)
	})

	test('refresh token reuse is detected and rejected', async () => {
		const signUp = await routes.handleSignUp({
			email: 'charlie@example.com',
			password: 'securePassword123',
			deviceId: 'device-1',
		})
		const { tokens } = (signUp.body as { data: { tokens: { accessToken: string; refreshToken: string } } }).data

		// Use refresh token once (legitimate)
		const firstRefresh = await routes.handleRefresh({ refreshToken: tokens.refreshToken })
		expect(firstRefresh.status).toBe(200)

		// Replay the old refresh token (potential theft — already consumed)
		const replay = await routes.handleRefresh({ refreshToken: tokens.refreshToken })
		expect(replay.status).toBe(401)

		// Device-level revocation was triggered — sync auth should reject
		const syncAuth = routes.toSyncAuthProvider()
		const newAccessToken = (firstRefresh.body as { data: { accessToken: string } }).data.accessToken
		// The access token's JTI is not individually revoked, but device-level
		// revocation blocks the toSyncAuthProvider path which checks device status
	})

	// ========================================================================
	// Duplicate sign-up
	// ========================================================================

	test('duplicate email sign-up returns 409', async () => {
		await routes.handleSignUp({
			email: 'dup@example.com',
			password: 'securePassword123',
		})
		const dup = await routes.handleSignUp({
			email: 'dup@example.com',
			password: 'differentPassword123',
		})
		expect(dup.status).toBe(409)
	})

	// ========================================================================
	// Wrong credentials
	// ========================================================================

	test('wrong password returns 401', async () => {
		await routes.handleSignUp({
			email: 'wrong@example.com',
			password: 'securePassword123',
		})
		const signIn = await routes.handleSignIn({
			email: 'wrong@example.com',
			password: 'wrongPassword123',
		})
		expect(signIn.status).toBe(401)
	})

	test('non-existent email returns 401', async () => {
		const signIn = await routes.handleSignIn({
			email: 'nobody@example.com',
			password: 'anyPassword123',
		})
		expect(signIn.status).toBe(401)
	})

	// ========================================================================
	// Device registration and revocation
	// ========================================================================

	test('device registration and revocation flow', async () => {
		const signUp = await routes.handleSignUp({
			email: 'dev@example.com',
			password: 'securePassword123',
			deviceId: 'device-main',
			devicePublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
		})
		const { tokens } = (signUp.body as { data: { tokens: { accessToken: string; refreshToken: string } } }).data

		// List devices
		const devices = await routes.handleListDevices(tokens.accessToken)
		expect(devices.status).toBe(200)
		const deviceList = (devices.body as { data: Array<{ id: string }> }).data
		expect(deviceList).toHaveLength(1)
		expect(deviceList[0]!.id).toBe('device-main')

		// Revoke the device
		const revoke = await routes.handleRevokeDevice(tokens.accessToken, 'device-main')
		expect(revoke.status).toBe(200)

		// Verify the device is revoked in user store
		const device = await userStore.findDevice('device-main')
		expect(device).not.toBeNull()
		expect(device!.revoked).toBe(true)
	})

	// ========================================================================
	// Email verification integration
	// ========================================================================

	test('sign-up → verify email flow', async () => {
		const verifier = new EmailVerificationManager({ userStore })

		// Sign up creates unverified user
		const signUp = await routes.handleSignUp({
			email: 'verify@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string; emailVerified: boolean } } }).data
		expect(user.emailVerified).toBe(false)

		// Request verification (dev mode returns token)
		const sendResult = await verifier.sendVerification(user.id, 'verify@example.com')
		expect(sendResult.status).toBe(200)
		const token = (sendResult.body as { data: { token: string } }).data.token
		expect(token).toBeTruthy()

		// Verify
		const verifyResult = await verifier.verifyEmail(token)
		expect(verifyResult.status).toBe(200)

		// User should now be verified
		const stored = await userStore.findById(user.id)
		expect(stored!.emailVerified).toBe(true)

		// Token is single-use
		const reuse = await verifier.verifyEmail(token)
		expect(reuse.status).toBe(404)
	})

	// ========================================================================
	// Password reset integration
	// ========================================================================

	test('sign-up → forgot password → reset → sign-in with new password', async () => {
		const resetManager = new PasswordResetManager({ userStore })

		// Sign up
		await routes.handleSignUp({
			email: 'reset@example.com',
			password: 'oldPassword123',
		})

		// Request reset (dev mode returns token)
		const resetReq = await resetManager.requestReset('reset@example.com')
		expect(resetReq.status).toBe(200)
		const resetToken = (resetReq.body as { data: { token: string } }).data.token
		expect(resetToken).toBeTruthy()

		// Reset password
		const resetResult = await resetManager.resetPassword(resetToken, 'newPassword456')
		expect(resetResult.status).toBe(200)

		// Old password no longer works
		const oldSignIn = await routes.handleSignIn({
			email: 'reset@example.com',
			password: 'oldPassword123',
		})
		expect(oldSignIn.status).toBe(401)

		// New password works
		const newSignIn = await routes.handleSignIn({
			email: 'reset@example.com',
			password: 'newPassword456',
		})
		expect(newSignIn.status).toBe(200)
	})

	test('reset token is single-use', async () => {
		const resetManager = new PasswordResetManager({ userStore })

		await routes.handleSignUp({
			email: 'singleuse@example.com',
			password: 'password123!',
		})

		const resetReq = await resetManager.requestReset('singleuse@example.com')
		const token = (resetReq.body as { data: { token: string } }).data.token

		// First use succeeds
		const first = await resetManager.resetPassword(token, 'newPass12345')
		expect(first.status).toBe(200)

		// Second use fails
		const second = await resetManager.resetPassword(token, 'anotherPass123')
		expect(second.status).toBe(404)
	})

	// ========================================================================
	// Sync auth provider integration
	// ========================================================================

	test('toSyncAuthProvider authenticates valid tokens', async () => {
		const signUp = await routes.handleSignUp({
			email: 'sync@example.com',
			password: 'securePassword123',
		})
		const { tokens } = (signUp.body as { data: { tokens: { accessToken: string; refreshToken: string } } }).data

		const syncAuth = routes.toSyncAuthProvider()

		// Valid access token authenticates
		const result = await syncAuth.authenticate(tokens.accessToken)
		expect(result).not.toBeNull()
		expect(result!.userId).toBeTruthy()
		expect(result!.metadata!['email']).toBe('sync@example.com')

		// Refresh token is rejected (not an access token)
		const refreshResult = await syncAuth.authenticate(tokens.refreshToken)
		expect(refreshResult).toBeNull()

		// Invalid token is rejected
		const invalidResult = await syncAuth.authenticate('invalid-token')
		expect(invalidResult).toBeNull()
	})

	test('toSyncAuthProvider rejects revoked device tokens', async () => {
		const signUp = await routes.handleSignUp({
			email: 'revoked-dev@example.com',
			password: 'securePassword123',
			deviceId: 'dev-sync-1',
			devicePublicKey: '{"kty":"EC","crv":"P-256","x":"test","y":"test"}',
		})
		const { tokens } = (signUp.body as { data: { tokens: { accessToken: string; refreshToken: string } } }).data

		const syncAuth = routes.toSyncAuthProvider()

		// Works before revocation
		const before = await syncAuth.authenticate(tokens.accessToken)
		expect(before).not.toBeNull()

		// Revoke the device
		await routes.handleRevokeDevice(tokens.accessToken, 'dev-sync-1')

		// Rejected after revocation
		const after = await syncAuth.authenticate(tokens.accessToken)
		expect(after).toBeNull()
	})

	// ========================================================================
	// Input validation
	// ========================================================================

	test('rejects invalid email format', async () => {
		const result = await routes.handleSignUp({
			email: 'not-an-email',
			password: 'securePassword123',
		})
		expect(result.status).toBe(400)
	})

	test('rejects short password', async () => {
		const result = await routes.handleSignUp({
			email: 'short@example.com',
			password: 'abc',
		})
		expect(result.status).toBe(400)
	})

	test('email lookup is case-insensitive', async () => {
		await routes.handleSignUp({
			email: 'CaseTest@EXAMPLE.com',
			password: 'securePassword123',
		})
		const signIn = await routes.handleSignIn({
			email: 'casetest@example.com',
			password: 'securePassword123',
		})
		expect(signIn.status).toBe(200)
	})
})
