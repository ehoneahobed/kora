import { beforeEach, describe, expect, test } from 'vitest'
import {
	InMemoryTotpStore,
	TotpAlreadyEnabledError,
	TotpInvalidCodeError,
	TotpManager,
	TotpNotEnabledError,
	TotpNotVerifiedError,
	base32Decode,
	base32Encode,
} from './totp'

// Helper: extract a valid TOTP code from TotpManager's internal validation
// We generate a code by using the same algorithm the manager uses
function generateValidCode(base32Secret: string, period = 30, digits = 6): string {
	const secret = base32Decode(base32Secret)
	const counter = Math.floor(Date.now() / 1000 / period)
	return generateHotpCode(secret, counter, digits)
}

function generateHotpCode(secret: Uint8Array, counter: number, digits: number): string {
	// Counter as 8-byte big-endian
	const counterBytes = new Uint8Array(8)
	let c = counter
	for (let i = 7; i >= 0; i--) {
		counterBytes[i] = c & 0xff
		c = Math.floor(c / 256)
	}

	const hash = hmacSha1(secret, counterBytes)

	const offset = (hash[hash.length - 1] as number) & 0x0f
	const binary =
		(((hash[offset] as number) & 0x7f) << 24) |
		(((hash[offset + 1] as number) & 0xff) << 16) |
		(((hash[offset + 2] as number) & 0xff) << 8) |
		((hash[offset + 3] as number) & 0xff)

	const otp = binary % 10 ** digits
	return otp.toString().padStart(digits, '0')
}

// Minimal SHA-1 + HMAC for test code generation
function sha1(data: Uint8Array): Uint8Array {
	let h0 = 0x67452301
	let h1 = 0xefcdab89
	let h2 = 0x98badcfe
	let h3 = 0x10325476
	let h4 = 0xc3d2e1f0

	const bitLength = data.length * 8
	const paddedLength = Math.ceil((data.length + 9) / 64) * 64
	const padded = new Uint8Array(paddedLength)
	padded.set(data)
	padded[data.length] = 0x80
	const view = new DataView(padded.buffer, padded.byteOffset)
	view.setUint32(paddedLength - 4, bitLength, false)

	const w = new Int32Array(80)

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getInt32(offset + i * 4, false)
		}
		for (let i = 16; i < 80; i++) {
			const xor =
				(w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number)
			w[i] = (xor << 1) | (xor >>> 31) | 0
		}

		let a = h0
		let b = h1
		let c = h2
		let d = h3
		let e = h4

		for (let i = 0; i < 80; i++) {
			let f: number
			let k: number
			if (i < 20) {
				f = (b & c) | (~b & d)
				k = 0x5a827999
			} else if (i < 40) {
				f = b ^ c ^ d
				k = 0x6ed9eba1
			} else if (i < 60) {
				f = (b & c) | (b & d) | (c & d)
				k = 0x8f1bbcdc
			} else {
				f = b ^ c ^ d
				k = 0xca62c1d6
			}

			const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] as number)) | 0
			e = d
			d = c
			c = (b << 30) | (b >>> 2) | 0
			b = a
			a = temp
		}

		h0 = (h0 + a) | 0
		h1 = (h1 + b) | 0
		h2 = (h2 + c) | 0
		h3 = (h3 + d) | 0
		h4 = (h4 + e) | 0
	}

	const result = new Uint8Array(20)
	const rv = new DataView(result.buffer)
	rv.setInt32(0, h0, false)
	rv.setInt32(4, h1, false)
	rv.setInt32(8, h2, false)
	rv.setInt32(12, h3, false)
	rv.setInt32(16, h4, false)
	return result
}

function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
	const blockSize = 64
	let keyPad = key
	if (keyPad.length > blockSize) keyPad = sha1(keyPad)

	const ipad = new Uint8Array(blockSize)
	const opad = new Uint8Array(blockSize)
	for (let i = 0; i < blockSize; i++) {
		const k = i < keyPad.length ? (keyPad[i] as number) : 0
		ipad[i] = k ^ 0x36
		opad[i] = k ^ 0x5c
	}

	const innerData = new Uint8Array(blockSize + message.length)
	innerData.set(ipad)
	innerData.set(message, blockSize)
	const innerHash = sha1(innerData)

	const outerData = new Uint8Array(blockSize + innerHash.length)
	outerData.set(opad)
	outerData.set(innerHash, blockSize)
	return sha1(outerData)
}

