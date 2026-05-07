import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenManager, InMemoryTokenRevocationStore } from './token-manager'

// Must be at least 32 characters (256 bits) for HMAC-SHA256 security
const TEST_SECRET = 'kora-test-secret-for-unit-tests-minimum-32-chars'
const USER_ID = 'user-abc-123'
const DEVICE_ID = 'device-xyz-789'
const PUBLIC_KEY_THUMBPRINT = 'sha256-thumbprint-of-device-public-key'

describe('TokenManager', () => {
	let manager: TokenManager

	beforeEach(() => {
		// Fix time so token expiration is deterministic
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))

		manager = new TokenManager({ secret: TEST_SECRET })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('constructor', () => {
		it('rejects secrets shorter than 32 characters', () => {
			expect(() => new TokenManager({ secret: 'too-short' })).toThrow(
				/must be at least 32 characters/,
			)
		})

		it('rejects empty secrets', () => {
			expect(() => new TokenManager({ secret: '' })).toThrow(
				/must be at least 32 characters/,
			)
		})

		it('rejects empty secret arrays', () => {
			expect(() => new TokenManager({ secret: [] })).toThrow(
				/requires at least one secret/,
			)
		})

		it('accepts a valid secret string', () => {
			expect(() => new TokenManager({ secret: TEST_SECRET })).not.toThrow()
		})

		it('accepts an array of valid secrets for key rotation', () => {
			const secrets = [TEST_SECRET, 'another-valid-secret-at-least-32-chars-long']
			expect(() => new TokenManager({ secret: secrets })).not.toThrow()
		})
	})

	describe('generateSecret', () => {
		it('generates a 64-character hex string', () => {
			const secret = TokenManager.generateSecret()
			expect(secret).toHaveLength(64)
			expect(/^[0-9a-f]{64}$/.test(secret)).toBe(true)
		})

		it('generates unique secrets on each call', () => {
			const a = TokenManager.generateSecret()
			const b = TokenManager.generateSecret()
			expect(a).not.toBe(b)
		})
	})

	describe('issueAccessToken', () => {
		it('issues a valid access token that can be validated', () => {
			const token = manager.issueAccessToken(USER_ID, DEVICE_ID)

			expect(typeof token).toBe('string')
			expect(token.split('.')).toHaveLength(3)

			const payload = manager.validateToken(token)
			expect(payload).not.toBeNull()
			expect(payload?.jti).toBeDefined()
			expect(typeof payload?.jti).toBe('string')
			expect(payload?.sub).toBe(USER_ID)
			expect(payload?.dev).toBe(DEVICE_ID)
			expect(payload?.type).toBe('access')
			expect(payload?.iat).toBe(Math.floor(Date.now() / 1000))
			// Default lifetime: 15 minutes = 900 seconds
			expect(payload?.exp).toBe(payload!.iat + 900)
		})

		it('generates unique jti for each token', () => {
			const token1 = manager.issueAccessToken(USER_ID, DEVICE_ID)
			const token2 = manager.issueAccessToken(USER_ID, DEVICE_ID)
			const payload1 = manager.validateToken(token1)
			const payload2 = manager.validateToken(token2)
			expect(payload1?.jti).not.toBe(payload2?.jti)
		})
	})

	describe('issueRefreshToken', () => {
		it('issues a valid refresh token that can be validated', () => {
			const token = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			expect(typeof token).toBe('string')

			const payload = manager.validateToken(token)
			expect(payload).not.toBeNull()
			expect(payload?.jti).toBeDefined()
			expect(payload?.sub).toBe(USER_ID)
			expect(payload?.dev).toBe(DEVICE_ID)
			expect(payload?.type).toBe('refresh')
			expect(payload?.iat).toBe(Math.floor(Date.now() / 1000))
			// Default lifetime: 90 days = 7_776_000 seconds
			expect(payload?.exp).toBe(payload!.iat + 90 * 24 * 60 * 60)
		})
	})

	describe('issueDeviceCredential', () => {
		it('issues a device credential with thumbprint and mustCheckinBy', () => {
			const token = manager.issueDeviceCredential(USER_ID, DEVICE_ID, PUBLIC_KEY_THUMBPRINT)

			expect(typeof token).toBe('string')

			const payload = manager.validateToken(token)
			expect(payload).not.toBeNull()
			expect(payload?.jti).toBeDefined()
			expect(payload?.sub).toBe(USER_ID)
			expect(payload?.dev).toBe(DEVICE_ID)
			expect(payload?.type).toBe('device_credential')
		})
	})

	describe('issueTokens', () => {
		it('issues access and refresh tokens when no thumbprint is provided', () => {
			const tokens = manager.issueTokens(USER_ID, DEVICE_ID)

			expect(tokens.accessToken).toBeDefined()
			expect(tokens.refreshToken).toBeDefined()
			expect(tokens.deviceCredential).toBeUndefined()

			const accessPayload = manager.validateToken(tokens.accessToken)
			expect(accessPayload?.type).toBe('access')

			const refreshPayload = manager.validateToken(tokens.refreshToken)
			expect(refreshPayload?.type).toBe('refresh')
		})

		it('includes device credential when thumbprint is provided', () => {
			const tokens = manager.issueTokens(USER_ID, DEVICE_ID, PUBLIC_KEY_THUMBPRINT)

			expect(tokens.accessToken).toBeDefined()
			expect(tokens.refreshToken).toBeDefined()
			expect(tokens.deviceCredential).toBeDefined()

			const credPayload = manager.validateToken(tokens.deviceCredential!)
			expect(credPayload?.type).toBe('device_credential')
		})
	})

	describe('validateToken', () => {
		it('rejects expired tokens', () => {
			const token = manager.issueAccessToken(USER_ID, DEVICE_ID)

			// Advance time past the 15-minute access token lifetime
			vi.advanceTimersByTime(16 * 60 * 1000)

			const payload = manager.validateToken(token)
			expect(payload).toBeNull()
		})

		it('rejects tokens signed with a different secret', () => {
			const otherSecret = 'different-secret-also-at-least-32-characters'
			const otherManager = new TokenManager({ secret: otherSecret })
			const token = otherManager.issueAccessToken(USER_ID, DEVICE_ID)

			// Validate with the original manager (different secret)
			const payload = manager.validateToken(token)
			expect(payload).toBeNull()
		})

		it('rejects malformed token strings', () => {
			expect(manager.validateToken('not-a-jwt')).toBeNull()
			expect(manager.validateToken('')).toBeNull()
			expect(manager.validateToken('a.b')).toBeNull()
			expect(manager.validateToken('a.b.c.d')).toBeNull()
		})

		it('returns null for a token with missing claims', async () => {
			// Manually craft a token without the required 'dev' claim
			const { encodeJwt } = await import('./jwt')
			const badToken = encodeJwt({ sub: USER_ID, type: 'access', iat: 0, exp: 9999999999 }, TEST_SECRET)
			expect(manager.validateToken(badToken)).toBeNull()
		})
	})

	describe('key rotation', () => {
		it('validates tokens signed with any configured secret', () => {
			const oldSecret = 'old-secret-being-rotated-out-minimum-32-chars'
			const newSecret = 'new-secret-being-rotated-in-minimum-32-chars'

			// Manager with both secrets (new first for signing)
			const rotatingManager = new TokenManager({ secret: [newSecret, oldSecret] })

			// Old manager that signed with the old secret
			const oldManager = new TokenManager({ secret: oldSecret })
			const oldToken = oldManager.issueAccessToken(USER_ID, DEVICE_ID)

			// Rotating manager can validate old tokens
			expect(rotatingManager.validateToken(oldToken)).not.toBeNull()

			// New tokens are signed with the new secret
			const newToken = rotatingManager.issueAccessToken(USER_ID, DEVICE_ID)
			expect(rotatingManager.validateToken(newToken)).not.toBeNull()

			// Old manager cannot validate new tokens (different secret)
			expect(oldManager.validateToken(newToken)).toBeNull()
		})
	})

	describe('refreshAccessToken', () => {
		it('issues new access and refresh tokens from a valid refresh token', async () => {
			const originalRefresh = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			// Advance time a bit so new tokens have different iat
			vi.advanceTimersByTime(5000)

			const result = await manager.refreshAccessToken(originalRefresh)
			expect(result).not.toBeNull()

			const accessPayload = manager.validateToken(result!.accessToken)
			expect(accessPayload?.type).toBe('access')
			expect(accessPayload?.sub).toBe(USER_ID)
			expect(accessPayload?.dev).toBe(DEVICE_ID)

			const refreshPayload = manager.validateToken(result!.refreshToken)
			expect(refreshPayload?.type).toBe('refresh')
			expect(refreshPayload?.sub).toBe(USER_ID)
			expect(refreshPayload?.dev).toBe(DEVICE_ID)
		})

		it('rejects an expired refresh token', async () => {
			const token = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			// Advance time past the 90-day refresh token lifetime
			vi.advanceTimersByTime(91 * 24 * 60 * 60 * 1000)

			const result = await manager.refreshAccessToken(token)
			expect(result).toBeNull()
		})

		it('rejects an access token (wrong type)', async () => {
			const accessToken = manager.issueAccessToken(USER_ID, DEVICE_ID)

			const result = await manager.refreshAccessToken(accessToken)
			expect(result).toBeNull()
		})

		it('rejects a device credential (wrong type)', async () => {
			const credential = manager.issueDeviceCredential(USER_ID, DEVICE_ID, PUBLIC_KEY_THUMBPRINT)

			const result = await manager.refreshAccessToken(credential)
			expect(result).toBeNull()
		})

		it('implements token rotation (new refresh token differs from old)', async () => {
			const originalRefresh = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			// Advance time so new tokens have different iat
			vi.advanceTimersByTime(1000)

			const result = await manager.refreshAccessToken(originalRefresh)
			expect(result).not.toBeNull()
			expect(result!.refreshToken).not.toBe(originalRefresh)
		})
	})

	describe('token revocation', () => {
		it('rejects revoked tokens via validateTokenWithRevocation', async () => {
			const store = new InMemoryTokenRevocationStore()
			const revokeManager = new TokenManager({
				secret: TEST_SECRET,
				revocationStore: store,
			})

			const token = revokeManager.issueAccessToken(USER_ID, DEVICE_ID)
			const payload = revokeManager.validateToken(token)!

			// Token is valid before revocation
			expect(await revokeManager.validateTokenWithRevocation(token)).not.toBeNull()

			// Revoke the token
			await revokeManager.revokeToken(payload.jti, payload.exp)

			// Token is rejected after revocation
			expect(await revokeManager.validateTokenWithRevocation(token)).toBeNull()
		})

		it('detects refresh token reuse and revokes all device tokens', async () => {
			const store = new InMemoryTokenRevocationStore()
			const revokeManager = new TokenManager({
				secret: TEST_SECRET,
				revocationStore: store,
			})

			const refresh = revokeManager.issueRefreshToken(USER_ID, DEVICE_ID)

			// First use: succeeds and consumes the token
			vi.advanceTimersByTime(1000)
			const result1 = await revokeManager.refreshAccessToken(refresh)
			expect(result1).not.toBeNull()

			// Second use (replay): detected as potential theft, returns null
			vi.advanceTimersByTime(1000)
			const result2 = await revokeManager.refreshAccessToken(refresh)
			expect(result2).toBeNull()
		})
	})

	describe('custom lifetimes', () => {
		it('respects custom access token lifetime', () => {
			const customManager = new TokenManager({
				secret: TEST_SECRET,
				accessTokenLifetime: 5 * 60 * 1000, // 5 minutes
			})

			const token = customManager.issueAccessToken(USER_ID, DEVICE_ID)
			const payload = customManager.validateToken(token)
			expect(payload).not.toBeNull()
			// 5 minutes = 300 seconds
			expect(payload!.exp - payload!.iat).toBe(300)

			// Token should still be valid at 4 minutes
			vi.advanceTimersByTime(4 * 60 * 1000)
			expect(customManager.validateToken(token)).not.toBeNull()

			// Token should be expired at 6 minutes
			vi.advanceTimersByTime(2 * 60 * 1000)
			expect(customManager.validateToken(token)).toBeNull()
		})

		it('respects custom refresh token lifetime', () => {
			const customManager = new TokenManager({
				secret: TEST_SECRET,
				refreshTokenLifetime: 7 * 24 * 60 * 60 * 1000, // 7 days
			})

			const token = customManager.issueRefreshToken(USER_ID, DEVICE_ID)
			const payload = customManager.validateToken(token)
			expect(payload).not.toBeNull()
			// 7 days = 604_800 seconds
			expect(payload!.exp - payload!.iat).toBe(604_800)
		})

		it('respects custom device credential lifetime', () => {
			const customManager = new TokenManager({
				secret: TEST_SECRET,
				deviceCredentialLifetime: 30 * 24 * 60 * 60 * 1000, // 30 days
			})

			const token = customManager.issueDeviceCredential(USER_ID, DEVICE_ID, PUBLIC_KEY_THUMBPRINT)
			const payload = customManager.validateToken(token)
			expect(payload).not.toBeNull()
			// 30 days = 2_592_000 seconds
			expect(payload!.exp - payload!.iat).toBe(2_592_000)
		})
	})
})
