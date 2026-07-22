import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { base64urlDecode, base64urlEncode, decodeJwt, encodeJwt, isExpired, verifyJwt } from './jwt'

const TEST_SECRET = 'kora-test-secret-do-not-use-in-production'

describe('base64url helpers', () => {
	test('base64urlEncode produces URL-safe output without padding', () => {
		const encoded = base64urlEncode('hello world')
		expect(encoded).not.toContain('+')
		expect(encoded).not.toContain('/')
		expect(encoded).not.toContain('=')
	})

	test('base64urlDecode reverses base64urlEncode', () => {
		const original = '{"sub":"user-123","type":"access"}'
		const encoded = base64urlEncode(original)
		const decoded = base64urlDecode(encoded)
		expect(decoded).toBe(original)
	})

	test('roundtrips special characters', () => {
		const original = 'emoji: \u00e9\u00e8\u00ea and symbols: +/='
		const roundtripped = base64urlDecode(base64urlEncode(original))
		expect(roundtripped).toBe(original)
	})

	test('roundtrips empty string', () => {
		const roundtripped = base64urlDecode(base64urlEncode(''))
		expect(roundtripped).toBe('')
	})
})

describe('encodeJwt', () => {
	test('produces a three-part dot-separated string', () => {
		const token = encodeJwt({ sub: 'user-1' }, TEST_SECRET)
		const parts = token.split('.')
		expect(parts).toHaveLength(3)
	})

	test('header decodes to HS256 JWT', () => {
		const token = encodeJwt({ sub: 'user-1' }, TEST_SECRET)
		const headerPart = token.split('.')[0]
		expect(headerPart).toBeDefined()
		const header = JSON.parse(base64urlDecode(headerPart as string))
		expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })
	})

	test('payload contains all provided claims', () => {
		const claims = {
			sub: 'user-123',
			dev: 'device-456',
			type: 'access',
			iat: 1000,
			exp: 2000,
			custom: 'value',
		}
		const token = encodeJwt(claims, TEST_SECRET)
		const payloadPart = token.split('.')[1]
		expect(payloadPart).toBeDefined()
		const payload = JSON.parse(base64urlDecode(payloadPart as string))
		expect(payload).toEqual(claims)
	})

	test('different secrets produce different signatures', () => {
		const payload = { sub: 'user-1' }
		const tokenA = encodeJwt(payload, 'secret-a')
		const tokenB = encodeJwt(payload, 'secret-b')

		const sigA = tokenA.split('.')[2]
		const sigB = tokenB.split('.')[2]
		expect(sigA).not.toBe(sigB)
	})

	test('identical inputs produce identical tokens (deterministic)', () => {
		const payload = { sub: 'user-1', iat: 1000 }
		const tokenA = encodeJwt(payload, TEST_SECRET)
		const tokenB = encodeJwt(payload, TEST_SECRET)
		expect(tokenA).toBe(tokenB)
	})
})

describe('decodeJwt', () => {
	test('decodes a valid token payload', () => {
		const original = { sub: 'user-123', dev: 'device-1', type: 'access', iat: 100, exp: 200 }
		const token = encodeJwt(original, TEST_SECRET)
		const decoded = decodeJwt(token)
		expect(decoded).toEqual(original)
	})

	test('decodes without verifying signature (reads tampered tokens)', () => {
		const token = encodeJwt({ sub: 'user-1' }, TEST_SECRET)
		// Tamper with the signature
		const tampered = `${token.slice(0, -4)}XXXX`
		const decoded = decodeJwt(tampered)
		// decodeJwt should still return the payload
		expect(decoded).not.toBeNull()
		expect(decoded?.sub).toBe('user-1')
	})

	test('returns null for empty string', () => {
		expect(decodeJwt('')).toBeNull()
	})

	test('returns null for string with wrong number of parts', () => {
		expect(decodeJwt('one.two')).toBeNull()
		expect(decodeJwt('one.two.three.four')).toBeNull()
		expect(decodeJwt('single')).toBeNull()
	})

	test('returns null for non-JSON payload', () => {
		const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
		const invalidPayload = base64urlEncode('not-json')
		const token = `${header}.${invalidPayload}.fakesig`
		expect(decodeJwt(token)).toBeNull()
	})

	test('returns null when payload is a JSON array', () => {
		const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
		const arrayPayload = base64urlEncode(JSON.stringify([1, 2, 3]))
		const token = `${header}.${arrayPayload}.fakesig`
		expect(decodeJwt(token)).toBeNull()
	})

	test('returns null when payload is a JSON primitive', () => {
		const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
		const primitivePayload = base64urlEncode(JSON.stringify(42))
		const token = `${header}.${primitivePayload}.fakesig`
		expect(decodeJwt(token)).toBeNull()
	})
})

