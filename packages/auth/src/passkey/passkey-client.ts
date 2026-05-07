import { KoraError } from '@korajs/core'
import { fromBase64Url, toBase64Url } from '../device/device-identity'

// ============================================================================
// Passkey-specific errors
// ============================================================================

/**
 * Thrown when a passkey operation fails (registration, authentication,
 * or browser API interaction).
 */
export class PasskeyError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'PASSKEY_ERROR', context)
		this.name = 'PasskeyError'
	}
}

/**
 * Thrown when the browser does not support WebAuthn.
 * Passkey authentication requires a modern browser with the
 * Web Authentication API (navigator.credentials).
 */
export class PasskeyUnsupportedError extends KoraError {
	constructor() {
		super(
			'WebAuthn is not supported in this browser. Passkey authentication requires a modern browser with WebAuthn support.',
			'PASSKEY_UNSUPPORTED',
		)
		this.name = 'PasskeyUnsupportedError'
	}
}

// ============================================================================
// Passkey registration response
// ============================================================================

/** Response from a passkey registration (credential creation). */
export interface PasskeyRegistrationResponse {
	/** Base64url-encoded credential ID */
	credentialId: string
	/** Base64url-encoded public key (COSE format) */
	publicKey: string
	/** Base64url-encoded clientDataJSON */
	clientDataJSON: string
	/** Base64url-encoded attestation object */
	attestationObject: string
}

// ============================================================================
// Passkey authentication response
// ============================================================================

/** Response from a passkey authentication (assertion). */
export interface PasskeyAuthenticationResponse {
	/** Base64url-encoded credential ID */
	credentialId: string
	/** Base64url-encoded authenticator data */
	authenticatorData: string
	/** Base64url-encoded clientDataJSON */
	clientDataJSON: string
	/** Base64url-encoded ECDSA signature */
	signature: string
	/** Base64url-encoded user handle (may be null for non-resident keys) */
	userHandle: string | null
}

// ============================================================================
// Feature detection
// ============================================================================

/**
 * Check if WebAuthn/passkeys are supported in the current environment.
 *
 * Returns true if the `navigator.credentials` API is available and supports
 * the `create` and `get` methods required for WebAuthn.
 *
 * @returns `true` if WebAuthn is available, `false` otherwise
 *
 * @example
 * ```typescript
 * if (isPasskeySupported()) {
 *   // Show passkey login option
 * }
 * ```
 */
export function isPasskeySupported(): boolean {
	return (
		typeof globalThis.navigator !== 'undefined' &&
		typeof globalThis.navigator.credentials !== 'undefined' &&
		typeof globalThis.navigator.credentials.create === 'function' &&
		typeof globalThis.navigator.credentials.get === 'function'
	)
}

/**
 * Check if a platform authenticator (biometric) is available.
 *
 * A platform authenticator is built into the device (Touch ID, Face ID,
 * Windows Hello). Returns false if only roaming authenticators (security
 * keys) are available, or if WebAuthn is not supported.
 *
 * @returns `true` if a platform authenticator is available
 *
 * @example
 * ```typescript
 * if (await isPlatformAuthenticatorAvailable()) {
 *   // Show "Sign in with Touch ID" button
 * }
 * ```
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
	if (!isPasskeySupported()) {
		return false
	}

	// PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable is
	// the standard way to check for biometric/platform authenticator support.
	if (
		typeof PublicKeyCredential !== 'undefined' &&
		typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
	) {
		try {
			return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
		} catch {
			return false
		}
	}

	return false
}

// ============================================================================
// Registration (credential creation)
// ============================================================================

/**
 * Create a passkey credential (registration flow).
 *
 * Called during user registration. The server provides a challenge and user info,
 * the browser prompts for biometric verification, and this function returns the
 * credential data to send back to the server for verification.
 *
 * @param options - Registration options from the server
 * @param options.challenge - Base64url-encoded challenge from server
 * @param options.rpId - Relying party ID (your domain, e.g. "example.com")
 * @param options.rpName - Relying party display name (e.g. "My App")
 * @param options.userId - User ID as base64url-encoded opaque bytes
 * @param options.userName - User's email or username for display
 * @param options.userDisplayName - Human-readable display name
 * @param options.excludeCredentialIds - Credential IDs to exclude (prevents re-registration)
 * @param options.authenticatorSelection - Authenticator selection criteria
 * @returns The credential response to send to the server for verification
 * @throws {PasskeyUnsupportedError} If WebAuthn is not available
 * @throws {PasskeyError} If credential creation fails or is cancelled by the user
 *
 * @example
 * ```typescript
 * const credential = await createPasskeyCredential({
 *   challenge: serverOptions.challenge,
 *   rpId: 'example.com',
 *   rpName: 'My App',
 *   userId: serverOptions.userId,
 *   userName: 'alice@example.com',
 *   userDisplayName: 'Alice',
 * })
 * // Send `credential` to server for verification
 * ```
 */