// ============================================================================
// Tests
// ============================================================================

describe('TotpManager', () => {
	let manager: TotpManager
	let store: InMemoryTotpStore

	beforeEach(() => {
		store = new InMemoryTotpStore()
		manager = new TotpManager({
			issuer: 'TestApp',
			store,
		})
	})

	// --- enable ---

	describe('enable', () => {
		test('returns secret, URI, and recovery codes', async () => {
			const result = await manager.enable('user-1', 'alice@example.com')

			expect(result.secret).toBeTruthy()
			expect(result.secret.length).toBeGreaterThan(20)

			expect(result.uri).toContain('otpauth://totp/')
			expect(result.uri).toContain('TestApp')
			expect(result.uri).toContain('alice%40example.com')
			expect(result.uri).toContain(result.secret)

			expect(result.recoveryCodes).toHaveLength(8)
			// Recovery codes formatted as xxxxx-xxxxx
			for (const code of result.recoveryCodes) {
				expect(code).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/)
			}
		})

		test('stores unverified secret', async () => {
			await manager.enable('user-1', 'alice@example.com')

			const stored = await store.getByUserId('user-1')
			expect(stored).not.toBeNull()
			expect(stored?.verified).toBe(false)
			expect(stored?.verifiedAt).toBeNull()
		})

		test('throws if already enabled and verified', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			await expect(manager.enable('user-1', 'alice@example.com')).rejects.toThrow(
				TotpAlreadyEnabledError,
			)
		})

		test('allows re-enable if not yet verified', async () => {
			await manager.enable('user-1', 'alice@example.com')
			// Not yet verified, so re-enabling should work (replaces pending setup)
			const result2 = await manager.enable('user-1', 'alice@example.com')
			expect(result2.secret).toBeTruthy()
		})

		test('generates unique secrets for different users', async () => {
			const r1 = await manager.enable('user-1', 'alice@example.com')
			const r2 = await manager.enable('user-2', 'bob@example.com')
			expect(r1.secret).not.toBe(r2.secret)
		})

		test('generates unique recovery codes', async () => {
			const result = await manager.enable('user-1', 'alice@example.com')
			const unique = new Set(result.recoveryCodes)
			expect(unique.size).toBe(result.recoveryCodes.length)
		})
	})

	// --- verifySetup ---

	describe('verifySetup', () => {
		test('verifies setup with valid code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			const result = await manager.verifySetup('user-1', code)
			expect(result).toBe(true)

			const stored = await store.getByUserId('user-1')
			expect(stored?.verified).toBe(true)
			expect(stored?.verifiedAt).toBeGreaterThan(0)
		})

		test('rejects invalid code', async () => {
			await manager.enable('user-1', 'alice@example.com')
			await expect(manager.verifySetup('user-1', '000000')).rejects.toThrow(TotpInvalidCodeError)
		})

		test('throws if TOTP not enabled', async () => {
			await expect(manager.verifySetup('user-1', '123456')).rejects.toThrow(TotpNotEnabledError)
		})
	})

	// --- verify ---

	describe('verify', () => {
		test('accepts valid code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			// Generate another code for the same window (should still be valid)
			const loginCode = generateValidCode(setup.secret)
			const result = await manager.verify('user-1', loginCode)
			expect(result).toBe(true)
		})

		test('rejects invalid code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const result = await manager.verify('user-1', '000000')
			expect(result).toBe(false)
		})

		test('throws if TOTP not enabled', async () => {
			await expect(manager.verify('user-1', '123456')).rejects.toThrow(TotpNotEnabledError)
		})

		test('throws if TOTP not verified', async () => {
			await manager.enable('user-1', 'alice@example.com')
			await expect(manager.verify('user-1', '123456')).rejects.toThrow(TotpNotVerifiedError)
		})
	})

	// --- recovery codes ---

	describe('verifyRecoveryCode', () => {
		test('accepts valid recovery code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const result = await manager.verifyRecoveryCode('user-1', setup.recoveryCodes[0] as string)
			expect(result).toBe(true)
		})

		test('recovery codes are single-use', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const recoveryCode = setup.recoveryCodes[0] as string
			await manager.verifyRecoveryCode('user-1', recoveryCode)

			// Second use should fail
			const result = await manager.verifyRecoveryCode('user-1', recoveryCode)
			expect(result).toBe(false)
		})

		test('rejects invalid recovery code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const result = await manager.verifyRecoveryCode('user-1', 'zzzzz-zzzzz')
			expect(result).toBe(false)
		})

		test('throws if TOTP not enabled', async () => {
			await expect(manager.verifyRecoveryCode('user-1', 'abc')).rejects.toThrow(TotpNotEnabledError)
		})

		test('throws if TOTP not verified', async () => {
			await manager.enable('user-1', 'alice@example.com')
			await expect(manager.verifyRecoveryCode('user-1', 'abc')).rejects.toThrow(
				TotpNotVerifiedError,
			)
		})

		test('handles recovery code with whitespace/dashes', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			// Recovery codes are stored as xxxxx-xxxxx, should work with extra spaces
			const recoveryCode = setup.recoveryCodes[1] as string
			const result = await manager.verifyRecoveryCode('user-1', ` ${recoveryCode} `)
			expect(result).toBe(true)
		})
	})

	// --- regenerateRecoveryCodes ---

	describe('regenerateRecoveryCodes', () => {
		test('generates new recovery codes', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const newCode = generateValidCode(setup.secret)
			const newCodes = await manager.regenerateRecoveryCodes('user-1', newCode)

			expect(newCodes).toHaveLength(8)
			// New codes should be different from original
			expect(newCodes).not.toEqual(setup.recoveryCodes)
		})

		test('old recovery codes no longer work after regeneration', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const newCode = generateValidCode(setup.secret)
			await manager.regenerateRecoveryCodes('user-1', newCode)

			// Old codes should fail
			const result = await manager.verifyRecoveryCode('user-1', setup.recoveryCodes[0] as string)
			expect(result).toBe(false)
		})

		test('rejects invalid TOTP code for regeneration', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			await expect(manager.regenerateRecoveryCodes('user-1', '000000')).rejects.toThrow(
				TotpInvalidCodeError,
			)
		})

		test('throws if TOTP not enabled', async () => {
			await expect(manager.regenerateRecoveryCodes('user-1', '123456')).rejects.toThrow(
				TotpNotEnabledError,
			)
		})
	})

	// --- disable ---

	describe('disable', () => {
		test('disables TOTP with valid code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			const disableCode = generateValidCode(setup.secret)
			await manager.disable('user-1', disableCode)

			expect(await manager.isEnabled('user-1')).toBe(false)
		})

		test('disables TOTP with recovery code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			await manager.disable('user-1', setup.recoveryCodes[0] as string)
			expect(await manager.isEnabled('user-1')).toBe(false)
		})

		test('rejects invalid code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			await expect(manager.disable('user-1', '000000')).rejects.toThrow(TotpInvalidCodeError)
		})

		test('throws if TOTP not enabled', async () => {
			await expect(manager.disable('user-1', '123456')).rejects.toThrow(TotpNotEnabledError)
		})
	})

	// --- isEnabled ---

	describe('isEnabled', () => {
		test('returns false when not enabled', async () => {
			expect(await manager.isEnabled('user-1')).toBe(false)
		})

		test('returns false when enabled but not verified', async () => {
			await manager.enable('user-1', 'alice@example.com')
			expect(await manager.isEnabled('user-1')).toBe(false)
		})

		test('returns true when enabled and verified', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)
			expect(await manager.isEnabled('user-1')).toBe(true)
		})
	})

	// --- remainingRecoveryCodes ---

	describe('remainingRecoveryCodes', () => {
		test('returns 0 when not enabled', async () => {
			expect(await manager.remainingRecoveryCodes('user-1')).toBe(0)
		})

		test('returns total after enable and verify', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)
			expect(await manager.remainingRecoveryCodes('user-1')).toBe(8)
		})

		test('decrements after using a recovery code', async () => {
			const setup = await manager.enable('user-1', 'alice@example.com')
			const code = generateValidCode(setup.secret)
			await manager.verifySetup('user-1', code)

			await manager.verifyRecoveryCode('user-1', setup.recoveryCodes[0] as string)
			expect(await manager.remainingRecoveryCodes('user-1')).toBe(7)
		})
	})
})

