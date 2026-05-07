import { randomBytes } from 'node:crypto'
import { KoraError } from '@korajs/core'
import { fromBase64Url, toBase64Url } from '../device/device-identity'
import { decodeCbor } from './passkey-client'

// ============================================================================
// Server-side passkey errors
// ============================================================================

/**
 * Thrown when server-side passkey verification fails.
 */
export class PasskeyVerificationError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'PASSKEY_VERIFICATION_ERROR', context)
		this.name = 'PasskeyVerificationError'
	}
}

// ============================================================================
// Registration options generation
// ============================================================================

/** Options returned by generateRegistrationOptions for the client. */
export interface RegistrationOptions {
	/** Base64url-encoded random challenge (32 bytes) */
	challenge: string
	/** Relying party ID (domain) */
	rpId: string
	/** Relying party display name */
	rpName: string
	/** Base64url-encoded user ID */
	userId: string
	/** User's email or username */
	userName: string
	/** Human-readable display name */
	userDisplayName: string
	/** Credential IDs to exclude (prevents re-registration) */
	excludeCredentialIds: string[]
	/** Authenticator selection criteria */
	authenticatorSelection: {
		authenticatorAttachment: 'platform'
		residentKey: 'preferred'
		userVerification: 'required'
	}
	/** Timeout in milliseconds */
	timeout: number
}

/**
 * Generate registration options for creating a new passkey.
 *
 * Creates a cryptographically random challenge and assembles the options
 * object that should be sent to the client for `createPasskeyCredential()`.
 *
 * The server must store the challenge (keyed by user session or similar)
 * for later verification when the client responds.
 *
 * @param params - Registration parameters
 * @param params.rpId - Relying party ID (your domain, e.g. "example.com")
 * @param params.rpName - Relying party display name
 * @param params.userId - Unique user identifier
 * @param params.userName - User's email or username
 * @param params.userDisplayName - Human-readable display name
 * @param params.existingCredentialIds - Base64url credential IDs to exclude
 * @returns Registration options to send to the client, including the challenge
 *
 * @example
 * ```typescript
 * const options = generateRegistrationOptions({
 *   rpId: 'example.com',
 *   rpName: 'My App',
 *   userId: user.id,
 *   userName: user.email,
 *   userDisplayName: user.name,
 * })
 * // Store options.challenge in session for later verification
 * // Send options to client
 * ```
 */
export function generateRegistrationOptions(params: {
	rpId: string
	rpName: string
	userId: string
	userName: string
	userDisplayName: string
	existingCredentialIds?: string[]
}): RegistrationOptions {
	// Generate a 32-byte cryptographically random challenge
	const challengeBytes = randomBytes(32)
	const challenge = toBase64Url(challengeBytes.buffer.slice(
		challengeBytes.byteOffset,
		challengeBytes.byteOffset + challengeBytes.byteLength,
	))

	return {
		challenge,
		rpId: params.rpId,
		rpName: params.rpName,
		userId: params.userId,
		userName: params.userName,
		userDisplayName: params.userDisplayName,
		excludeCredentialIds: params.existingCredentialIds ?? [],
		authenticatorSelection: {
			authenticatorAttachment: 'platform',
			residentKey: 'preferred',
			userVerification: 'required',
		},
		timeout: 60000,
	}
}

// ============================================================================
// Registration verification
// ============================================================================

/** Result of verifying a registration response. */
export interface RegistrationVerificationResult {
	/** Whether the registration response was verified successfully */
	verified: boolean
	/** Base64url-encoded credential ID */
	credentialId: string
	/** Base64url-encoded COSE public key (store this for future authentication) */
	publicKey: string
	/** Initial signature counter from the authenticator */
	signCount: number
}

