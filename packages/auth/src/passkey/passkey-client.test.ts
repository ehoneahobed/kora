import { describe, expect, test, vi } from 'vitest'
import { fromBase64Url, toBase64Url } from '../device/device-identity'
import {
	PasskeyError,
	PasskeyUnsupportedError,
	authenticateWithPasskey,
	createPasskeyCredential,
	decodeCbor,
	isPasskeySupported,
	isPlatformAuthenticatorAvailable,
} from './passkey-client'

// ============================================================================
// isPasskeySupported
// ============================================================================

describe('isPasskeySupported', () => {
	test('returns false in Node.js (no navigator.credentials)', () => {
		// Node.js does not have navigator.credentials, so this should be false
		const result = isPasskeySupported()
		expect(result).toBe(false)
	})

	test('returns false when navigator is undefined', () => {
		// In a Node.js test environment, navigator may be partially defined.
		// The function checks for navigator.credentials.create/get which won't exist.
		expect(isPasskeySupported()).toBe(false)
	})
})

// ============================================================================
// isPlatformAuthenticatorAvailable
// ============================================================================

describe('isPlatformAuthenticatorAvailable', () => {
	test('returns false when WebAuthn is not supported', async () => {
		const result = await isPlatformAuthenticatorAvailable()
		expect(result).toBe(false)
	})
})

// ============================================================================
// Error classes
// ============================================================================

describe('PasskeyError', () => {
	test('creates error with correct code and name', () => {
		const error = new PasskeyError('test message')
		expect(error.name).toBe('PasskeyError')
		expect(error.code).toBe('PASSKEY_ERROR')
		expect(error.message).toBe('test message')
	})

	test('includes context when provided', () => {
		const error = new PasskeyError('test', { rpId: 'example.com' })
		expect(error.context).toEqual({ rpId: 'example.com' })
	})

	test('extends Error', () => {
		const error = new PasskeyError('test')
		expect(error).toBeInstanceOf(Error)
	})
})

describe('PasskeyUnsupportedError', () => {
	test('creates error with correct code and name', () => {
		const error = new PasskeyUnsupportedError()
		expect(error.name).toBe('PasskeyUnsupportedError')
		expect(error.code).toBe('PASSKEY_UNSUPPORTED')
		expect(error.message).toContain('WebAuthn is not supported')
	})
})

// ============================================================================
// createPasskeyCredential — error cases
// ============================================================================

describe('createPasskeyCredential', () => {
	test('throws PasskeyUnsupportedError when WebAuthn is not available', async () => {
		await expect(
			createPasskeyCredential({
				challenge: toBase64Url(new Uint8Array(32).buffer),
				rpId: 'example.com',
				rpName: 'Example',
				userId: toBase64Url(new Uint8Array(16).buffer),
				userName: 'alice@example.com',
				userDisplayName: 'Alice',
			}),
		).rejects.toThrow(PasskeyUnsupportedError)
	})

	test('throws PasskeyUnsupportedError with descriptive message', async () => {
		await expect(
			createPasskeyCredential({
				challenge: toBase64Url(new Uint8Array(32).buffer),
				rpId: 'example.com',
				rpName: 'Example',
				userId: toBase64Url(new Uint8Array(16).buffer),
				userName: 'alice@example.com',
				userDisplayName: 'Alice',
			}),
		).rejects.toThrow('WebAuthn is not supported')
	})
})

// ============================================================================
// authenticateWithPasskey — error cases
// ============================================================================

describe('authenticateWithPasskey', () => {
	test('throws PasskeyUnsupportedError when WebAuthn is not available', async () => {
		await expect(
			authenticateWithPasskey({
				challenge: toBase64Url(new Uint8Array(32).buffer),
				rpId: 'example.com',
			}),
		).rejects.toThrow(PasskeyUnsupportedError)
	})

	test('throws PasskeyUnsupportedError with descriptive message', async () => {
		await expect(
			authenticateWithPasskey({
				challenge: toBase64Url(new Uint8Array(32).buffer),
				rpId: 'example.com',
			}),
		).rejects.toThrow('WebAuthn is not supported')
	})
})

// ============================================================================
// CBOR decoder
// ============================================================================