// --- URI generation ---

describe('otpauth URI', () => {
	test('URI contains all required parameters', async () => {
		const store = new InMemoryTotpStore()
		const manager = new TotpManager({
			issuer: 'My App',
			store,
			digits: 6,
			period: 30,
			algorithm: 'SHA-1',
		})

		const result = await manager.enable('user-1', 'alice@example.com')
		const url = new URL(result.uri)

		expect(url.protocol).toBe('otpauth:')
		expect(url.pathname).toContain('My%20App')
		expect(url.pathname).toContain('alice%40example.com')
		expect(url.searchParams.get('secret')).toBe(result.secret)
		expect(url.searchParams.get('issuer')).toBe('My App')
		expect(url.searchParams.get('algorithm')).toBe('SHA1')
		expect(url.searchParams.get('digits')).toBe('6')
		expect(url.searchParams.get('period')).toBe('30')
	})
})

// --- Base32 ---

describe('base32', () => {
	test('round-trips correctly', () => {
		const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		const encoded = base32Encode(original)
		const decoded = base32Decode(encoded)
		expect(decoded).toEqual(original)
	})

	test('encodes known value', () => {
		// "Hello!" = JBSWY3DPEE (well-known base32 test)
		const input = new TextEncoder().encode('Hello!')
		const encoded = base32Encode(input)
		expect(encoded).toBe('JBSWY3DPEE')
	})

	test('decodes known value', () => {
		const decoded = base32Decode('JBSWY3DPEE')
		const text = new TextDecoder().decode(decoded)
		expect(text).toBe('Hello!')
	})

	test('handles empty input', () => {
		expect(base32Encode(new Uint8Array([]))).toBe('')
		expect(base32Decode('')).toEqual(new Uint8Array([]))
	})

	test('handles padding in decode', () => {
		const decoded = base32Decode('JBSWY3DPEE======')
		const text = new TextDecoder().decode(decoded)
		expect(text).toBe('Hello!')
	})
})

