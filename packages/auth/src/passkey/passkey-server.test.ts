import { describe, expect, test } from 'vitest'
import { fromBase64Url, toBase64Url } from '../device/device-identity'
import { decodeCbor } from './passkey-client'
import {
	PasskeyVerificationError,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from './passkey-server'

// ============================================================================
// Test helper: Convert IEEE P1363 signature to ASN.1 DER format
// ============================================================================

/**
 * Node.js crypto.subtle.sign('ECDSA') produces IEEE P1363 format (r || s).
 * Real WebAuthn authenticators produce ASN.1 DER format.
 * This helper converts P1363 → DER for tests that need to simulate authenticator output.
 */
function p1363ToDer(p1363: Uint8Array, componentLength: number): Uint8Array {
	const r = p1363.slice(0, componentLength)
	const s = p1363.slice(componentLength, componentLength * 2)

	// DER integers must be positive. If the high bit is set, prepend 0x00.
	// Also strip leading zeros (but keep at least one byte).
	const rDer = derInteger(r)
	const sDer = derInteger(s)

	// SEQUENCE: 0x30 <length> <r-integer> <s-integer>
	const sequenceLength = rDer.length + sDer.length
	const result = new Uint8Array(2 + sequenceLength)
	result[0] = 0x30
	result[1] = sequenceLength
	result.set(rDer, 2)
	result.set(sDer, 2 + rDer.length)
	return result
}

function derInteger(bytes: Uint8Array): Uint8Array {
	// Strip leading zeros but keep at least one byte
	let start = 0
	while (start < bytes.length - 1 && bytes[start] === 0) {
		start++
	}
	const trimmed = bytes.slice(start)

	// If high bit is set, prepend 0x00 to keep it positive
	const needsPadding = (trimmed[0]! & 0x80) !== 0
	const intBytes = needsPadding
		? new Uint8Array([0x00, ...trimmed])
		: trimmed

	// INTEGER tag: 0x02 <length> <bytes>
	const result = new Uint8Array(2 + intBytes.length)
	result[0] = 0x02
	result[1] = intBytes.length
	result.set(intBytes, 2)
	return result
}

// ============================================================================
// generateRegistrationOptions
// ============================================================================

describe('generateRegistrationOptions', () => {
	test('returns a valid registration options object', () => {
		const options = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		expect(options.rpId).toBe('example.com')
		expect(options.rpName).toBe('Example App')
		expect(options.userId).toBe('user-123')
		expect(options.userName).toBe('alice@example.com')
		expect(options.userDisplayName).toBe('Alice')
		expect(options.timeout).toBe(60000)
	})

	test('generates a challenge that is base64url-encoded', () => {
		const options = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		// Challenge should be non-empty and base64url
		expect(options.challenge.length).toBeGreaterThan(0)
		expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	test('challenge decodes to exactly 32 bytes', () => {
		const options = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		const challengeBytes = fromBase64Url(options.challenge)
		expect(challengeBytes.length).toBe(32)
	})

	test('generates unique challenges on each call', () => {
		const options1 = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		const options2 = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		// Challenges should be different (cryptographically random)
		expect(options1.challenge).not.toBe(options2.challenge)
	})

	test('includes authenticator selection criteria', () => {
		const options = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		expect(options.authenticatorSelection).toEqual({
			authenticatorAttachment: 'platform',
			residentKey: 'preferred',
			userVerification: 'required',
		})
	})

	test('excludeCredentialIds defaults to empty array', () => {
		const options = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
		})

		expect(options.excludeCredentialIds).toEqual([])
	})

	test('passes through existingCredentialIds', () => {
		const existingIds = ['cred-1', 'cred-2']
		const options = generateRegistrationOptions({
			rpId: 'example.com',
			rpName: 'Example App',
			userId: 'user-123',
			userName: 'alice@example.com',
			userDisplayName: 'Alice',
			existingCredentialIds: existingIds,
		})

		expect(options.excludeCredentialIds).toEqual(existingIds)
	})
})

// ============================================================================
// generateAuthenticationOptions
// ============================================================================

describe('generateAuthenticationOptions', () => {
	test('returns a valid authentication options object', () => {
		const options = generateAuthenticationOptions({
			rpId: 'example.com',
		})

		expect(options.rpId).toBe('example.com')
		expect(options.userVerification).toBe('preferred')
		expect(options.timeout).toBe(60000)
	})

	test('generates a challenge that is base64url-encoded', () => {
		const options = generateAuthenticationOptions({
			rpId: 'example.com',
		})

		expect(options.challenge.length).toBeGreaterThan(0)
		expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	test('challenge decodes to exactly 32 bytes', () => {
		const options = generateAuthenticationOptions({
			rpId: 'example.com',
		})

		const challengeBytes = fromBase64Url(options.challenge)
		expect(challengeBytes.length).toBe(32)
	})

	test('generates unique challenges on each call', () => {
		const options1 = generateAuthenticationOptions({ rpId: 'example.com' })
		const options2 = generateAuthenticationOptions({ rpId: 'example.com' })

		expect(options1.challenge).not.toBe(options2.challenge)
	})

	test('passes through allowCredentialIds', () => {
		const allowIds = ['cred-a', 'cred-b']
		const options = generateAuthenticationOptions({
			rpId: 'example.com',
			allowCredentialIds: allowIds,
		})

		expect(options.allowCredentialIds).toEqual(allowIds)
	})

	test('allowCredentialIds is undefined when not provided', () => {
		const options = generateAuthenticationOptions({
			rpId: 'example.com',
		})

		expect(options.allowCredentialIds).toBeUndefined()
	})
})

// ============================================================================
// PasskeyVerificationError
// ============================================================================

describe('PasskeyVerificationError', () => {
	test('creates error with correct code and name', () => {
		const error = new PasskeyVerificationError('verification failed')
		expect(error.name).toBe('PasskeyVerificationError')
		expect(error.code).toBe('PASSKEY_VERIFICATION_ERROR')
		expect(error.message).toBe('verification failed')
	})

	test('includes context when provided', () => {
		const error = new PasskeyVerificationError('test', { format: 'packed' })
		expect(error.context).toEqual({ format: 'packed' })
	})

	test('extends Error', () => {
		const error = new PasskeyVerificationError('test')
		expect(error).toBeInstanceOf(Error)
	})
})

// ============================================================================
// verifyRegistrationResponse
// ============================================================================

describe('verifyRegistrationResponse', () => {
	test('rejects malformed clientDataJSON', async () => {
		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode('not json').buffer,
					),
					attestationObject: 'test-attestation',
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
			}),
		).rejects.toThrow(PasskeyVerificationError)
	})

	test('rejects wrong clientData type', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.get', // wrong type for registration
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					attestationObject: 'test-attestation',
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
			}),
		).rejects.toThrow('Expected clientData.type "webauthn.create"')
	})

	test('rejects challenge mismatch', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: 'wrong-challenge',
			origin: 'https://example.com',
		})

		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					attestationObject: 'test-attestation',
				},
				expectedChallenge: 'expected-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
			}),
		).rejects.toThrow('Challenge mismatch')
	})

	test('rejects origin mismatch', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: 'test-challenge',
			origin: 'https://evil.com',
		})

		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					attestationObject: 'test-attestation',
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
			}),
		).rejects.toThrow('Origin mismatch')
	})

	test('rejects unsupported attestation format', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		// Build a CBOR attestation object with format "packed"
		// a3 63 666d74 66 7061636b6564 67 61747453746d74 a0 68 61757468 44617461 40
		const attestationCbor = new Uint8Array([
			0xa3, // map(3)
			0x63, 0x66, 0x6d, 0x74, // "fmt"
			0x66, 0x70, 0x61, 0x63, 0x6b, 0x65, 0x64, // "packed"
			0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74, // "attStmt"
			0xa0, // {}
			0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61, // "authData"
			0x40, // empty bytes
		])

		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					attestationObject: toBase64Url(attestationCbor.buffer),
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
			}),
		).rejects.toThrow('Unsupported attestation format')
	})

	test('verifies a valid registration response with correct attestation', async () => {
		// Build a realistic (but synthetic) registration response.
		// We need:
		// 1. A clientDataJSON with correct type, challenge, origin
		// 2. A CBOR attestation object with "none" format and valid authData
		//    containing rpIdHash, flags, signCount, aaguid, credentialId, cosePublicKey

		const expectedChallenge = 'dGVzdC1jaGFsbGVuZ2U' // base64url of some challenge
		const expectedOrigin = 'https://example.com'
		const expectedRpId = 'example.com'

		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: expectedChallenge,
			origin: expectedOrigin,
		})

		// Compute SHA-256 of rpId for rpIdHash
		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(expectedRpId),
			),
		)

		// Flags: UP (0x01) | AT (0x40) = 0x41
		const flags = 0x41

		// Sign count: 1 (big-endian uint32)
		const signCount = new Uint8Array([0x00, 0x00, 0x00, 0x01])

		// AAGUID: 16 zero bytes
		const aaguid = new Uint8Array(16)

		// Credential ID: 32 random bytes
		const credentialId = new Uint8Array(32)
		globalThis.crypto.getRandomValues(credentialId)
		const credentialIdLength = new Uint8Array([0x00, 0x20]) // 32 in big-endian

		// COSE public key for EC2 P-256:
		const xCoord = new Uint8Array(32)
		const yCoord = new Uint8Array(32)
		globalThis.crypto.getRandomValues(xCoord)
		globalThis.crypto.getRandomValues(yCoord)

		const coseKey = new Uint8Array([
			0xa5, // map(5)
			0x01, 0x02, // 1: 2 (kty: EC2)
			0x03, 0x26, // 3: -7 (alg: ES256)
			0x20, 0x01, // -1: 1 (crv: P-256)
			0x21, 0x58, 0x20, // -2: bytes(32)
			...xCoord,
			0x22, 0x58, 0x20, // -3: bytes(32)
			...yCoord,
		])

		// Assemble authData
		const authData = new Uint8Array([
			...rpIdHash,
			flags,
			...signCount,
			...aaguid,
			...credentialIdLength,
			...credentialId,
			...coseKey,
		])

		// Build CBOR attestation object:
		// { "fmt": "none", "attStmt": {}, "authData": <bytes> }
		// We encode authData length carefully for CBOR byte string
		const authDataLengthBytes = encodeLength(authData.length)
		const attestationCbor = new Uint8Array([
			0xa3, // map(3)
			// "fmt"
			0x63, 0x66, 0x6d, 0x74,
			// "none"
			0x64, 0x6e, 0x6f, 0x6e, 0x65,
			// "attStmt"
			0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74,
			// {}
			0xa0,
			// "authData"
			0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61,
			// byte string header
			...authDataLengthBytes,
			// authData bytes
			...authData,
		])

		const credentialIdBase64 = toBase64Url(credentialId.buffer)
		const publicKeyBase64 = toBase64Url(coseKey.buffer)

		const result = await verifyRegistrationResponse({
			credential: {
				credentialId: credentialIdBase64,
				publicKey: publicKeyBase64,
				clientDataJSON: toBase64Url(
					new TextEncoder().encode(clientData).buffer,
				),
				attestationObject: toBase64Url(attestationCbor.buffer),
			},
			expectedChallenge,
			expectedOrigin,
			expectedRpId,
		})

		expect(result.verified).toBe(true)
		expect(result.credentialId).toBe(credentialIdBase64)
		expect(result.publicKey).toBe(publicKeyBase64)
		expect(result.signCount).toBe(1)
	})

	test('rejects when RP ID hash does not match', async () => {
		const expectedChallenge = 'dGVzdA'
		const expectedOrigin = 'https://example.com'

		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: expectedChallenge,
			origin: expectedOrigin,
		})

		// Use wrong rpIdHash (all zeros)
		const wrongRpIdHash = new Uint8Array(32)

		const authData = new Uint8Array([
			...wrongRpIdHash,
			0x41, // flags: UP | AT
			0x00, 0x00, 0x00, 0x00, // signCount
			...new Uint8Array(16), // aaguid
			0x00, 0x10, // credentialIdLength = 16
			...new Uint8Array(16), // credentialId
			0xa0, // empty COSE key (will fail before we check this)
		])

		const authDataLengthBytes = encodeLength(authData.length)
		const attestationCbor = new Uint8Array([
			0xa3,
			0x63, 0x66, 0x6d, 0x74,
			0x64, 0x6e, 0x6f, 0x6e, 0x65,
			0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74,
			0xa0,
			0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61,
			...authDataLengthBytes,
			...authData,
		])

		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					attestationObject: toBase64Url(attestationCbor.buffer),
				},
				expectedChallenge,
				expectedOrigin,
				expectedRpId: 'example.com',
			}),
		).rejects.toThrow('RP ID hash mismatch')
	})

	test('rejects when User Present flag is not set', async () => {
		const expectedChallenge = 'dGVzdA'
		const expectedOrigin = 'https://example.com'
		const expectedRpId = 'example.com'

		const clientData = JSON.stringify({
			type: 'webauthn.create',
			challenge: expectedChallenge,
			origin: expectedOrigin,
		})

		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(expectedRpId),
			),
		)

		// Flags: AT set (0x40) but UP NOT set
		const authData = new Uint8Array([
			...rpIdHash,
			0x40, // flags: AT only, no UP
			0x00, 0x00, 0x00, 0x00,
			...new Uint8Array(16),
			0x00, 0x10,
			...new Uint8Array(16),
			0xa0,
		])

		const authDataLengthBytes = encodeLength(authData.length)
		const attestationCbor = new Uint8Array([
			0xa3,
			0x63, 0x66, 0x6d, 0x74,
			0x64, 0x6e, 0x6f, 0x6e, 0x65,
			0x67, 0x61, 0x74, 0x74, 0x53, 0x74, 0x6d, 0x74,
			0xa0,
			0x68, 0x61, 0x75, 0x74, 0x68, 0x44, 0x61, 0x74, 0x61,
			...authDataLengthBytes,
			...authData,
		])

		await expect(
			verifyRegistrationResponse({
				credential: {
					credentialId: 'test-id',
					publicKey: 'test-key',
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					attestationObject: toBase64Url(attestationCbor.buffer),
				},
				expectedChallenge,
				expectedOrigin,
				expectedRpId,
			}),
		).rejects.toThrow('User Present flag is not set')
	})
})

