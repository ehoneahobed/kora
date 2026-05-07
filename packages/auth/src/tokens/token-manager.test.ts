import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenManager } from './token-manager'

const TEST_SECRET = 'test-secret-key-for-unit-tests'
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

	describe('issueAccessToken', () => {
		it('issues a valid access token that can be validated', () => {
			const token = manager.issueAccessToken(USER_ID, DEVICE_ID)

			expect(typeof token).toBe('string')
			expect(token.split('.')).toHaveLength(3)

			const payload = manager.validateToken(token)
			expect(payload).not.toBeNull()
			expect(payload?.sub).toBe(USER_ID)
			expect(payload?.dev).toBe(DEVICE_ID)
			expect(payload?.type).toBe('access')
			expect(payload?.iat).toBe(Math.floor(Date.now() / 1000))
			// Default lifetime: 15 minutes = 900 seconds
			expect(payload?.exp).toBe(payload!.iat + 900)
		})
	})

	describe('issueRefreshToken', () => {
		it('issues a valid refresh token that can be validated', () => {
			const token = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			expect(typeof token).toBe('string')

			const payload = manager.validateToken(token)
			expect(payload).not.toBeNull()
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
			const otherManager = new TokenManager({ secret: 'different-secret' })
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

	describe('refreshAccessToken', () => {
		it('issues new access and refresh tokens from a valid refresh token', () => {
			const originalRefresh = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			// Advance time a bit so new tokens have different iat
			vi.advanceTimersByTime(5000)

			const result = manager.refreshAccessToken(originalRefresh)
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

		it('rejects an expired refresh token', () => {
			const token = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			// Advance time past the 90-day refresh token lifetime
			vi.advanceTimersByTime(91 * 24 * 60 * 60 * 1000)

			const result = manager.refreshAccessToken(token)
			expect(result).toBeNull()
		})

		it('rejects an access token (wrong type)', () => {
			const accessToken = manager.issueAccessToken(USER_ID, DEVICE_ID)

			const result = manager.refreshAccessToken(accessToken)
			expect(result).toBeNull()
		})

		it('rejects a device credential (wrong type)', () => {
			const credential = manager.issueDeviceCredential(USER_ID, DEVICE_ID, PUBLIC_KEY_THUMBPRINT)

			const result = manager.refreshAccessToken(credential)
			expect(result).toBeNull()
		})

		it('implements token rotation (new refresh token differs from old)', () => {
			const originalRefresh = manager.issueRefreshToken(USER_ID, DEVICE_ID)

			// Advance time so new tokens have different iat
			vi.advanceTimersByTime(1000)

			const result = manager.refreshAccessToken(originalRefresh)
			expect(result).not.toBeNull()
			expect(result!.refreshToken).not.toBe(originalRefresh)
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