export async function createPasskeyCredential(options: {
	challenge: string
	rpId: string
	rpName: string
	userId: string
	userName: string
	userDisplayName: string
	excludeCredentialIds?: string[]
	authenticatorSelection?: {
		authenticatorAttachment?: 'platform' | 'cross-platform'
		residentKey?: 'required' | 'preferred' | 'discouraged'
		userVerification?: 'required' | 'preferred' | 'discouraged'
	}
}): Promise<PasskeyRegistrationResponse> {
	if (!isPasskeySupported()) {
		throw new PasskeyUnsupportedError()
	}

	// Build the excludeCredentials list from base64url credential IDs
	const excludeCredentials: PublicKeyCredentialDescriptor[] = (
		options.excludeCredentialIds ?? []
	).map((id) => ({
		type: 'public-key' as const,
		id: fromBase64Url(id).buffer as unknown as ArrayBuffer,
	}))

	// Build the authenticator selection criteria with sensible defaults
	const authenticatorSelection: AuthenticatorSelectionCriteria = {
		authenticatorAttachment:
			options.authenticatorSelection?.authenticatorAttachment ?? 'platform',
		residentKey: options.authenticatorSelection?.residentKey ?? 'preferred',
		userVerification:
			options.authenticatorSelection?.userVerification ?? 'required',
	}

	// If residentKey is 'required', requireResidentKey must also be true
	// for backwards compatibility with older browsers.
	if (authenticatorSelection.residentKey === 'required') {
		authenticatorSelection.requireResidentKey = true
	}

	const publicKeyOptions: PublicKeyCredentialCreationOptions = {
		challenge: fromBase64Url(options.challenge).buffer as unknown as ArrayBuffer,
		rp: {
			id: options.rpId,
			name: options.rpName,
		},
		user: {
			id: fromBase64Url(options.userId).buffer as unknown as ArrayBuffer,
			name: options.userName,
			displayName: options.userDisplayName,
		},
		pubKeyCredParams: [
			// ES256 (ECDSA w/ SHA-256) — the most widely supported algorithm
			{ type: 'public-key', alg: -7 },
			// RS256 (RSASSA-PKCS1-v1_5 w/ SHA-256) — fallback for older authenticators
			{ type: 'public-key', alg: -257 },
		],
		excludeCredentials,
		authenticatorSelection,
		timeout: 60000,
		attestation: 'none',
	}

	let credential: PublicKeyCredential
	try {
		const result = await navigator.credentials.create({
			publicKey: publicKeyOptions,
		})

		if (result === null) {
			throw new PasskeyError(
				'Credential creation returned null. The user may have cancelled the operation.',
				{ rpId: options.rpId },
			)
		}

		credential = result as PublicKeyCredential
	} catch (error) {
		if (error instanceof PasskeyError) {
			throw error
		}

		// Map common WebAuthn DOMException names to user-friendly messages
		const domError = error as DOMException
		if (domError.name === 'NotAllowedError') {
			throw new PasskeyError(
				'Passkey creation was cancelled or not allowed. The user may have dismissed the prompt or the operation timed out.',
				{ rpId: options.rpId, errorName: domError.name },
			)
		}
		if (domError.name === 'InvalidStateError') {
			throw new PasskeyError(
				'A passkey already exists for this user on this authenticator. Use the existing passkey to sign in.',
				{ rpId: options.rpId, errorName: domError.name },
			)
		}

		throw new PasskeyError(
			`Passkey creation failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				rpId: options.rpId,
				errorName: error instanceof Error ? error.name : undefined,
			},
		)
	}

	const response = credential.response as AuthenticatorAttestationResponse

	// Extract the public key from the attestation response.
	// getPublicKey() returns the SubjectPublicKeyInfo (SPKI) encoded public key.
	// We also need the raw COSE public key from the attestation for server-side storage.
	// The attestation object contains the credential public key in COSE format.
	const attestationObject = new Uint8Array(response.attestationObject)
	const clientDataJSON = new Uint8Array(response.clientDataJSON)

	// Extract the COSE public key from the authenticator data within the attestation object.
	// The attestation object is CBOR-encoded and contains authData which includes the
	// credential public key in COSE_Key format.
	const publicKeyBytes = extractPublicKeyFromAttestationObject(attestationObject)

	return {
		credentialId: toBase64Url(credential.rawId),
		publicKey: toBase64Url(publicKeyBytes.buffer as unknown as ArrayBuffer),
		clientDataJSON: toBase64Url(clientDataJSON.buffer as unknown as ArrayBuffer),
		attestationObject: toBase64Url(attestationObject.buffer as unknown as ArrayBuffer),
	}
}

// ============================================================================
// Authentication (assertion)
// ============================================================================

/**
 * Authenticate with a passkey (assertion flow).
 *
 * Called during login. The server provides a challenge, the browser prompts
 * for biometric verification, and this function returns the signed assertion
 * to send back to the server for verification.
 *
 * @param options - Authentication options from the server
 * @param options.challenge - Base64url-encoded challenge from server
 * @param options.rpId - Relying party ID (your domain)
 * @param options.allowCredentialIds - Limit authentication to specific credentials
 * @param options.userVerification - User verification requirement (default: 'preferred')
 * @param options.timeout - Timeout in milliseconds (default: 60000)
 * @returns The assertion response to send to the server for verification
 * @throws {PasskeyUnsupportedError} If WebAuthn is not available
 * @throws {PasskeyError} If authentication fails or is cancelled by the user
 *
 * @example
 * ```typescript
 * const assertion = await authenticateWithPasskey({
 *   challenge: serverOptions.challenge,
 *   rpId: 'example.com',
 * })
 * // Send `assertion` to server for verification
 * ```
 */
export async function authenticateWithPasskey(options: {
	challenge: string
	rpId: string
	allowCredentialIds?: string[]
	userVerification?: 'required' | 'preferred' | 'discouraged'
	timeout?: number
}): Promise<PasskeyAuthenticationResponse> {
	if (!isPasskeySupported()) {
		throw new PasskeyUnsupportedError()
	}

	// Build allowCredentials list from base64url credential IDs
	const allowCredentials: PublicKeyCredentialDescriptor[] | undefined =
		options.allowCredentialIds?.map((id) => ({
			type: 'public-key' as const,
			id: fromBase64Url(id).buffer as unknown as ArrayBuffer,
		}))

	const publicKeyOptions: PublicKeyCredentialRequestOptions = {
		challenge: fromBase64Url(options.challenge).buffer as unknown as ArrayBuffer,
		rpId: options.rpId,
		allowCredentials,
		userVerification: options.userVerification ?? 'preferred',
		timeout: options.timeout ?? 60000,
	}

	let credential: PublicKeyCredential
	try {
		const result = await navigator.credentials.get({
			publicKey: publicKeyOptions,
		})

		if (result === null) {
			throw new PasskeyError(
				'Authentication returned null. The user may have cancelled the operation.',
				{ rpId: options.rpId },
			)
		}

		credential = result as PublicKeyCredential
	} catch (error) {
		if (error instanceof PasskeyError) {
			throw error
		}

		const domError = error as DOMException
		if (domError.name === 'NotAllowedError') {
			throw new PasskeyError(
				'Passkey authentication was cancelled or not allowed. The user may have dismissed the prompt or the operation timed out.',
				{ rpId: options.rpId, errorName: domError.name },
			)
		}

		throw new PasskeyError(
			`Passkey authentication failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				rpId: options.rpId,
				errorName: error instanceof Error ? error.name : undefined,
			},
		)
	}

	const response = credential.response as AuthenticatorAssertionResponse

	const authenticatorData = new Uint8Array(response.authenticatorData)
	const clientDataJSON = new Uint8Array(response.clientDataJSON)
	const signature = new Uint8Array(response.signature)
	const userHandle =
		response.userHandle !== null && response.userHandle.byteLength > 0
			? toBase64Url(response.userHandle)
			: null

	return {
		credentialId: toBase64Url(credential.rawId),
		authenticatorData: toBase64Url(authenticatorData.buffer as unknown as ArrayBuffer),
		clientDataJSON: toBase64Url(clientDataJSON.buffer as unknown as ArrayBuffer),
		signature: toBase64Url(signature.buffer as unknown as ArrayBuffer),
		userHandle,
	}
}