// ============================================================================
// verifyAuthenticationResponse
// ============================================================================

describe('verifyAuthenticationResponse', () => {
	test('rejects malformed clientDataJSON', async () => {
		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(new Uint8Array(37).buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode('not json').buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'test',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 0,
			}),
		).rejects.toThrow(PasskeyVerificationError)
	})

	test('rejects wrong clientData type', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.create', // wrong type for authentication
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(new Uint8Array(37).buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 0,
			}),
		).rejects.toThrow('Expected clientData.type "webauthn.get"')
	})

	test('rejects challenge mismatch', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: 'wrong-challenge',
			origin: 'https://example.com',
		})

		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(new Uint8Array(37).buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'expected-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 0,
			}),
		).rejects.toThrow('Challenge mismatch')
	})

	test('rejects origin mismatch', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: 'test-challenge',
			origin: 'https://evil.com',
		})

		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(new Uint8Array(37).buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 0,
			}),
		).rejects.toThrow('Origin mismatch')
	})

	test('rejects when RP ID hash does not match', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		// authData with wrong rpIdHash (all zeros) + UP flag + zero signCount
		const wrongAuthData = new Uint8Array(37)
		wrongAuthData[32] = 0x01 // UP flag

		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(wrongAuthData.buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 0,
			}),
		).rejects.toThrow('RP ID hash mismatch')
	})

	test('rejects when User Present flag is not set', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode('example.com'),
			),
		)

		// Construct authData with correct rpIdHash but no UP flag
		const authData = new Uint8Array(37)
		authData.set(rpIdHash, 0)
		authData[32] = 0x00 // no flags set

		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(authData.buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 0,
			}),
		).rejects.toThrow('User Present flag is not set')
	})

	test('rejects when sign count does not increase (cloned authenticator detection)', async () => {
		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode('example.com'),
			),
		)

		// Construct authData with sign count = 5
		const authData = new Uint8Array(37)
		authData.set(rpIdHash, 0)
		authData[32] = 0x01 // UP flag
		// signCount = 5 (big-endian at bytes 33-36)
		authData[33] = 0x00
		authData[34] = 0x00
		authData[35] = 0x00
		authData[36] = 0x05

		await expect(
			verifyAuthenticationResponse({
				assertion: {
					credentialId: 'test-id',
					authenticatorData: toBase64Url(authData.buffer),
					clientDataJSON: toBase64Url(
						new TextEncoder().encode(clientData).buffer,
					),
					signature: toBase64Url(new Uint8Array(64).buffer),
					userHandle: null,
				},
				expectedChallenge: 'test-challenge',
				expectedOrigin: 'https://example.com',
				expectedRpId: 'example.com',
				publicKey: 'test-key',
				previousSignCount: 10, // Previous is 10, received is 5 => cloned
			}),
		).rejects.toThrow('Signature counter did not increase')
	})

	test('allows sign count of 0 when previous was also 0 (counter not supported)', async () => {
		// When both are 0, the authenticator doesn't support counters.
		// The check should be skipped, and verification continues to signature check.
		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: 'test-challenge',
			origin: 'https://example.com',
		})

		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode('example.com'),
			),
		)

		// authData with signCount = 0, UP flag
		const authData = new Uint8Array(37)
		authData.set(rpIdHash, 0)
		authData[32] = 0x01

		// Use a real key pair so the COSE key contains valid EC point coordinates
		const keyPair = await globalThis.crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			true,
			['sign', 'verify'],
		)
		const rawPub = new Uint8Array(
			await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey),
		)
		const xCoord = rawPub.slice(1, 33)
		const yCoord = rawPub.slice(33, 65)

		const coseKey = new Uint8Array([
			0xa5,
			0x01, 0x02,
			0x03, 0x26,
			0x20, 0x01,
			0x21, 0x58, 0x20,
			...xCoord,
			0x22, 0x58, 0x20,
			...yCoord,
		])

		// Build a valid DER-encoded signature (but for wrong data, so verification fails).
		// DER format: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
		const fakeR = new Uint8Array(32)
		const fakeS = new Uint8Array(32)
		fakeR[0] = 0x01
		fakeS[0] = 0x01
		const derSignature = new Uint8Array([
			0x30, 68, // SEQUENCE, length 68
			0x02, 32, ...fakeR, // INTEGER r (32 bytes)
			0x02, 32, ...fakeS, // INTEGER s (32 bytes)
		])

		// This will get past counter check but fail at signature verification
		// (since we're using a bogus signature).
		// We just verify it doesn't throw about the counter.
		const result = await verifyAuthenticationResponse({
			assertion: {
				credentialId: 'test-id',
				authenticatorData: toBase64Url(authData.buffer),
				clientDataJSON: toBase64Url(
					new TextEncoder().encode(clientData).buffer,
				),
				signature: toBase64Url(derSignature.buffer),
				userHandle: null,
			},
			expectedChallenge: 'test-challenge',
			expectedOrigin: 'https://example.com',
			expectedRpId: 'example.com',
			publicKey: toBase64Url(coseKey.buffer),
			previousSignCount: 0,
		})

		// Should reach signature verification and fail (signature won't match)
		expect(result.verified).toBe(false)
	})

	test('verifies a valid authentication with real crypto', async () => {
		// Generate a real ECDSA P-256 key pair for end-to-end verification
		const keyPair = await globalThis.crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			true,
			['sign', 'verify'],
		)

		// Export the public key in raw format to get x, y coordinates
		const rawPublicKey = new Uint8Array(
			await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey),
		)
		// Raw format: 0x04 || x(32) || y(32)
		const xCoord = rawPublicKey.slice(1, 33)
		const yCoord = rawPublicKey.slice(33, 65)

		// Build COSE key
		const coseKey = new Uint8Array([
			0xa5,
			0x01, 0x02, // kty: EC2
			0x03, 0x26, // alg: ES256
			0x20, 0x01, // crv: P-256
			0x21, 0x58, 0x20, ...xCoord, // x
			0x22, 0x58, 0x20, ...yCoord, // y
		])

		const expectedChallenge = 'dGVzdC1jaGFsbGVuZ2U'
		const expectedOrigin = 'https://example.com'
		const expectedRpId = 'example.com'

		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: expectedChallenge,
			origin: expectedOrigin,
		})
		const clientDataBytes = new TextEncoder().encode(clientData)

		// Build authenticator data
		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(expectedRpId),
			),
		)
		const authData = new Uint8Array(37)
		authData.set(rpIdHash, 0)
		authData[32] = 0x01 // UP flag
		// signCount = 1
		authData[36] = 0x01

		// The signed data is: authData || SHA-256(clientDataJSON)
		const clientDataHash = new Uint8Array(
			await globalThis.crypto.subtle.digest('SHA-256', clientDataBytes),
		)
		const signedData = new Uint8Array(
			authData.length + clientDataHash.length,
		)
		signedData.set(authData, 0)
		signedData.set(clientDataHash, authData.length)

		// Sign with the private key.
		// Web Crypto in Node.js produces IEEE P1363 format (r || s, 64 bytes for P-256).
		// Real WebAuthn authenticators produce ASN.1 DER format.
		// Convert P1363 to DER to simulate what a real authenticator would produce.
		const p1363Signature = new Uint8Array(
			await globalThis.crypto.subtle.sign(
				{ name: 'ECDSA', hash: { name: 'SHA-256' } },
				keyPair.privateKey,
				signedData.buffer,
			),
		)
		const derSignature = p1363ToDer(p1363Signature, 32)

		const result = await verifyAuthenticationResponse({
			assertion: {
				credentialId: 'test-cred-id',
				authenticatorData: toBase64Url(authData.buffer),
				clientDataJSON: toBase64Url(clientDataBytes.buffer),
				signature: toBase64Url(derSignature.buffer),
				userHandle: null,
			},
			expectedChallenge,
			expectedOrigin,
			expectedRpId,
			publicKey: toBase64Url(coseKey.buffer),
			previousSignCount: 0,
		})

		expect(result.verified).toBe(true)
		expect(result.newSignCount).toBe(1)
	})

	test('rejects an invalid signature', async () => {
		// Generate a real key pair
		const keyPair = await globalThis.crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			true,
			['sign', 'verify'],
		)

		const rawPublicKey = new Uint8Array(
			await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey),
		)
		const xCoord = rawPublicKey.slice(1, 33)
		const yCoord = rawPublicKey.slice(33, 65)

		const coseKey = new Uint8Array([
			0xa5,
			0x01, 0x02,
			0x03, 0x26,
			0x20, 0x01,
			0x21, 0x58, 0x20, ...xCoord,
			0x22, 0x58, 0x20, ...yCoord,
		])

		const expectedChallenge = 'dGVzdA'
		const expectedOrigin = 'https://example.com'
		const expectedRpId = 'example.com'

		const clientData = JSON.stringify({
			type: 'webauthn.get',
			challenge: expectedChallenge,
			origin: expectedOrigin,
		})
		const clientDataBytes = new TextEncoder().encode(clientData)

		const rpIdHash = new Uint8Array(
			await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(expectedRpId),
			),
		)
		const authData = new Uint8Array(37)
		authData.set(rpIdHash, 0)
		authData[32] = 0x01
		authData[36] = 0x01

		// Sign with the correct key but then tamper with the data
		const signedData = new Uint8Array(37 + 32)
		signedData.set(authData, 0)
		const clientDataHash = new Uint8Array(
			await globalThis.crypto.subtle.digest('SHA-256', clientDataBytes),
		)
		signedData.set(clientDataHash, 37)

		// Sign different data to create an invalid signature for the actual data
		const wrongData = new Uint8Array(signedData.length)
		wrongData.set(signedData)
		wrongData[0] = 0xff // tamper with rpIdHash

		const wrongP1363 = new Uint8Array(
			await globalThis.crypto.subtle.sign(
				{ name: 'ECDSA', hash: { name: 'SHA-256' } },
				keyPair.privateKey,
				wrongData.buffer,
			),
		)
		const wrongDerSignature = p1363ToDer(wrongP1363, 32)

		const result = await verifyAuthenticationResponse({
			assertion: {
				credentialId: 'test-cred-id',
				authenticatorData: toBase64Url(authData.buffer),
				clientDataJSON: toBase64Url(clientDataBytes.buffer),
				signature: toBase64Url(wrongDerSignature.buffer),
				userHandle: null,
			},
			expectedChallenge,
			expectedOrigin,
			expectedRpId,
			publicKey: toBase64Url(coseKey.buffer),
			previousSignCount: 0,
		})

		expect(result.verified).toBe(false)
	})
})