/**
 * Verify a registration response from the client.
 *
 * Validates the attestation object and clientDataJSON returned by the browser's
 * `navigator.credentials.create()` call. Extracts and returns the public key
 * and credential ID to store in your database.
 *
 * This implementation supports the "none" attestation format, which is the most
 * common and does not require trust in any attestation CA. For higher assurance
 * scenarios, extend this to verify packed/tpm/android attestation formats.
 *
 * @param params - Verification parameters
 * @param params.credential - The credential response from the client
 * @param params.expectedChallenge - The challenge that was sent to the client (base64url)
 * @param params.expectedOrigin - The expected origin (e.g. "https://example.com")
 * @param params.expectedRpId - The expected relying party ID (e.g. "example.com")
 * @returns Verification result with the credential ID and public key to store
 * @throws {PasskeyVerificationError} If the response is invalid or tampered with
 *
 * @example
 * ```typescript
 * const result = await verifyRegistrationResponse({
 *   credential: clientResponse,
 *   expectedChallenge: storedChallenge,
 *   expectedOrigin: 'https://example.com',
 *   expectedRpId: 'example.com',
 * })
 * if (result.verified) {
 *   // Store result.credentialId, result.publicKey, result.signCount
 * }
 * ```
 */
export async function verifyRegistrationResponse(params: {
	credential: {
		credentialId: string
		publicKey: string
		clientDataJSON: string
		attestationObject: string
	}
	expectedChallenge: string
	expectedOrigin: string
	expectedRpId: string
}): Promise<RegistrationVerificationResult> {
	const { credential, expectedChallenge, expectedOrigin, expectedRpId } = params

	// Step 1: Decode and verify clientDataJSON
	const clientDataBytes = fromBase64Url(credential.clientDataJSON)
	const clientDataText = new TextDecoder().decode(clientDataBytes)
	let clientData: { type: string; challenge: string; origin: string }
	try {
		clientData = JSON.parse(clientDataText) as {
			type: string
			challenge: string
			origin: string
		}
	} catch {
		throw new PasskeyVerificationError(
			'Failed to parse clientDataJSON. The response may be malformed.',
		)
	}

	// Verify the type is "webauthn.create"
	if (clientData.type !== 'webauthn.create') {
		throw new PasskeyVerificationError(
			`Expected clientData.type "webauthn.create" but received "${clientData.type}".`,
			{ type: clientData.type },
		)
	}

	// Verify the challenge matches what we sent
	if (clientData.challenge !== expectedChallenge) {
		throw new PasskeyVerificationError(
			'Challenge mismatch. The response does not match the expected challenge. ' +
				'This may indicate a replay attack or session mismatch.',
		)
	}

	// Verify the origin matches
	if (clientData.origin !== expectedOrigin) {
		throw new PasskeyVerificationError(
			`Origin mismatch. Expected "${expectedOrigin}" but received "${clientData.origin}".`,
			{ expected: expectedOrigin, received: clientData.origin },
		)
	}

	// Step 2: Decode the attestation object (CBOR)
	const attestationBytes = fromBase64Url(credential.attestationObject)
	const attestationResult = decodeCbor(attestationBytes, 0)
	const attestationMap = attestationResult.value as Map<string, unknown>

	// Verify attestation format
	const fmt = attestationMap.get('fmt')
	if (fmt !== 'none') {
		// For Phase 3, we only support "none" attestation.
		// Other formats (packed, tpm, android-key, etc.) can be added later.
		throw new PasskeyVerificationError(
			`Unsupported attestation format "${String(fmt)}". Only "none" attestation is currently supported.`,
			{ format: String(fmt) },
		)
	}

	// Step 3: Parse the authenticator data
	const authData = attestationMap.get('authData')
	if (!(authData instanceof Uint8Array)) {
		throw new PasskeyVerificationError(
			'Invalid attestation object: authData is missing or not a byte string.',
		)
	}

	// Verify the RP ID hash (first 32 bytes of authData)
	const rpIdHash = authData.slice(0, 32)
	const expectedRpIdHash = await sha256(new TextEncoder().encode(expectedRpId))
	if (!constantTimeEqual(rpIdHash, new Uint8Array(expectedRpIdHash))) {
		throw new PasskeyVerificationError(
			'RP ID hash mismatch. The authenticator data does not match the expected relying party.',
		)
	}

	// Parse flags (byte 32)
	const flags = authData[32] as number

	// Bit 0: User Present (UP) - must be set
	if ((flags & 0x01) === 0) {
		throw new PasskeyVerificationError(
			'User Present flag is not set in authenticator data. ' +
				'The authenticator did not confirm user presence.',
		)
	}

	// Bit 6: Attested Credential Data (AT) - must be set for registration
	if ((flags & 0x40) === 0) {
		throw new PasskeyVerificationError(
			'Attested Credential Data flag is not set. ' +
				'The authenticator did not include credential data.',
		)
	}

	// Parse sign count (bytes 33-36, big-endian uint32)
	const signCount =
		((authData[33] as number) << 24) |
		((authData[34] as number) << 16) |
		((authData[35] as number) << 8) |
		(authData[36] as number)

	// Parse attested credential data
	// Skip rpIdHash (32) + flags (1) + signCount (4) = 37 bytes
	let offset = 37

	// aaguid: 16 bytes (we skip it — not needed for "none" attestation)
	offset += 16

	// credentialIdLength: 2 bytes, big-endian
	const credentialIdLength =
		((authData[offset] as number) << 8) | (authData[offset + 1] as number)
	offset += 2

	// credentialId: credentialIdLength bytes
	const credentialIdBytes = authData.slice(offset, offset + credentialIdLength)
	offset += credentialIdLength

	// Verify the credential ID matches what the client sent
	const expectedCredentialId = toBase64Url(credentialIdBytes.buffer as unknown as ArrayBuffer)
	if (expectedCredentialId !== credential.credentialId) {
		throw new PasskeyVerificationError(
			'Credential ID mismatch between attestation object and client response.',
		)
	}

	// The remaining bytes are the COSE-encoded public key
	const coseKeyResult = decodeCbor(authData, offset)
	const coseKeyBytes = authData.slice(offset, coseKeyResult.offset)

	// Verify the public key matches what the client sent
	const publicKeyFromAttestation = toBase64Url(coseKeyBytes.buffer as unknown as ArrayBuffer)
	if (publicKeyFromAttestation !== credential.publicKey) {
		throw new PasskeyVerificationError(
			'Public key mismatch between attestation object and client response.',
		)
	}

	return {
		verified: true,
		credentialId: credential.credentialId,
		publicKey: credential.publicKey,
		signCount: signCount >>> 0,
	}
}

