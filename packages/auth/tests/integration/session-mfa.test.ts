/**
 * Integration tests for session management + TOTP MFA.
 *
 * Tests the flow: sign-in → session creation → MFA requirement →
 * TOTP verification → full access.
 */
import { describe, test, expect, beforeEach } from 'vitest'
import {
	BuiltInAuthRoutes,
	InMemoryUserStore,
	TokenManager,
	InMemoryTokenRevocationStore,
	SessionManager,
	InMemorySessionStore,
	TotpManager,
	InMemoryTotpStore,
	SessionMfaRequiredError,
} from '../../src/server'

describe('Session + MFA integration', () => {
	let userStore: InstanceType<typeof InMemoryUserStore>
	let tokenManager: InstanceType<typeof TokenManager>
	let routes: InstanceType<typeof BuiltInAuthRoutes>
	let sessionManager: InstanceType<typeof SessionManager>
	let totpManager: InstanceType<typeof TotpManager>

	beforeEach(() => {
		userStore = new InMemoryUserStore()
		tokenManager = new TokenManager({
			secret: TokenManager.generateSecret(),
			revocationStore: new InMemoryTokenRevocationStore(),
		})
		routes = new BuiltInAuthRoutes({ userStore, tokenManager })
		sessionManager = new SessionManager({
			store: new InMemorySessionStore(),
			maxSessionsPerUser: 3,
			idleTimeoutMs: 30 * 60 * 1000,
		})
		totpManager = new TotpManager({
			issuer: 'TestApp',
			store: new InMemoryTotpStore(),
		})
	})

	// ========================================================================
	// Session lifecycle
	// ========================================================================

	test('sign-in creates session, validate, touch, and revoke', async () => {
		// Sign up
		const signUp = await routes.handleSignUp({
			email: 'session@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		// Create session on sign-in
		const session = await sessionManager.create({
			userId: user.id,
			ipAddress: '192.168.1.1',
			userAgent: 'TestBrowser/1.0',
		})
		expect(session.userId).toBe(user.id)
		expect(session.ipAddress).toBe('192.168.1.1')
		expect(session.mfaVerified).toBe(false)

		// Validate returns the session
		const validated = await sessionManager.validate(session.id)
		expect(validated.id).toBe(session.id)

		// Touch extends the session
		const touched = await sessionManager.touch(session.id)
		expect(touched.lastActiveAt).toBeGreaterThanOrEqual(session.lastActiveAt)

		// List sessions
		const sessions = await sessionManager.listSessions(user.id)
		expect(sessions).toHaveLength(1)

		// Revoke session
		await sessionManager.revoke(session.id)
		await expect(sessionManager.validate(session.id)).rejects.toThrow()
	})

	test('max sessions limit is enforced', async () => {
		const signUp = await routes.handleSignUp({
			email: 'multi@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		// Create up to max (3)
		await sessionManager.create({ userId: user.id })
		await sessionManager.create({ userId: user.id })
		await sessionManager.create({ userId: user.id })

		// 4th should fail
		await expect(sessionManager.create({ userId: user.id })).rejects.toThrow('Maximum concurrent sessions')
	})

	test('sign-out everywhere revokes all sessions', async () => {
		const signUp = await routes.handleSignUp({
			email: 'everywhere@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		const session1 = await sessionManager.create({ userId: user.id })
		const session2 = await sessionManager.create({ userId: user.id })

		const revoked = await sessionManager.revokeAll(user.id)
		expect(revoked).toBe(2)

		await expect(sessionManager.validate(session1.id)).rejects.toThrow()
		await expect(sessionManager.validate(session2.id)).rejects.toThrow()
	})

	test('revoke others keeps current session', async () => {
		const signUp = await routes.handleSignUp({
			email: 'others@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		const current = await sessionManager.create({ userId: user.id })
		await sessionManager.create({ userId: user.id })
		await sessionManager.create({ userId: user.id })

		const revoked = await sessionManager.revokeOthers(user.id, current.id)
		expect(revoked).toBe(2)

		// Current session still valid
		const valid = await sessionManager.validate(current.id)
		expect(valid.id).toBe(current.id)

		// Only one session remains
		const remaining = await sessionManager.listSessions(user.id)
		expect(remaining).toHaveLength(1)
	})

	// ========================================================================
	// TOTP MFA flow
	// ========================================================================

	test('TOTP enable → verify setup → verify code → disable', async () => {
		const signUp = await routes.handleSignUp({
			email: 'mfa@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		// 1. Enable TOTP (get QR code URI)
		const setup = await totpManager.enable(user.id, 'mfa@example.com')
		expect(setup.secret).toBeTruthy()
		expect(setup.uri).toContain('otpauth://totp/')
		expect(setup.uri).toContain('TestApp')
		expect(setup.recoveryCodes).toHaveLength(8)

		// 2. MFA is not yet active (not verified)
		expect(await totpManager.isEnabled(user.id)).toBe(false)

		// 3. Verify setup with a code generated from the secret
		const code = generateTotpCode(setup.secret)
		await totpManager.verifySetup(user.id, code)

		// 4. MFA is now active
		expect(await totpManager.isEnabled(user.id)).toBe(true)

		// 5. Disable MFA (requires a valid code)
		const disableCode = generateTotpCode(setup.secret)
		await totpManager.disable(user.id, disableCode)
		expect(await totpManager.isEnabled(user.id)).toBe(false)
	})

	test('session MFA requirement blocks until verified', async () => {
		const signUp = await routes.handleSignUp({
			email: 'mfa-session@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		// Enable and verify TOTP
		const setup = await totpManager.enable(user.id, 'mfa-session@example.com')
		const code = generateTotpCode(setup.secret)
		await totpManager.verifySetup(user.id, code)

		// Create session without MFA verification
		const session = await sessionManager.create({
			userId: user.id,
			mfaVerified: false,
		})

		// requireMfa should throw
		await expect(sessionManager.requireMfa(session.id)).rejects.toThrow(SessionMfaRequiredError)

		// Verify TOTP code
		const loginCode = generateTotpCode(setup.secret)
		const verified = await totpManager.verify(user.id, loginCode)
		expect(verified).toBe(true)

		// Mark session as MFA-verified
		const updated = await sessionManager.markMfaVerified(session.id)
		expect(updated.mfaVerified).toBe(true)

		// requireMfa should now succeed
		const mfaSession = await sessionManager.requireMfa(session.id)
		expect(mfaSession.mfaVerified).toBe(true)
	})

	test('recovery codes work when authenticator is unavailable', async () => {
		const signUp = await routes.handleSignUp({
			email: 'recovery@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		// Enable and verify TOTP
		const setup = await totpManager.enable(user.id, 'recovery@example.com')
		const code = generateTotpCode(setup.secret)
		await totpManager.verifySetup(user.id, code)

		// Use a recovery code
		const recoveryCode = setup.recoveryCodes[0]!
		const used = await totpManager.verifyRecoveryCode(user.id, recoveryCode)
		expect(used).toBe(true)

		// Same recovery code cannot be used again (single-use)
		const reuse = await totpManager.verifyRecoveryCode(user.id, recoveryCode)
		expect(reuse).toBe(false)

		// Check remaining count decreased
		const remaining = await totpManager.remainingRecoveryCodes(user.id)
		expect(remaining).toBe(7)
	})

	test('TOTP cannot be enabled twice', async () => {
		const signUp = await routes.handleSignUp({
			email: 'double-mfa@example.com',
			password: 'securePassword123',
		})
		const { user } = (signUp.body as { data: { user: { id: string } } }).data

		const setup = await totpManager.enable(user.id, 'double-mfa@example.com')
		const code = generateTotpCode(setup.secret)
		await totpManager.verifySetup(user.id, code)

		// Second enable should throw
		await expect(totpManager.enable(user.id, 'double-mfa@example.com')).rejects.toThrow('already enabled')
	})
})

// ============================================================================
// TOTP code generation helper (for testing)
// ============================================================================

/**
 * Generate a valid TOTP code from a base32-encoded secret.
 * Uses the same SHA-1 HMAC algorithm as authenticator apps.
 */
function generateTotpCode(base32Secret: string): string {
	const secret = base32Decode(base32Secret)
	const counter = Math.floor(Date.now() / 1000 / 30)

	// Counter as 8-byte big-endian
	const counterBytes = new Uint8Array(8)
	let temp = counter
	for (let i = 7; i >= 0; i--) {
		counterBytes[i] = temp & 0xff
		temp = Math.floor(temp / 256)
	}

	const hmac = hmacSha1(secret, counterBytes)
	const offset = hmac[19]! & 0x0f
	const code =
		(((hmac[offset]! & 0x7f) << 24) |
			((hmac[offset + 1]! & 0xff) << 16) |
			((hmac[offset + 2]! & 0xff) << 8) |
			(hmac[offset + 3]! & 0xff)) %
		1000000

	return String(code).padStart(6, '0')
}

function base32Decode(input: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
	const cleaned = input.replace(/=+$/, '').toUpperCase()
	const output: number[] = []
	let buffer = 0
	let bits = 0
	for (const char of cleaned) {
		const val = alphabet.indexOf(char)
		if (val === -1) continue
		buffer = (buffer << 5) | val
		bits += 5
		if (bits >= 8) {
			bits -= 8
			output.push((buffer >> bits) & 0xff)
		}
	}
	return new Uint8Array(output)
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
	const blockSize = 64
	let k = key
	if (k.length > blockSize) k = sha1(k)
	const paddedKey = new Uint8Array(blockSize)
	paddedKey.set(k)

	const ipad = new Uint8Array(blockSize)
	const opad = new Uint8Array(blockSize)
	for (let i = 0; i < blockSize; i++) {
		ipad[i] = paddedKey[i]! ^ 0x36
		opad[i] = paddedKey[i]! ^ 0x5c
	}

	const inner = new Uint8Array(blockSize + message.length)
	inner.set(ipad)
	inner.set(message, blockSize)
	const innerHash = sha1(inner)

	const outer = new Uint8Array(blockSize + 20)
	outer.set(opad)
	outer.set(innerHash, blockSize)
	return sha1(outer)
}

function sha1(data: Uint8Array): Uint8Array {
	let h0 = 0x67452301
	let h1 = 0xefcdab89
	let h2 = 0x98badcfe
	let h3 = 0x10325476
	let h4 = 0xc3d2e1f0

	const bitLength = data.length * 8
	const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64)
	padded.set(data)
	padded[data.length] = 0x80
	const view = new DataView(padded.buffer)
	view.setUint32(padded.length - 4, bitLength, false)

	for (let offset = 0; offset < padded.length; offset += 64) {
		const w = new Uint32Array(80)
		for (let i = 0; i < 16; i++) {
			w[i] = view.getUint32(offset + i * 4, false)
		}
		for (let i = 16; i < 80; i++) {
			w[i] = rotateLeft((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) >>> 0, 1)
		}

		let a = h0, b = h1, c = h2, d = h3, e = h4
		for (let i = 0; i < 80; i++) {
			let f: number, k: number
			if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
			else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
			else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
			else { f = b ^ c ^ d; k = 0xca62c1d6 }

			const temp = (rotateLeft(a >>> 0, 5) + (f >>> 0) + (e >>> 0) + (k >>> 0) + (w[i]! >>> 0)) >>> 0
			e = d; d = c; c = rotateLeft(b >>> 0, 30); b = a; a = temp
		}

		h0 = (h0 + a) >>> 0
		h1 = (h1 + b) >>> 0
		h2 = (h2 + c) >>> 0
		h3 = (h3 + d) >>> 0
		h4 = (h4 + e) >>> 0
	}

	const result = new Uint8Array(20)
	const rv = new DataView(result.buffer)
	rv.setUint32(0, h0, false)
	rv.setUint32(4, h1, false)
	rv.setUint32(8, h2, false)
	rv.setUint32(12, h3, false)
	rv.setUint32(16, h4, false)
	return result
}

function rotateLeft(n: number, s: number): number {
	return ((n << s) | (n >>> (32 - s))) >>> 0
}