describe('verifyJwt', () => {
	test('returns payload for a valid token signed with the correct secret', () => {
		const original = { sub: 'user-abc', dev: 'dev-1', type: 'refresh', iat: 1000, exp: 9999999999 }
		const token = encodeJwt(original, TEST_SECRET)
		const result = verifyJwt(token, TEST_SECRET)
		expect(result).toEqual(original)
	})

	test('returns null when signature is tampered', () => {
		const token = encodeJwt({ sub: 'user-1' }, TEST_SECRET)
		// Flip the last character of the signature
		const parts = token.split('.')
		const sig = parts[2] as string
		const lastChar = sig[sig.length - 1]
		const flipped = lastChar === 'A' ? 'B' : 'A'
		const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${flipped}`
		expect(verifyJwt(tampered, TEST_SECRET)).toBeNull()
	})

	test('returns null when payload is tampered', () => {
		const token = encodeJwt({ sub: 'user-1', role: 'viewer' }, TEST_SECRET)
		const parts = token.split('.')
		// Replace payload with a different one (privilege escalation attempt)
		const evilPayload = base64urlEncode(JSON.stringify({ sub: 'user-1', role: 'admin' }))
		const tampered = `${parts[0]}.${evilPayload}.${parts[2]}`
		expect(verifyJwt(tampered, TEST_SECRET)).toBeNull()
	})

	test('returns null when verified with wrong secret', () => {
		const token = encodeJwt({ sub: 'user-1' }, 'correct-secret')
		expect(verifyJwt(token, 'wrong-secret')).toBeNull()
	})

	test('returns null for empty string', () => {
		expect(verifyJwt('', TEST_SECRET)).toBeNull()
	})

	// Regression: handleRefresh/handleSignOut/handleDeviceRegister/
	// handleDeviceVerify all pass a token straight from a request body/header
	// through to verifyJwt(). That's untyped network input, so a missing
	// field reaches here as `undefined` despite the `string` type; `.split`
	// used to throw instead of this returning null like any other malformed
	// token.
	test('returns null instead of throwing for undefined token', () => {
		expect(verifyJwt(undefined as unknown as string, TEST_SECRET)).toBeNull()
	})

	test('returns null for malformed token with too few parts', () => {
		expect(verifyJwt('header.payload', TEST_SECRET)).toBeNull()
	})

	test('returns null for malformed token with too many parts', () => {
		expect(verifyJwt('a.b.c.d', TEST_SECRET)).toBeNull()
	})

	test('does not check expiration (that is isExpired responsibility)', () => {
		// Create a token that expired 1 hour ago
		const pastExp = Math.floor(Date.now() / 1000) - 3600
		const token = encodeJwt({ sub: 'user-1', exp: pastExp }, TEST_SECRET)
		// verifyJwt should still return the payload since it only checks signature
		const result = verifyJwt(token, TEST_SECRET)
		expect(result).not.toBeNull()
		expect(result?.sub).toBe('user-1')
		expect(result?.exp).toBe(pastExp)
	})

	test('returns payload when token has no exp claim', () => {
		const token = encodeJwt({ sub: 'user-1', data: 'no-expiry' }, TEST_SECRET)
		const result = verifyJwt(token, TEST_SECRET)
		expect(result).toEqual({ sub: 'user-1', data: 'no-expiry' })
	})
})

describe('isExpired', () => {
	beforeEach(() => {
		// Fix Date.now to a known value for deterministic tests
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test('returns true when exp is in the past (beyond clock skew tolerance)', () => {
		const nowSeconds = Math.floor(Date.now() / 1000)
		// isExpired includes a 5-second clock skew tolerance, so tokens expired
		// within the tolerance window are not yet considered expired.
		expect(isExpired({ exp: nowSeconds - 6 })).toBe(true)
		expect(isExpired({ exp: nowSeconds - 3600 })).toBe(true)
	})

	test('returns false within clock skew tolerance window', () => {
		const nowSeconds = Math.floor(Date.now() / 1000)
		// Tokens that expired 0-4 seconds ago are within the 5-second tolerance
		expect(isExpired({ exp: nowSeconds })).toBe(false)
		expect(isExpired({ exp: nowSeconds - 4 })).toBe(false)
	})

	test('returns false when exp is in the future', () => {
		const nowSeconds = Math.floor(Date.now() / 1000)
		expect(isExpired({ exp: nowSeconds + 1 })).toBe(false)
		expect(isExpired({ exp: nowSeconds + 3600 })).toBe(false)
	})

	test('returns false when exp is missing', () => {
		expect(isExpired({})).toBe(false)
	})

	test('returns false when exp is undefined', () => {
		expect(isExpired({ exp: undefined })).toBe(false)
	})

	test('returns false when exp is not a number', () => {
		// The type signature allows number | undefined, but runtime could see anything
		// from decoded JSON. isExpired must handle this gracefully.
		expect(isExpired({ exp: 'not-a-number' as unknown as number })).toBe(false)
	})
})

describe('roundtrip with all token types', () => {
	test('access token roundtrip', () => {
		const payload = {
			sub: 'user-001',
			dev: 'device-aaa',
			type: 'access' as const,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 900,
		}
		const token = encodeJwt(payload, TEST_SECRET)

		const decoded = decodeJwt(token)
		expect(decoded).toEqual(payload)

		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual(payload)
	})

	test('refresh token roundtrip', () => {
		const payload = {
			sub: 'user-002',
			dev: 'device-bbb',
			type: 'refresh' as const,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
		}
		const token = encodeJwt(payload, TEST_SECRET)

		const decoded = decodeJwt(token)
		expect(decoded).toEqual(payload)

		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual(payload)
	})

	test('device credential token roundtrip', () => {
		const payload = {
			sub: 'user-003',
			dev: 'device-ccc',
			type: 'device_credential' as const,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
			dpk: 'sha256-thumbprint-of-device-public-key',
			mustCheckinBy: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
		}
		const token = encodeJwt(payload, TEST_SECRET)

		const decoded = decodeJwt(token)
		expect(decoded).toEqual(payload)

		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual(payload)

		expect(isExpired(verified as { exp: number })).toBe(false)
	})

	test('payload with nested objects roundtrips correctly', () => {
		const payload = {
			sub: 'user-004',
			permissions: { read: true, write: false },
			tags: ['admin', 'beta'],
		}
		const token = encodeJwt(payload, TEST_SECRET)
		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual(payload)
	})
})

describe('edge cases', () => {
	test('handles payload with unicode characters', () => {
		const payload = { sub: 'user-1', name: '\u00c9milie \u00d0\u00fe\u00f1' }
		const token = encodeJwt(payload, TEST_SECRET)
		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual(payload)
	})

	test('handles empty payload object', () => {
		const token = encodeJwt({}, TEST_SECRET)
		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual({})
	})

	test('handles payload with numeric values at boundaries', () => {
		const payload = {
			zero: 0,
			negative: -1,
			maxSafe: Number.MAX_SAFE_INTEGER,
			minSafe: Number.MIN_SAFE_INTEGER,
			float: Math.PI,
		}
		const token = encodeJwt(payload, TEST_SECRET)
		const verified = verifyJwt(token, TEST_SECRET)
		expect(verified).toEqual(payload)
	})

	test('handles empty secret', () => {
		const token = encodeJwt({ sub: 'user-1' }, '')
		const verified = verifyJwt(token, '')
		expect(verified).toEqual({ sub: 'user-1' })
		// But fails with a different secret
		expect(verifyJwt(token, 'any-other-secret')).toBeNull()
	})

	test('tokens from different secrets never cross-verify', () => {
		const payload = { sub: 'shared-payload', iat: 12345 }
		const tokenA = encodeJwt(payload, 'secret-alpha')
		const tokenB = encodeJwt(payload, 'secret-beta')

		expect(verifyJwt(tokenA, 'secret-beta')).toBeNull()
		expect(verifyJwt(tokenB, 'secret-alpha')).toBeNull()
		expect(verifyJwt(tokenA, 'secret-alpha')).toEqual(payload)
		expect(verifyJwt(tokenB, 'secret-beta')).toEqual(payload)
	})
})