describe('decodeCbor', () => {
	test('decodes unsigned integer (small, < 24)', () => {
		// CBOR: 0x0a = unsigned integer 10
		const data = new Uint8Array([0x0a])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(10)
		expect(result.offset).toBe(1)
	})

	test('decodes unsigned integer 0', () => {
		const data = new Uint8Array([0x00])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(0)
		expect(result.offset).toBe(1)
	})

	test('decodes unsigned integer 23 (max inline)', () => {
		const data = new Uint8Array([0x17])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(23)
		expect(result.offset).toBe(1)
	})

	test('decodes unsigned integer 24 (1-byte additional)', () => {
		// CBOR: 0x18 0x18 = unsigned integer 24
		const data = new Uint8Array([0x18, 0x18])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(24)
		expect(result.offset).toBe(2)
	})

	test('decodes unsigned integer 255 (1-byte additional max)', () => {
		const data = new Uint8Array([0x18, 0xff])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(255)
		expect(result.offset).toBe(2)
	})

	test('decodes unsigned integer 256 (2-byte additional)', () => {
		// CBOR: 0x19 0x01 0x00 = unsigned integer 256
		const data = new Uint8Array([0x19, 0x01, 0x00])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(256)
		expect(result.offset).toBe(3)
	})

	test('decodes unsigned integer 65535 (2-byte additional max)', () => {
		const data = new Uint8Array([0x19, 0xff, 0xff])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(65535)
		expect(result.offset).toBe(3)
	})

	test('decodes unsigned integer 65536 (4-byte additional)', () => {
		// CBOR: 0x1a 0x00 0x01 0x00 0x00 = unsigned integer 65536
		const data = new Uint8Array([0x1a, 0x00, 0x01, 0x00, 0x00])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(65536)
		expect(result.offset).toBe(5)
	})

	test('decodes negative integer -1', () => {
		// CBOR: 0x20 = negative integer -1
		const data = new Uint8Array([0x20])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(-1)
		expect(result.offset).toBe(1)
	})

	test('decodes negative integer -7 (used in COSE for ES256)', () => {
		// CBOR: 0x26 = negative integer -7 (major type 1, additional info 6)
		const data = new Uint8Array([0x26])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(-7)
		expect(result.offset).toBe(1)
	})

	test('decodes negative integer -25 (1-byte additional)', () => {
		// CBOR: 0x38 0x18 = negative integer -25 (-1 - 24)
		const data = new Uint8Array([0x38, 0x18])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe(-25)
		expect(result.offset).toBe(2)
	})

	test('decodes byte string', () => {
		// CBOR: 0x44 0x01 0x02 0x03 0x04 = byte string of 4 bytes
		const data = new Uint8Array([0x44, 0x01, 0x02, 0x03, 0x04])
		const result = decodeCbor(data, 0)
		expect(result.value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]))
		expect(result.offset).toBe(5)
	})

	test('decodes empty byte string', () => {
		// CBOR: 0x40 = empty byte string
		const data = new Uint8Array([0x40])
		const result = decodeCbor(data, 0)
		expect(result.value).toEqual(new Uint8Array([]))
		expect(result.offset).toBe(1)
	})

	test('decodes text string', () => {
		// CBOR: 0x63 0x66 0x6d 0x74 = text string "fmt"
		const data = new Uint8Array([0x63, 0x66, 0x6d, 0x74])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe('fmt')
		expect(result.offset).toBe(4)
	})

	test('decodes empty text string', () => {
		// CBOR: 0x60 = empty text string
		const data = new Uint8Array([0x60])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe('')
		expect(result.offset).toBe(1)
	})

	test('decodes text string with UTF-8', () => {
		// "hello" in CBOR: 0x65 0x68 0x65 0x6c 0x6c 0x6f
		const data = new Uint8Array([0x65, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
		const result = decodeCbor(data, 0)
		expect(result.value).toBe('hello')
		expect(result.offset).toBe(6)
	})

	test('decodes array', () => {
		// CBOR: 0x83 0x01 0x02 0x03 = array [1, 2, 3]
		const data = new Uint8Array([0x83, 0x01, 0x02, 0x03])
		const result = decodeCbor(data, 0)
		expect(result.value).toEqual([1, 2, 3])
		expect(result.offset).toBe(4)
	})

	test('decodes empty array', () => {
		// CBOR: 0x80 = empty array
		const data = new Uint8Array([0x80])
		const result = decodeCbor(data, 0)
		expect(result.value).toEqual([])
		expect(result.offset).toBe(1)
	})

	test('decodes map with text keys', () => {
		// CBOR: a2 63 666d74 64 6e6f6e65 67 6174745374 6d74 a0
		// = {"fmt": "none", "attStmt": {}}
		// Simplified: a1 63 666d74 64 6e6f6e65 = {"fmt": "none"}
		const data = new Uint8Array([
			0xa1, // map with 1 entry
			0x63,
			0x66,
			0x6d,
			0x74, // text "fmt"
			0x64,
			0x6e,
			0x6f,
			0x6e,
			0x65, // text "none"
		])
		const result = decodeCbor(data, 0)
		const map = result.value as Map<string, unknown>
		expect(map.get('fmt')).toBe('none')
		expect(result.offset).toBe(10)
	})

	test('decodes empty map', () => {
		// CBOR: 0xa0 = empty map
		const data = new Uint8Array([0xa0])
		const result = decodeCbor(data, 0)
		const map = result.value as Map<string, unknown>
		expect(map.size).toBe(0)
		expect(result.offset).toBe(1)
	})

	test('decodes map with integer keys (COSE key format)', () => {
		// A simplified COSE key map:
		// { 1: 2, 3: -7 }
		// CBOR: a2 01 02 03 26
		const data = new Uint8Array([
			0xa2, // map with 2 entries
			0x01, // key: unsigned int 1
			0x02, // value: unsigned int 2
			0x03, // key: unsigned int 3
			0x26, // value: negative int -7
		])
		const result = decodeCbor(data, 0)
		const map = result.value as Map<number, unknown>
		expect(map.get(1)).toBe(2)
		expect(map.get(3)).toBe(-7)
		expect(result.offset).toBe(5)
	})

	test('decodes nested structures', () => {
		// { "arr": [1, 2], "num": 42 }
		// CBOR: a2 63 617272 82 01 02 63 6e756d 18 2a
		const data = new Uint8Array([
			0xa2, // map with 2 entries
			0x63,
			0x61,
			0x72,
			0x72, // text "arr"
			0x82,
			0x01,
			0x02, // array [1, 2]
			0x63,
			0x6e,
			0x75,
			0x6d, // text "num"
			0x18,
			0x2a, // unsigned int 42
		])
		const result = decodeCbor(data, 0)
		const map = result.value as Map<string, unknown>
		expect(map.get('arr')).toEqual([1, 2])
		expect(map.get('num')).toBe(42)
	})

	test('correctly tracks offset for sequential decoding', () => {
		// Two values back-to-back: 0x01 0x02 = [1, 2]
		const data = new Uint8Array([0x01, 0x02])
		const first = decodeCbor(data, 0)
		expect(first.value).toBe(1)
		expect(first.offset).toBe(1)

		const second = decodeCbor(data, first.offset)
		expect(second.value).toBe(2)
		expect(second.offset).toBe(2)
	})

	test('throws on unexpected end of data', () => {
		const data = new Uint8Array([])
		expect(() => decodeCbor(data, 0)).toThrow('unexpected end of data')
	})

	test('throws on unsupported additional info (8-byte integer)', () => {
		// CBOR additional info 27 = 8-byte integer, which we don't support
		const data = new Uint8Array([0x1b, 0, 0, 0, 0, 0, 0, 0, 1])
		expect(() => decodeCbor(data, 0)).toThrow('unsupported additional info')
	})

	test('respects starting offset parameter', () => {
		// Skip the first byte (0xff garbage) and decode from offset 1
		const data = new Uint8Array([0xff, 0x05])
		const result = decodeCbor(data, 1)
		expect(result.value).toBe(5)
		expect(result.offset).toBe(2)
	})
})