// ============================================================================
// Internal: Extract public key from attestation object
// ============================================================================

/**
 * Extracts the COSE-encoded public key from a CBOR-encoded attestation object.
 *
 * The attestation object structure (CBOR map):
 *   - "fmt": attestation format (e.g. "none")
 *   - "attStmt": attestation statement (empty map for "none")
 *   - "authData": authenticator data (byte string)
 *
 * The authenticator data structure:
 *   - rpIdHash (32 bytes)
 *   - flags (1 byte)
 *   - signCount (4 bytes, big-endian)
 *   - [if flags.AT set] attestedCredentialData:
 *       - aaguid (16 bytes)
 *       - credentialIdLength (2 bytes, big-endian)
 *       - credentialId (credentialIdLength bytes)
 *       - credentialPublicKey (CBOR-encoded COSE_Key, remaining bytes)
 */
function extractPublicKeyFromAttestationObject(
	attestationObject: Uint8Array,
): Uint8Array {
	// Decode the top-level CBOR map to get authData
	const decoded = decodeCbor(attestationObject, 0)
	const topMap = decoded.value as Map<string, unknown>
	const authData = topMap.get('authData')

	if (!(authData instanceof Uint8Array)) {
		throw new PasskeyError(
			'Invalid attestation object: authData is missing or not a byte string.',
		)
	}

	// Parse authenticator data to find the credential public key
	let offset = 0

	// rpIdHash: 32 bytes
	offset += 32

	// flags: 1 byte
	const flags = authData[offset] as number
	offset += 1

	// signCount: 4 bytes
	offset += 4

	// Check if attestedCredentialData is present (bit 6 of flags)
	const hasAttestedCredentialData = (flags & 0x40) !== 0
	if (!hasAttestedCredentialData) {
		throw new PasskeyError(
			'Attestation object does not contain attested credential data. ' +
				'The authenticator did not include a public key.',
		)
	}

	// aaguid: 16 bytes
	offset += 16

	// credentialIdLength: 2 bytes, big-endian
	const credentialIdLength =
		((authData[offset] as number) << 8) | (authData[offset + 1] as number)
	offset += 2

	// credentialId: credentialIdLength bytes
	offset += credentialIdLength

	// The remaining bytes in authData from this offset are the CBOR-encoded
	// COSE public key. We need to extract exactly those bytes.
	// To find the exact length, we decode the CBOR value and use the consumed byte count.
	const coseKeyResult = decodeCbor(authData, offset)
	const coseKeyLength = coseKeyResult.offset - offset

	return authData.slice(offset, offset + coseKeyLength)
}

