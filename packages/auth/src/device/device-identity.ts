import { KoraError } from '@korajs/core'

// --- Auth-specific errors ---

/**
 * Thrown when the Web Crypto API is not available in the current environment.
 * This can happen in older Node.js versions or SSR environments without crypto support.
 */
export class CryptoUnavailableError extends KoraError {
	constructor() {
		super(
			'Web Crypto API (crypto.subtle) is not available in this environment. ' +
				'Device identity requires crypto.subtle, which is available in modern browsers and Node.js 20+. ' +
				'If running in SSR, ensure your runtime provides the Web Crypto API.',
			'CRYPTO_UNAVAILABLE',
		)
		this.name = 'CryptoUnavailableError'
	}
}

/**
 * Thrown when a device identity operation fails (key generation, signing, verification).
 */
export class DeviceIdentityError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'DEVICE_IDENTITY_ERROR', context)
		this.name = 'DeviceIdentityError'
	}
}

// --- Encoding helpers ---

/**
 * Encodes an ArrayBuffer as a base64url string (no padding).
 *
 * @param buffer - The binary data to encode
 * @returns A base64url-encoded string without padding characters
 */
export function toBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number)
	}
	// Standard base64, then convert to base64url (no padding)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decodes a base64url string (no padding) into a Uint8Array.
 *
 * @param str - A base64url-encoded string (with or without padding)
 * @returns The decoded binary data as a Uint8Array
 */
