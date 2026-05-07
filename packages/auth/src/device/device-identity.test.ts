import { describe, expect, test } from 'vitest'
import {
	CryptoUnavailableError,
	DeviceIdentityError,
	computePublicKeyThumbprint,
	exportPublicKeyJwk,
	fromBase64Url,
	generateDeviceKeyPair,
	signChallenge,
	toBase64Url,
	verifyChallenge,
} from './device-identity'

describe('device-identity', () => {
	describe('toBase64Url / fromBase64Url', () => {
		test('round-trips binary data correctly', () => {
			const original = new Uint8Array([0, 1, 2, 255, 128, 64, 32])
			const encoded = toBase64Url(original.buffer)
			const decoded = fromBase64Url(encoded)
			expect(decoded).toEqual(original)
		})

		test('produces no padding characters', () => {
			// Test various lengths that would produce padding in standard base64
			for (const length of [1, 2, 3, 4, 5, 10, 33]) {
				const data = new Uint8Array(length)
				globalThis.crypto.getRandomValues(data)
				const encoded = toBase64Url(data.buffer)
				expect(encoded).not.toContain('=')
			}
		})

		test('uses URL-safe characters (no + or /)', () => {
			// Use enough random data to likely encounter + and / in standard base64
			const data = new Uint8Array(256)
			globalThis.crypto.getRandomValues(data)
			const encoded = toBase64Url(data.buffer)
			expect(encoded).not.toContain('+')
			expect(encoded).not.toContain('/')
		})

		test('handles empty buffer', () => {
			const encoded = toBase64Url(new ArrayBuffer(0))
			expect(encoded).toBe('')
			const decoded = fromBase64Url('')
			expect(decoded).toEqual(new Uint8Array(0))
		})
	})

	describe('generateDeviceKeyPair', () => {
		test('generates a valid CryptoKeyPair', async () => {
			const keyPair = await generateDeviceKeyPair()

			expect(keyPair).toBeDefined()
			expect(keyPair.publicKey).toBeDefined()
			expect(keyPair.privateKey).toBeDefined()
		})

		test('public key has correct algorithm properties', async () => {
			const keyPair = await generateDeviceKeyPair()
			const algorithm = keyPair.publicKey.algorithm as EcKeyGenParams

			expect(algorithm.name).toBe('ECDSA')
			expect(algorithm.namedCurve).toBe('P-256')
		})

		test('private key has correct algorithm properties', async () => {
			const keyPair = await generateDeviceKeyPair()
			const algorithm = keyPair.privateKey.algorithm as EcKeyGenParams

			expect(algorithm.name).toBe('ECDSA')
			expect(algorithm.namedCurve).toBe('P-256')
		})

		test('private key supports sign usage', async () => {
			const keyPair = await generateDeviceKeyPair()
			expect(keyPair.privateKey.usages).toContain('sign')
		})

		test('public key supports verify usage', async () => {
			const keyPair = await generateDeviceKeyPair()
			expect(keyPair.publicKey.usages).toContain('verify')
		})

		test('generates unique key pairs on each call', async () => {
			const keyPairA = await generateDeviceKeyPair()
			const keyPairB = await generateDeviceKeyPair()

			const jwkA = await exportPublicKeyJwk(keyPairA)
			const jwkB = await exportPublicKeyJwk(keyPairB)

			// Different key pairs should have different x and y coordinates
			expect(jwkA.x).not.toBe(jwkB.x)
		})
	})

	describe('exportPublicKeyJwk', () => {
		test('exports the public key as a valid JWK', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			expect(jwk.kty).toBe('EC')
			expect(jwk.crv).toBe('P-256')
			expect(jwk.x).toBeDefined()
			expect(jwk.y).toBeDefined()
			expect(typeof jwk.x).toBe('string')
			expect(typeof jwk.y).toBe('string')
		})

		test('exported JWK does not contain the private key component', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			// The 'd' parameter is the private key scalar for EC keys.
			// It must not be present in a public key JWK.
			expect(jwk.d).toBeUndefined()
		})

		test('exported JWK contains key_ops for verify', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			// Web Crypto includes key_ops when exporting
			expect(jwk.key_ops).toContain('verify')
		})
	})

	describe('signChallenge / verifyChallenge', () => {
		test('sign and verify round-trip succeeds', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)
			const challenge = 'server-nonce-abc123'

			const signature = await signChallenge(keyPair.privateKey, challenge)
			const isValid = await verifyChallenge(jwk, challenge, signature)

			expect(isValid).toBe(true)
		})

		test('signature is a non-empty base64url string', async () => {
			const keyPair = await generateDeviceKeyPair()
			const signature = await signChallenge(keyPair.privateKey, 'test-challenge')

			expect(signature.length).toBeGreaterThan(0)
			// base64url: only alphanumeric, hyphen, underscore
			expect(signature).toMatch(/^[A-Za-z0-9_-]+$/)
		})

		test('verification fails with wrong challenge', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			const signature = await signChallenge(keyPair.privateKey, 'correct-challenge')
			const isValid = await verifyChallenge(jwk, 'wrong-challenge', signature)

			expect(isValid).toBe(false)
		})

		test('verification fails with wrong key', async () => {
			const keyPairA = await generateDeviceKeyPair()
			const keyPairB = await generateDeviceKeyPair()
			const jwkB = await exportPublicKeyJwk(keyPairB)

			const challenge = 'test-challenge'
			// Sign with key A's private key
			const signature = await signChallenge(keyPairA.privateKey, challenge)
			// Verify with key B's public key -- should fail
			const isValid = await verifyChallenge(jwkB, challenge, signature)

			expect(isValid).toBe(false)
		})

		test('signs different challenges with different signatures', async () => {
			const keyPair = await generateDeviceKeyPair()

			const sig1 = await signChallenge(keyPair.privateKey, 'challenge-1')
			const sig2 = await signChallenge(keyPair.privateKey, 'challenge-2')

			expect(sig1).not.toBe(sig2)
		})

		test('handles empty challenge string', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			const signature = await signChallenge(keyPair.privateKey, '')
			const isValid = await verifyChallenge(jwk, '', signature)

			expect(isValid).toBe(true)
		})

		test('handles challenge with unicode characters', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)
			const challenge = 'nonce-with-unicode-\u00e9\u00e0\u00fc-\u4f60\u597d'

			const signature = await signChallenge(keyPair.privateKey, challenge)
			const isValid = await verifyChallenge(jwk, challenge, signature)

			expect(isValid).toBe(true)
		})
	})

	describe('computePublicKeyThumbprint', () => {
		test('computes a non-empty base64url thumbprint', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			const thumbprint = await computePublicKeyThumbprint(jwk)

			expect(thumbprint.length).toBeGreaterThan(0)
			// base64url: only alphanumeric, hyphen, underscore
			expect(thumbprint).toMatch(/^[A-Za-z0-9_-]+$/)
		})

		test('produces consistent thumbprint for the same key', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			const thumbprint1 = await computePublicKeyThumbprint(jwk)
			const thumbprint2 = await computePublicKeyThumbprint(jwk)

			expect(thumbprint1).toBe(thumbprint2)
		})

		test('produces different thumbprints for different keys', async () => {
			const keyPairA = await generateDeviceKeyPair()
			const keyPairB = await generateDeviceKeyPair()

			const jwkA = await exportPublicKeyJwk(keyPairA)
			const jwkB = await exportPublicKeyJwk(keyPairB)

			const thumbprintA = await computePublicKeyThumbprint(jwkA)
			const thumbprintB = await computePublicKeyThumbprint(jwkB)

			expect(thumbprintA).not.toBe(thumbprintB)
		})

		test('thumbprint is a SHA-256 hash (32 bytes = 43 base64url chars)', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			const thumbprint = await computePublicKeyThumbprint(jwk)
			// SHA-256 = 32 bytes. base64url of 32 bytes = ceil(32 * 4/3) = 43 characters (no padding)
			expect(thumbprint.length).toBe(43)
		})

		test('ignores extra JWK fields (only uses crv, kty, x, y per RFC 7638)', async () => {
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			// Compute thumbprint with the full JWK (includes key_ops, ext, etc.)
			const thumbprintFull = await computePublicKeyThumbprint(jwk)

			// Compute thumbprint with a minimal JWK containing only required fields
			const minimalJwk: JsonWebKey = {
				kty: jwk.kty,
				crv: jwk.crv,
				x: jwk.x,
				y: jwk.y,
			}
			const thumbprintMinimal = await computePublicKeyThumbprint(minimalJwk)

			// Both should produce the same thumbprint since only crv, kty, x, y are hashed
			expect(thumbprintFull).toBe(thumbprintMinimal)
		})

		test('throws DeviceIdentityError for non-EC key type', async () => {
			const nonEcJwk: JsonWebKey = {
				kty: 'RSA',
				n: 'some-value',
				e: 'AQAB',
			}

			await expect(computePublicKeyThumbprint(nonEcJwk)).rejects.toThrow(DeviceIdentityError)
			await expect(computePublicKeyThumbprint(nonEcJwk)).rejects.toThrow(
				/Expected JWK key type "EC"/,
			)
		})

		test('throws DeviceIdentityError for JWK missing required fields', async () => {
			const incompleteJwk: JsonWebKey = {
				kty: 'EC',
				crv: 'P-256',
				// Missing x and y
			}

			await expect(computePublicKeyThumbprint(incompleteJwk)).rejects.toThrow(
				DeviceIdentityError,
			)
			await expect(computePublicKeyThumbprint(incompleteJwk)).rejects.toThrow(
				/missing required EC fields/,
			)
		})

		test('thumbprint matches RFC 7638 canonical form (lexicographic key order)', async () => {
			// Manually verify the canonical form uses alphabetically sorted keys:
			// {"crv":"P-256","kty":"EC","x":"...","y":"..."}
			// We can verify this by computing a thumbprint for a known JWK and checking
			// it matches what we'd get from manual hashing.
			const keyPair = await generateDeviceKeyPair()
			const jwk = await exportPublicKeyJwk(keyPair)

			const canonicalJson = JSON.stringify({
				crv: jwk.crv,
				kty: jwk.kty,
				x: jwk.x,
				y: jwk.y,
			})

			// Manually compute expected thumbprint
			const encoded = new TextEncoder().encode(canonicalJson)
			const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
			const expectedThumbprint = toBase64Url(hashBuffer)

			const actualThumbprint = await computePublicKeyThumbprint(jwk)

			expect(actualThumbprint).toBe(expectedThumbprint)
		})
	})
})