// ============================================================================
// Authentication options generation
// ============================================================================

/** Options returned by generateAuthenticationOptions for the client. */
export interface AuthenticationOptions {
	/** Base64url-encoded random challenge (32 bytes) */
	challenge: string
	/** Relying party ID */
	rpId: string
	/** Credential IDs to allow (limit to specific credentials) */
	allowCredentialIds?: string[]
	/** User verification requirement */
	userVerification: 'preferred'
	/** Timeout in milliseconds */
	timeout: number
}

/**
 * Generate authentication options for signing in with a passkey.
 *
 * Creates a cryptographically random challenge and assembles the options
 * object that should be sent to the client for `authenticateWithPasskey()`.
 *
 * The server must store the challenge for later verification.
 *
 * @param params - Authentication parameters
 * @param params.rpId - Relying party ID (your domain)
 * @param params.allowCredentialIds - Base64url credential IDs to allow (optional)
 * @returns Authentication options to send to the client
 *
 * @example
 * ```typescript
 * const options = generateAuthenticationOptions({
 *   rpId: 'example.com',
 *   allowCredentialIds: user.credentialIds,
 * })
 * // Store options.challenge in session
 * // Send options to client
 * ```
 */
export function generateAuthenticationOptions(params: {
	rpId: string
	allowCredentialIds?: string[]
}): AuthenticationOptions {
	const challengeBytes = randomBytes(32)
	const challenge = toBase64Url(challengeBytes.buffer.slice(
		challengeBytes.byteOffset,
		challengeBytes.byteOffset + challengeBytes.byteLength,
	))

	return {
		challenge,
		rpId: params.rpId,
		allowCredentialIds: params.allowCredentialIds,
		userVerification: 'preferred',
		timeout: 60000,
	}
}

// ============================================================================
// Authentication verification
// ============================================================================

/** Result of verifying an authentication response. */
export interface AuthenticationVerificationResult {
	/** Whether the authentication response was verified successfully */
	verified: boolean
	/** Updated signature counter (store this to detect cloned authenticators) */
	newSignCount: number
}