export function fromBase64Url(str: string): Uint8Array {
	// Convert base64url back to standard base64
	let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
	// Add padding if necessary
	const paddingNeeded = (4 - (base64.length % 4)) % 4
	base64 += '='.repeat(paddingNeeded)

	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

// --- Internal helpers ---

/**
 * Asserts that `crypto.subtle` is available, throwing a clear error if not.
 */
function assertCryptoAvailable(): void {
	if (
		typeof globalThis.crypto === 'undefined' ||
		typeof globalThis.crypto.subtle === 'undefined'
	) {
		throw new CryptoUnavailableError()
	}
}

/** ECDSA algorithm parameters used throughout the module. */
const ECDSA_ALGORITHM: EcKeyGenParams = {
	name: 'ECDSA',
	namedCurve: 'P-256',
}

/** Signing algorithm parameters: ECDSA with SHA-256. */
const ECDSA_SIGN_ALGORITHM: EcdsaParams = {
	name: 'ECDSA',
	hash: { name: 'SHA-256' },
}

// --- Public API ---

/**
 * Generates an ECDSA P-256 key pair for device identity.
 *
 * The private key is marked as non-extractable, ensuring it cannot be
 * exported from the browser's crypto subsystem. This provides
 * proof-of-possession: only code running on this device can sign with the key.
 *
 * @returns A CryptoKeyPair containing the public and private ECDSA P-256 keys
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {DeviceIdentityError} If key generation fails
 *
 * @example
 * ```typescript
 * const keyPair = await generateDeviceKeyPair()
 * // keyPair.publicKey can be exported; keyPair.privateKey stays on device
 * ```
 */
export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
	assertCryptoAvailable()

	try {
		const keyPair = await globalThis.crypto.subtle.generateKey(
			ECDSA_ALGORITHM,
			// extractable: false makes the private key non-extractable.
			// The public key is always extractable regardless of this flag.
			false,
			['sign', 'verify'],
		)
		return keyPair
	} catch (cause) {
		throw new DeviceIdentityError(
			'Failed to generate ECDSA P-256 device key pair. ' +
				'Ensure the runtime supports the ECDSA algorithm with the P-256 curve.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Exports the public key from a key pair as a JSON Web Key (JWK).
 *
 * The JWK can be safely transmitted to a server or other devices to identify
 * this device. It contains only the public component of the key pair.
 *
 * @param keyPair - The CryptoKeyPair whose public key should be exported
 * @returns The public key in JWK format
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {DeviceIdentityError} If the export operation fails
 *
 * @example
 * ```typescript
 * const keyPair = await generateDeviceKeyPair()
 * const jwk = await exportPublicKeyJwk(keyPair)
 * // jwk contains { kty: 'EC', crv: 'P-256', x: '...', y: '...' }
 * ```
 */
export async function exportPublicKeyJwk(keyPair: CryptoKeyPair): Promise<JsonWebKey> {
	assertCryptoAvailable()

	try {
		const jwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey)
		return jwk
	} catch (cause) {
		throw new DeviceIdentityError(
			'Failed to export public key as JWK. ' +
				'The key pair may be invalid or the public key may not support JWK export.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Signs a challenge string with the device's private key.
 *
 * Used for proof-of-possession during authentication: the server sends a
 * random challenge, and the device proves it holds the private key by signing it.
 *
 * @param privateKey - The device's private CryptoKey (ECDSA P-256)
 * @param challenge - The challenge string to sign (typically a random nonce from the server)
 * @returns A base64url-encoded ECDSA signature (no padding)
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {DeviceIdentityError} If the signing operation fails
 *
 * @example
 * ```typescript
 * const keyPair = await generateDeviceKeyPair()
 * const signature = await signChallenge(keyPair.privateKey, 'server-nonce-abc123')
 * // signature is a base64url string like 'MEUCIQDx...'
 * ```
 */
export async function signChallenge(privateKey: CryptoKey, challenge: string): Promise<string> {
	assertCryptoAvailable()

	try {
		const encoded = new TextEncoder().encode(challenge)
		const signatureBuffer = await globalThis.crypto.subtle.sign(
			ECDSA_SIGN_ALGORITHM,
			privateKey,
			encoded,
		)
		return toBase64Url(signatureBuffer)
	} catch (cause) {
		throw new DeviceIdentityError(
			'Failed to sign challenge. ' +
				'Ensure the key is a valid ECDSA P-256 private key with "sign" usage.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}

/**
 * Verifies a challenge signature against a public key.
 *
 * Used server-side (or on any verifying party) to confirm that a device
 * holds the private key corresponding to the given public key.
 *
 * @param publicKeyJwk - The device's public key in JWK format
 * @param challenge - The original challenge string that was signed
 * @param signature - The base64url-encoded signature to verify
 * @returns `true` if the signature is valid, `false` otherwise
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {DeviceIdentityError} If the verification operation fails due to an invalid key or format
 *
 * @example
 * ```typescript
 * const isValid = await verifyChallenge(publicKeyJwk, 'server-nonce-abc123', signature)
 * if (isValid) {
 *   // Device proved possession of the private key
 * }
 * ```
 */
export async function verifyChallenge(
	publicKeyJwk: JsonWebKey,
	challenge: string,
	signature: string,
): Promise<boolean> {
	assertCryptoAvailable()

	try {
		const publicKey = await globalThis.crypto.subtle.importKey(
			'jwk',
			publicKeyJwk,
			ECDSA_ALGORITHM,
			true,
			['verify'],
		)

		const encoded = new TextEncoder().encode(challenge)
		const signatureBytes = fromBase64Url(signature)

		const isValid = await globalThis.crypto.subtle.verify(
			ECDSA_SIGN_ALGORITHM,
			publicKey,
			signatureBytes as unknown as ArrayBuffer,
			encoded,
		)
		return isValid
	} catch (cause) {
		throw new DeviceIdentityError(
			'Failed to verify challenge signature. ' +
				'The public key JWK or signature format may be invalid.',
			{
				cause: cause instanceof Error ? cause.message : String(cause),
				publicKeyKty: publicKeyJwk.kty,
				publicKeyCrv: publicKeyJwk.crv,
			},
		)
	}
}

/**
 * Computes a SHA-256 thumbprint of a JWK public key.
 *
 * The thumbprint is computed per RFC 7638: the JWK members required for the key
 * type are serialized in lexicographic order, then hashed with SHA-256. For EC keys
 * (kty: "EC"), the required members are `crv`, `kty`, `x`, and `y`.
 *
 * This thumbprint serves as a compact, stable identifier for the device's public key
 * (used as the `dpk` claim in device credentials).
 *
 * @param publicKeyJwk - The public key in JWK format (must be an EC P-256 key)
 * @returns A base64url-encoded SHA-256 thumbprint (no padding)
 * @throws {CryptoUnavailableError} If `crypto.subtle` is not available
 * @throws {DeviceIdentityError} If the thumbprint computation fails or the JWK is missing required fields
 *
 * @example
 * ```typescript
 * const keyPair = await generateDeviceKeyPair()
 * const jwk = await exportPublicKeyJwk(keyPair)
 * const thumbprint = await computePublicKeyThumbprint(jwk)
 * // thumbprint is a base64url string, e.g., 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'
 * ```
 */
export async function computePublicKeyThumbprint(publicKeyJwk: JsonWebKey): Promise<string> {
	assertCryptoAvailable()

	// RFC 7638 requires specific members in lexicographic order for each key type.
	// For EC (kty: "EC"), the required members are: crv, kty, x, y.
	if (publicKeyJwk.kty !== 'EC') {
		throw new DeviceIdentityError(
			`Expected JWK key type "EC" but received "${publicKeyJwk.kty ?? 'undefined'}". ` +
				'Only ECDSA public keys are supported for device identity.',
			{ kty: publicKeyJwk.kty },
		)
	}

	if (!publicKeyJwk.crv || !publicKeyJwk.x || !publicKeyJwk.y) {
		throw new DeviceIdentityError(
			'JWK is missing required EC fields. ' +
				'An EC public key JWK must include "crv", "x", and "y" members.',
			{
				hasCrv: Boolean(publicKeyJwk.crv),
				hasX: Boolean(publicKeyJwk.x),
				hasY: Boolean(publicKeyJwk.y),
			},
		)
	}

	// Build the canonical JSON with only the required members in lexicographic order.
	// Per RFC 7638, no whitespace, keys in sorted order.
	const canonicalJson = JSON.stringify({
		crv: publicKeyJwk.crv,
		kty: publicKeyJwk.kty,
		x: publicKeyJwk.x,
		y: publicKeyJwk.y,
	})

	try {
		const encoded = new TextEncoder().encode(canonicalJson)
		const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
		return toBase64Url(hashBuffer)
	} catch (cause) {
		throw new DeviceIdentityError(
			'Failed to compute SHA-256 thumbprint of the public key JWK.',
			{ cause: cause instanceof Error ? cause.message : String(cause) },
		)
	}
}