// ============================================================================
// Challenge randomness validation
// ============================================================================

describe('challenge cryptographic randomness', () => {
	test('registration challenges have sufficient entropy (32 bytes)', () => {
		const challenges = new Set<string>()
		for (let i = 0; i < 100; i++) {
			const options = generateRegistrationOptions({
				rpId: 'example.com',
				rpName: 'Test',
				userId: 'user-1',
				userName: 'test@example.com',
				userDisplayName: 'Test',
			})
			challenges.add(options.challenge)
		}
		// All 100 should be unique
		expect(challenges.size).toBe(100)
	})

	test('authentication challenges have sufficient entropy (32 bytes)', () => {
		const challenges = new Set<string>()
		for (let i = 0; i < 100; i++) {
			const options = generateAuthenticationOptions({ rpId: 'example.com' })
			challenges.add(options.challenge)
		}
		expect(challenges.size).toBe(100)
	})
})

// ============================================================================
// Helper: encode CBOR byte string length prefix
// ============================================================================

/**
 * Encode the CBOR byte string header (major type 2) for the given length.
 * Returns the header bytes (1-3 bytes depending on length).
 */
function encodeLength(length: number): Uint8Array {
	if (length < 24) {
		return new Uint8Array([0x40 | length])
	} else if (length < 256) {
		return new Uint8Array([0x58, length])
	} else if (length < 65536) {
		return new Uint8Array([0x59, (length >> 8) & 0xff, length & 0xff])
	}
	throw new Error(`Length ${length} exceeds supported CBOR encoding`)
}