/**
 * Verify an authentication response from the client.
 *
 * Validates the signed assertion returned by the browser's
 * `navigator.credentials.get()` call. Checks the signature against the
 * stored public key, verifies the challenge and origin, and validates
 * the signature counter to detect cloned authenticators.
 *
 * This implementation supports ECDSA P-256 (ES256, COSE algorithm -7)
 * signatures, which is the most common algorithm used by platform
 * authenticators (Touch ID, Face ID, Windows Hello).
 *
 * @param params - Verification parameters
 * @param params.assertion - The assertion response from the client
 * @param params.expectedChallenge - The challenge that was sent to the client (base64url)
 * @param params.expectedOrigin - The expected origin (e.g. "https://example.com")
 * @param params.expectedRpId - The expected relying party ID
 * @param params.publicKey - The stored COSE public key (base64url, from registration)
 * @param params.previousSignCount - The previously stored signature counter
 * @returns Verification result with the new signature counter
 * @throws {PasskeyVerificationError} If the assertion is invalid
 *
 * @example
 * ```typescript
 * const result = await verifyAuthenticationResponse({
 *   assertion: clientAssertion,
 *   expectedChallenge: storedChallenge,
 *   expectedOrigin: 'https://example.com',
 *   expectedRpId: 'example.com',
 *   publicKey: storedCredential.publicKey,
 *   previousSignCount: storedCredential.signCount,
 * })
 * if (result.verified) {
 *   // Update stored sign count: storedCredential.signCount = result.newSignCount
 *   // Issue session tokens
 * }
 * ```
 */