// ============================================================================
// Base64url encoding/decoding helpers (re-tested via passkey context)
// ============================================================================

describe('base64url helpers in passkey context', () => {
	test('round-trips challenge-sized data (32 bytes)', () => {
		const challengeBytes = new Uint8Array(32)
		globalThis.crypto.getRandomValues(challengeBytes)
		const encoded = toBase64Url(challengeBytes.buffer)
		const decoded = fromBase64Url(encoded)
		expect(decoded).toEqual(challengeBytes)
	})

	test('round-trips credential ID-sized data (variable length)', () => {
		// Credential IDs are typically 32-64 bytes
		for (const size of [32, 48, 64, 96]) {
			const idBytes = new Uint8Array(size)
			globalThis.crypto.getRandomValues(idBytes)
			const encoded = toBase64Url(idBytes.buffer)
			const decoded = fromBase64Url(encoded)
			expect(decoded).toEqual(idBytes)
		}
	})

	test('produces URL-safe output (no +, /, or = characters)', () => {
		// Generate enough random data that standard base64 would contain +, /, =
		const data = new Uint8Array(256)
		globalThis.crypto.getRandomValues(data)
		const encoded = toBase64Url(data.buffer)
		expect(encoded).not.toContain('+')
		expect(encoded).not.toContain('/')
		expect(encoded).not.toContain('=')
	})
})