// ============================================================================
// Minimal CBOR decoder
// ============================================================================

/**
 * Minimal CBOR decoder supporting only the types needed for WebAuthn:
 * - Major type 0: Unsigned integer
 * - Major type 1: Negative integer
 * - Major type 2: Byte string
 * - Major type 3: Text string
 * - Major type 4: Array
 * - Major type 5: Map
 *
 * This decoder handles the subset of CBOR used in WebAuthn attestation
 * objects and COSE keys. It does not support tags, floats, or indefinite-length
 * encodings, which are not used in the WebAuthn specification.
 */

interface CborDecodeResult {
	value: unknown
	/** Byte offset after the decoded value (used for sequential decoding) */
	offset: number
}

function decodeCbor(data: Uint8Array, offset: number): CborDecodeResult {
	if (offset >= data.length) {
		throw new PasskeyError('CBOR decode error: unexpected end of data.')
	}

	const initialByte = data[offset] as number
	const majorType = initialByte >> 5
	const additionalInfo = initialByte & 0x1f
	offset += 1

	// Decode the argument (length or value) based on additionalInfo
	let argument: number
	if (additionalInfo < 24) {
		argument = additionalInfo
	} else if (additionalInfo === 24) {
		argument = data[offset] as number
		offset += 1
	} else if (additionalInfo === 25) {
		argument = ((data[offset] as number) << 8) | (data[offset + 1] as number)
		offset += 2
	} else if (additionalInfo === 26) {
		argument =
			((data[offset] as number) << 24) |
			((data[offset + 1] as number) << 16) |
			((data[offset + 2] as number) << 8) |
			(data[offset + 3] as number)
		// Handle unsigned 32-bit properly (bitwise ops produce signed 32-bit in JS)
		argument = argument >>> 0
		offset += 4
	} else {
		throw new PasskeyError(
			`CBOR decode error: unsupported additional info ${additionalInfo} at byte ${offset - 1}. ` +
				'This CBOR decoder only supports definite-length encodings.',
		)
	}

	switch (majorType) {
		// Major type 0: Unsigned integer
		case 0:
			return { value: argument, offset }

		// Major type 1: Negative integer (-1 - argument)
		case 1:
			return { value: -1 - argument, offset }

		// Major type 2: Byte string
		case 2: {
			const bytes = data.slice(offset, offset + argument)
			return { value: bytes, offset: offset + argument }
		}

		// Major type 3: Text string (UTF-8)
		case 3: {
			const textBytes = data.slice(offset, offset + argument)
			const text = new TextDecoder().decode(textBytes)
			return { value: text, offset: offset + argument }
		}

		// Major type 4: Array
		case 4: {
			const arr: unknown[] = []
			let currentOffset = offset
			for (let i = 0; i < argument; i++) {
				const item = decodeCbor(data, currentOffset)
				arr.push(item.value)
				currentOffset = item.offset
			}
			return { value: arr, offset: currentOffset }
		}

		// Major type 5: Map
		case 5: {
			const map = new Map<string | number, unknown>()
			let currentOffset = offset
			for (let i = 0; i < argument; i++) {
				const keyResult = decodeCbor(data, currentOffset)
				const valResult = decodeCbor(data, keyResult.offset)
				map.set(keyResult.value as string | number, valResult.value)
				currentOffset = valResult.offset
			}
			return { value: map, offset: currentOffset }
		}

		default:
			throw new PasskeyError(
				`CBOR decode error: unsupported major type ${majorType} at byte ${offset - 1}. ` +
					'This CBOR decoder only supports types 0-5 (integers, byte/text strings, arrays, maps).',
			)
	}
}

// Export the CBOR decoder for testing purposes (used by passkey-server too)
export { decodeCbor, type CborDecodeResult }