export async function verifyAuthenticationResponse(params: {
	assertion: {
		credentialId: string
		authenticatorData: string
		clientDataJSON: string
		signature: string
		userHandle: string | null
	}
	expectedChallenge: string
	expectedOrigin: string
	expectedRpId: string
	publicKey: string
	previousSignCount: number
}): Promise<AuthenticationVerificationResult> {
	const {
		assertion,
		expectedChallenge,
		expectedOrigin,
		expectedRpId,
		publicKey,
		previousSignCount,
	} = params

	// Step 1: Decode and verify clientDataJSON
	const clientDataBytes = fromBase64Url(assertion.clientDataJSON)
	const clientDataText = new TextDecoder().decode(clientDataBytes)
	let clientData: { type: string; challenge: string; origin: string }
	try {
		clientData = JSON.parse(clientDataText) as {
			type: string
			challenge: string
			origin: string
		}
	} catch {
		throw new PasskeyVerificationError(
			'Failed to parse clientDataJSON. The assertion may be malformed.',
		)
	}

	// Verify the type is "webauthn.get"
	if (clientData.type !== 'webauthn.get') {
		throw new PasskeyVerificationError(
			`Expected clientData.type "webauthn.get" but received "${clientData.type}".`,
			{ type: clientData.type },
		)
	}

	// Verify the challenge matches
	if (clientData.challenge !== expectedChallenge) {
		throw new PasskeyVerificationError(
			'Challenge mismatch. The assertion does not match the expected challenge.',
		)
	}

	// Verify the origin matches
	if (clientData.origin !== expectedOrigin) {
		throw new PasskeyVerificationError(
			`Origin mismatch. Expected "${expectedOrigin}" but received "${clientData.origin}".`,
			{ expected: expectedOrigin, received: clientData.origin },
		)
	}

	// Step 2: Parse authenticator data
	const authDataBytes = fromBase64Url(assertion.authenticatorData)

	// Verify RP ID hash (first 32 bytes)
	const rpIdHash = authDataBytes.slice(0, 32)
	const expectedRpIdHash = await sha256(new TextEncoder().encode(expectedRpId))
	if (!constantTimeEqual(rpIdHash, new Uint8Array(expectedRpIdHash))) {
		throw new PasskeyVerificationError(
			'RP ID hash mismatch. The authenticator data does not match the expected relying party.',
		)
	}

	// Parse flags (byte 32)
	const flags = authDataBytes[32] as number

	// Bit 0: User Present (UP) - must be set
	if ((flags & 0x01) === 0) {
		throw new PasskeyVerificationError(
			'User Present flag is not set in authenticator data.',
		)
	}

	// Parse sign count (bytes 33-36, big-endian uint32)
	const signCount =
		(((authDataBytes[33] as number) << 24) |
			((authDataBytes[34] as number) << 16) |
			((authDataBytes[35] as number) << 8) |
			(authDataBytes[36] as number)) >>>
		0

	// Step 3: Validate sign count to detect cloned authenticators
	// If both are 0, the authenticator doesn't support counters — skip check.
	// If the new count is not greater than the previous, it may be cloned.
	if (previousSignCount > 0 || signCount > 0) {
		if (signCount <= previousSignCount) {
			throw new PasskeyVerificationError(
				'Signature counter did not increase. This may indicate a cloned authenticator. ' +
					`Previous count: ${previousSignCount}, received count: ${signCount}.`,
				{
					previousSignCount,
					receivedSignCount: signCount,
				},
			)
		}
	}

	// Step 4: Verify the signature
	// The signature is over: authData || SHA-256(clientDataJSON)
	const clientDataHash = await sha256(clientDataBytes)
	const signedData = new Uint8Array(
		authDataBytes.length + clientDataHash.byteLength,
	)
	signedData.set(authDataBytes, 0)
	signedData.set(new Uint8Array(clientDataHash), authDataBytes.length)

	// Decode the COSE public key to get the raw EC key parameters
	const coseKeyBytes = fromBase64Url(publicKey)
	const coseKeyResult = decodeCbor(coseKeyBytes, 0)
	const coseKeyMap = coseKeyResult.value as Map<number, unknown>

	// COSE key map labels:
	// 1: kty (key type) — 2 = EC2
	// 3: alg (algorithm) — -7 = ES256
	// -1: crv (curve) — 1 = P-256
	// -2: x coordinate (byte string, 32 bytes)
	// -3: y coordinate (byte string, 32 bytes)

	const kty = coseKeyMap.get(1)
	const alg = coseKeyMap.get(3)

	if (kty !== 2) {
		throw new PasskeyVerificationError(
			`Unsupported COSE key type ${String(kty)}. Only EC2 (kty=2) is supported.`,
			{ kty: String(kty) },
		)
	}

	if (alg !== -7) {
		throw new PasskeyVerificationError(
			`Unsupported COSE algorithm ${String(alg)}. Only ES256 (alg=-7) is supported.`,
			{ alg: String(alg) },
		)
	}

	const xCoord = coseKeyMap.get(-2) as Uint8Array
	const yCoord = coseKeyMap.get(-3) as Uint8Array

	if (
		!(xCoord instanceof Uint8Array) ||
		!(yCoord instanceof Uint8Array) ||
		xCoord.length !== 32 ||
		yCoord.length !== 32
	) {
		throw new PasskeyVerificationError(
			'Invalid COSE public key: x and y coordinates must be 32-byte arrays.',
		)
	}

	// Import the public key as an ECDSA P-256 key for verification.
	// We use the "raw" format: 0x04 || x || y (uncompressed point).
	const rawPublicKey = new Uint8Array(65)
	rawPublicKey[0] = 0x04 // Uncompressed point indicator
	rawPublicKey.set(xCoord, 1)
	rawPublicKey.set(yCoord, 33)

	let cryptoKey: CryptoKey
	try {
		cryptoKey = await globalThis.crypto.subtle.importKey(
			'raw',
			rawPublicKey.buffer as unknown as ArrayBuffer,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		)
	} catch (error) {
		throw new PasskeyVerificationError(
			'Failed to import COSE public key for signature verification.',
			{ cause: error instanceof Error ? error.message : String(error) },
		)
	}

	// The WebAuthn signature is in ASN.1 DER format.
	// Web Crypto's ECDSA verify expects the signature in IEEE P1363 format (r || s).
	// Convert from DER to P1363.
	const signatureBytes = fromBase64Url(assertion.signature)
	const p1363Signature = derToP1363(signatureBytes, 32)

	let verified: boolean
	try {
		verified = await globalThis.crypto.subtle.verify(
			{ name: 'ECDSA', hash: { name: 'SHA-256' } },
			cryptoKey,
			p1363Signature.buffer as unknown as ArrayBuffer,
			signedData.buffer as unknown as ArrayBuffer,
		)
	} catch (error) {
		throw new PasskeyVerificationError(
			'Signature verification operation failed.',
			{ cause: error instanceof Error ? error.message : String(error) },
		)
	}

	if (!verified) {
		return { verified: false, newSignCount: signCount }
	}

	return { verified: true, newSignCount: signCount }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Compute SHA-256 hash of the given data using Web Crypto API.
 */
async function sha256(data: Uint8Array): Promise<ArrayBuffer> {
	return globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
}

/**
 * Constant-time comparison of two byte arrays.
 * Prevents timing attacks when comparing hashes or signatures.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false
	}
	let result = 0
	for (let i = 0; i < a.length; i++) {
		result |= (a[i] as number) ^ (b[i] as number)
	}
	return result === 0
}

/**
 * Convert an ASN.1 DER-encoded ECDSA signature to IEEE P1363 format.
 *
 * DER format: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 * P1363 format: <r-padded-to-n-bytes> <s-padded-to-n-bytes>
 *
 * This conversion is necessary because WebAuthn authenticators produce
 * DER-encoded signatures, but the Web Crypto API expects P1363 format.
 *
 * @param derSignature - The DER-encoded signature bytes
 * @param componentLength - The expected length of each component (32 for P-256)
 * @returns The P1363-formatted signature
 */
function derToP1363(
	derSignature: Uint8Array,
	componentLength: number,
): Uint8Array {
	// Parse the DER structure
	let offset = 0

	// SEQUENCE tag (0x30)
	if (derSignature[offset] !== 0x30) {
		throw new PasskeyVerificationError(
			'Invalid DER signature: expected SEQUENCE tag (0x30).',
		)
	}
	offset += 1

	// SEQUENCE length (may be 1 or 2 bytes)
	if ((derSignature[offset] as number) & 0x80) {
		// Long form: the lower 7 bits give the number of length bytes
		const lengthBytes = (derSignature[offset] as number) & 0x7f
		offset += 1 + lengthBytes
	} else {
		offset += 1
	}

	// First INTEGER (r)
	if (derSignature[offset] !== 0x02) {
		throw new PasskeyVerificationError(
			'Invalid DER signature: expected INTEGER tag (0x02) for r component.',
		)
	}
	offset += 1

	const rLength = derSignature[offset] as number
	offset += 1

	const rBytes = derSignature.slice(offset, offset + rLength)
	offset += rLength

	// Second INTEGER (s)
	if (derSignature[offset] !== 0x02) {
		throw new PasskeyVerificationError(
			'Invalid DER signature: expected INTEGER tag (0x02) for s component.',
		)
	}
	offset += 1

	const sLength = derSignature[offset] as number
	offset += 1

	const sBytes = derSignature.slice(offset, offset + sLength)

	// Pad or trim r and s to componentLength bytes.
	// DER integers may have a leading 0x00 byte to indicate positive sign,
	// or may be shorter than componentLength if the leading bytes are zero.
	const result = new Uint8Array(componentLength * 2)
	copyComponentToP1363(rBytes, result, 0, componentLength)
	copyComponentToP1363(sBytes, result, componentLength, componentLength)

	return result
}

/**
 * Copy a DER integer component into a fixed-width P1363 buffer.
 * Handles leading zero padding (DER sign byte) and right-alignment.
 */
function copyComponentToP1363(
	component: Uint8Array,
	target: Uint8Array,
	targetOffset: number,
	componentLength: number,
): void {
	if (component.length === componentLength) {
		// Exact fit
		target.set(component, targetOffset)
	} else if (component.length > componentLength) {
		// DER may have a leading 0x00 sign byte — strip it
		const excess = component.length - componentLength
		target.set(component.slice(excess), targetOffset)
	} else {
		// Component is shorter — right-align with zero padding
		const padding = componentLength - component.length
		target.set(component, targetOffset + padding)
	}
}
