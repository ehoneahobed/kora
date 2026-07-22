import { createHmac } from 'node:crypto'

// ============================================================================
// Base64url helpers
// ============================================================================

/**
 * Encodes a UTF-8 string to base64url format (RFC 7515).
 * Base64url uses the URL-safe alphabet (- instead of +, _ instead of /)
 * and strips trailing padding characters.
 *
 * @param input - The UTF-8 string to encode
 * @returns Base64url-encoded string
 */
export function base64urlEncode(input: string): string {
	return Buffer.from(input, 'utf-8').toString('base64url')
}

/**
 * Decodes a base64url-encoded string back to UTF-8.
 *
 * @param input - The base64url-encoded string to decode
 * @returns Decoded UTF-8 string
 */
export function base64urlDecode(input: string): string {
	return Buffer.from(input, 'base64url').toString('utf-8')
}

// ============================================================================
// Internal signing
// ============================================================================

/**
 * Computes an HMAC-SHA256 signature and returns it as a base64url string.
 * Uses Node.js crypto module for synchronous signing.
 */
function hmacSha256Base64url(data: string, secret: string): string {
	return createHmac('sha256', secret).update(data).digest('base64url')
}

// ============================================================================
// JWT operations
// ============================================================================

/** Pre-encoded JWT header. Only HS256 is supported; the header never changes. */
const ENCODED_HEADER = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

/**
 * Creates a signed JWT (HS256) from a payload and secret.
 *
 * The token is structured as `header.payload.signature` per RFC 7519.
 * Only HMAC-SHA256 is supported. The header is always `{"alg":"HS256","typ":"JWT"}`.
 *
 * @param payload - The claims to include in the token. Must be JSON-serializable.
 * @param secret - The HMAC-SHA256 secret key used for signing.
 * @returns A signed JWT string in the format `header.payload.signature`
 *
 * @example
 * ```typescript
 * const token = encodeJwt(
 *   { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 900 },
 *   'my-secret'
 * )
 * ```
 */
export function encodeJwt(payload: Record<string, unknown>, secret: string): string {
	const encodedPayload = base64urlEncode(JSON.stringify(payload))
	const signingInput = `${ENCODED_HEADER}.${encodedPayload}`
	const signature = hmacSha256Base64url(signingInput, secret)
	return `${signingInput}.${signature}`
}

/**
 * Decodes a JWT without verifying its signature.
 *
 * Use this only when you need to inspect claims (e.g., reading `exp` to decide
 * whether to attempt a refresh) and do NOT need to trust the token's authenticity.
 * For trusted reads, use {@link verifyJwt} instead.
 *
 * @param token - The JWT string to decode
 * @returns The decoded payload as a record, or null if the token is malformed
 *
 * @example
 * ```typescript
 * const claims = decodeJwt(token)
 * if (claims && typeof claims.sub === 'string') {
 *   console.log('User:', claims.sub)
 * }
 * ```
 */
export function decodeJwt(token: string): Record<string, unknown> | null {
	const parts = token.split('.')
	if (parts.length !== 3) {
		return null
	}

	const payloadSegment = parts[1]
	if (payloadSegment === undefined) {
		return null
	}

	try {
		const decoded = base64urlDecode(payloadSegment)
		const parsed: unknown = JSON.parse(decoded)
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return null
		}
		return parsed as Record<string, unknown>
	} catch {
		return null
	}
}

/**
 * Decodes a JWT and verifies its HMAC-SHA256 signature.
 *
 * Returns the payload only if the signature is valid. Returns null if the token
 * is malformed, has an invalid signature, or cannot be parsed.
 *
 * This function does NOT check expiration. Use {@link isExpired} separately
 * to check the `exp` claim, allowing callers to distinguish between
 * "invalid signature" (security issue) and "expired" (normal lifecycle).
 *
 * @param token - The JWT string to verify
 * @param secret - The HMAC-SHA256 secret key that was used to sign the token
 * @returns The decoded payload if the signature is valid, or null otherwise
 *
 * @example
 * ```typescript
 * const claims = verifyJwt(token, 'my-secret')
 * if (claims === null) {
 *   throw new Error('Invalid token signature')
 * }
 * if (isExpired(claims)) {
 *   throw new Error('Token has expired')
 * }
 * ```
 */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
	// Callers ultimately trace back to request bodies (handleRefresh,
	// handleSignOut, handleDeviceRegister, handleDeviceVerify all pass a body
	// field straight through to validateToken -> verifyJwt). A malformed or
	// missing field means `token` is not actually a string at runtime despite
	// the type, and `.split` would throw, turning one bad request into a
	// process-crashing uncaught exception. Treat non-string input as "not a
	// valid token" instead, same as any other malformed token shape.
	if (typeof token !== 'string') {
		return null
	}
	const parts = token.split('.')
	if (parts.length !== 3) {
		return null
	}

	const headerSegment = parts[0]
	const payloadSegment = parts[1]
	const signatureSegment = parts[2]

	if (
		headerSegment === undefined ||
		payloadSegment === undefined ||
		signatureSegment === undefined
	) {
		return null
	}

	// Validate the header to prevent algorithm confusion attacks.
	// Only HS256 is supported; reject any token claiming a different algorithm.
	if (headerSegment !== ENCODED_HEADER) {
		return null
	}

	// Recompute signature and compare
	const signingInput = `${headerSegment}.${payloadSegment}`
	const expectedSignature = hmacSha256Base64url(signingInput, secret)

	// Constant-time comparison to prevent timing attacks.
	// Both strings are base64url-encoded HMAC outputs, so they are ASCII-safe
	// and we can compare byte-by-byte without early exit.
	if (expectedSignature.length !== signatureSegment.length) {
		return null
	}
	let mismatch = 0
	for (let i = 0; i < expectedSignature.length; i++) {
		// Bitwise OR accumulates differences without short-circuiting
		mismatch |= expectedSignature.charCodeAt(i) ^ signatureSegment.charCodeAt(i)
	}
	if (mismatch !== 0) {
		return null
	}

	// Decode the payload
	try {
		const decoded = base64urlDecode(payloadSegment)
		const parsed: unknown = JSON.parse(decoded)
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return null
		}
		return parsed as Record<string, unknown>
	} catch {
		return null
	}
}

/**
 * Clock skew tolerance in seconds. Allows for minor clock differences
 * between servers in multi-server deployments.
 */
const CLOCK_SKEW_TOLERANCE_SECONDS = 5

/**
 * Checks whether a token payload has expired based on its `exp` claim.
 *
 * The `exp` claim is expected to be in seconds since the Unix epoch (per JWT spec).
 * Includes a small clock skew tolerance (5 seconds) to handle minor time
 * differences between servers. If the `exp` claim is missing or is not a number,
 * the token is considered non-expiring and this function returns false.
 *
 * @param payload - An object with an optional `exp` field (seconds since epoch)
 * @returns true if the token has expired, false otherwise
 *
 * @example
 * ```typescript
 * const claims = verifyJwt(token, secret)
 * if (claims && isExpired(claims)) {
 *   // Token signature is valid but it has expired -- attempt refresh
 * }
 * ```
 */
export function isExpired(payload: { exp?: number }): boolean {
	if (typeof payload.exp !== 'number') {
		return false
	}
	const nowSeconds = Math.floor(Date.now() / 1000)
	return nowSeconds >= payload.exp + CLOCK_SKEW_TOLERANCE_SECONDS
}