// ============================================================================
// Integration: CBOR decoding of COSE key structures
// ============================================================================

describe('CBOR decoding of COSE key map', () => {
	test('decodes a full COSE EC2 key map', () => {
		// A COSE_Key map for EC2 P-256:
		// {
		//   1: 2,     // kty: EC2
		//   3: -7,    // alg: ES256
		//   -1: 1,    // crv: P-256
		//   -2: <32 bytes x>,
		//   -3: <32 bytes y>
		// }
		//
		// CBOR encoding:
		// a5        -- map(5)
		// 01        -- 1 (kty)
		// 02        -- 2 (EC2)
		// 03        -- 3 (alg)
		// 26        -- -7 (ES256)
		// 20        -- -1 (crv)
		// 01        -- 1 (P-256)
		// 21        -- -2 (x)
		// 5820      -- bytes(32)
		// [32 bytes of x coordinate]
		// 22        -- -3 (y)
		// 5820      -- bytes(32)
		// [32 bytes of y coordinate]

		const xCoord = new Uint8Array(32)
		const yCoord = new Uint8Array(32)
		// Fill with known values for testing
		for (let i = 0; i < 32; i++) {
			xCoord[i] = i
			yCoord[i] = 32 + i
		}

		const cborData = new Uint8Array([
			0xa5, // map(5)
			0x01,
			0x02, // 1: 2
			0x03,
			0x26, // 3: -7
			0x20,
			0x01, // -1: 1
			0x21,
			0x58,
			0x20, // -2: bytes(32)
			...xCoord,
			0x22,
			0x58,
			0x20, // -3: bytes(32)
			...yCoord,
		])

		const result = decodeCbor(cborData, 0)
		const map = result.value as Map<number, unknown>

		expect(map.get(1)).toBe(2) // kty = EC2
		expect(map.get(3)).toBe(-7) // alg = ES256
		expect(map.get(-1)).toBe(1) // crv = P-256
		expect(map.get(-2)).toEqual(xCoord) // x coordinate
		expect(map.get(-3)).toEqual(yCoord) // y coordinate
	})

	test('decodes an attestation object structure', () => {
		// Simplified attestation object:
		// {
		//   "fmt": "none",
		//   "attStmt": {},
		//   "authData": <bytes>
		// }
		const authData = new Uint8Array([0xaa, 0xbb, 0xcc])

		const cborData = new Uint8Array([
			0xa3, // map(3)
			// "fmt": "none"
			0x63,
			0x66,
			0x6d,
			0x74, // text "fmt"
			0x64,
			0x6e,
			0x6f,
			0x6e,
			0x65, // text "none"
			// "attStmt": {}
			0x67,
			0x61,
			0x74,
			0x74,
			0x53,
			0x74,
			0x6d,
			0x74, // text "attStmt"
			0xa0, // empty map
			// "authData": bytes
			0x68,
			0x61,
			0x75,
			0x74,
			0x68,
			0x44,
			0x61,
			0x74,
			0x61, // text "authData"
			0x43,
			0xaa,
			0xbb,
			0xcc, // bytes(3) [0xaa, 0xbb, 0xcc]
		])

		const result = decodeCbor(cborData, 0)
		const map = result.value as Map<string, unknown>

		expect(map.get('fmt')).toBe('none')
		expect(map.get('attStmt')).toEqual(new Map())
		expect(map.get('authData')).toEqual(authData)
	})
})