// --- InMemoryTotpStore ---

describe('InMemoryTotpStore', () => {
	let store: InMemoryTotpStore

	beforeEach(() => {
		store = new InMemoryTotpStore()
	})

	test('saves and retrieves', async () => {
		const secret: import('./totp').TotpSecret = {
			userId: 'u1',
			secret: 'ABCDEFGH',
			verified: false,
			recoveryCodes: ['hash1', 'hash2'],
			createdAt: Date.now(),
			verifiedAt: null,
		}
		await store.save(secret)
		const retrieved = await store.getByUserId('u1')
		expect(retrieved).toEqual(secret)
	})

	test('returns null for unknown user', async () => {
		expect(await store.getByUserId('unknown')).toBeNull()
	})

	test('deletes', async () => {
		await store.save({
			userId: 'u1',
			secret: 'ABC',
			verified: true,
			recoveryCodes: [],
			createdAt: Date.now(),
			verifiedAt: Date.now(),
		})
		await store.delete('u1')
		expect(await store.getByUserId('u1')).toBeNull()
	})

	test('overwrites on save', async () => {
		await store.save({
			userId: 'u1',
			secret: 'OLD',
			verified: false,
			recoveryCodes: [],
			createdAt: Date.now(),
			verifiedAt: null,
		})
		await store.save({
			userId: 'u1',
			secret: 'NEW',
			verified: true,
			recoveryCodes: [],
			createdAt: Date.now(),
			verifiedAt: Date.now(),
		})
		const retrieved = await store.getByUserId('u1')
		expect(retrieved?.secret).toBe('NEW')
		expect(retrieved?.verified).toBe(true)
	})
})

// --- TOTP RFC 6238 Known Test Vectors ---

describe('TOTP RFC 6238 test vectors', () => {
	test('generates correct code for known secret and time', async () => {
		// RFC 6238 test vector for SHA-1:
		// Secret = "12345678901234567890" (ASCII)
		// Time = 59 seconds -> counter = 1
		const secret = new TextEncoder().encode('12345678901234567890')
		const counter = 1 // floor(59/30)
		const code = generateHotpCode(secret, counter, 8) // RFC uses 8 digits

		// RFC 6238 expected value for T=0x01 with SHA-1 and 8 digits: 94287082
		// (This is the well-known reference vector)
		expect(code).toBe('94287082')
	})

	test('generates correct code for time counter 0', () => {
		// T = 0 -> counter = 0
		// Known SHA-1 vector: counter=0, secret="12345678901234567890", 8 digits -> 84755224
		// (This is from RFC 4226 HOTP test vectors)
		const secret = new TextEncoder().encode('12345678901234567890')
		const code = generateHotpCode(secret, 0, 6)
		expect(code).toBe('755224')
	})
})
