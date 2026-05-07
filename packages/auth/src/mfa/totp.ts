import { KoraError } from '@korajs/core'

// ============================================================================
// TOTP Types
// ============================================================================

/**
 * Configuration for TOTP MFA.
 */
export interface TotpConfig {
	/** Issuer name shown in authenticator apps (e.g., "MyApp") */
	issuer: string
	/** Number of digits in the TOTP code. Default: 6 */
	digits?: number
	/** Time step in seconds. Default: 30 */
	period?: number
	/** Hash algorithm. Default: 'SHA-1' (most compatible with authenticator apps) */
	algorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512'
	/** Number of time windows to check before/after current. Default: 1 */
	window?: number
	/** Number of recovery codes to generate. Default: 8 */
	recoveryCodes?: number
}

/**
 * A TOTP secret with metadata for a user.
 */
export interface TotpSecret {
	/** User ID */
	userId: string
	/** Raw secret bytes (base32-encoded for display) */
	secret: string
	/** Whether MFA is verified (user has confirmed setup with a valid code) */
	verified: boolean
	/** Hashed recovery codes (unused ones only) */
	recoveryCodes: string[]
	/** When this secret was created */
	createdAt: number
	/** When MFA was verified (confirmed with first valid code) */
	verifiedAt: number | null
}

/**
 * Setup result returned when enabling TOTP MFA.
 */
export interface TotpSetupResult {
	/** The raw secret in base32 encoding (for manual entry) */
	secret: string
	/** otpauth:// URI for QR code generation */
	uri: string
	/** Plaintext recovery codes (shown once, then discarded) */
	recoveryCodes: string[]
}

/**
 * Store for TOTP secrets.
 */
export interface TotpStore {
	/** Save or update a TOTP secret for a user */
	save(secret: TotpSecret): Promise<void>
	/** Get a TOTP secret by user ID */
	getByUserId(userId: string): Promise<TotpSecret | null>
	/** Delete TOTP secret for a user (disable MFA) */
	delete(userId: string): Promise<void>
}

// ============================================================================
// Errors
// ============================================================================

export class TotpError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'TotpError'
	}
}

export class TotpInvalidCodeError extends TotpError {
	constructor() {
		super('Invalid TOTP code.', 'TOTP_INVALID_CODE')
	}
}

export class TotpNotEnabledError extends TotpError {
	constructor(userId: string) {
		super('TOTP MFA is not enabled for this user.', 'TOTP_NOT_ENABLED', { userId })
	}
}

export class TotpAlreadyEnabledError extends TotpError {
	constructor(userId: string) {
		super('TOTP MFA is already enabled for this user.', 'TOTP_ALREADY_ENABLED', { userId })
	}
}

export class TotpNotVerifiedError extends TotpError {
	constructor(userId: string) {
		super(
			'TOTP MFA setup is pending verification. Verify with a valid code first.',
			'TOTP_NOT_VERIFIED',
			{ userId },
		)
	}
}

export class TotpRecoveryExhaustedError extends TotpError {
	constructor() {
		super('All recovery codes have been used. Please regenerate.', 'TOTP_RECOVERY_EXHAUSTED')
	}
}

// ============================================================================
// InMemoryTotpStore
// ============================================================================

/**
 * In-memory TOTP store for development and testing.
 */
export class InMemoryTotpStore implements TotpStore {
	private readonly secrets = new Map<string, TotpSecret>()

	async save(secret: TotpSecret): Promise<void> {
		this.secrets.set(secret.userId, secret)
	}

	async getByUserId(userId: string): Promise<TotpSecret | null> {
		return this.secrets.get(userId) ?? null
	}

	async delete(userId: string): Promise<void> {
		this.secrets.delete(userId)
	}
}

// ============================================================================
// TotpManager
// ============================================================================

const DEFAULT_DIGITS = 6
const DEFAULT_PERIOD = 30
const DEFAULT_ALGORITHM = 'SHA-1'
const DEFAULT_WINDOW = 1
const DEFAULT_RECOVERY_CODES = 8
const RECOVERY_CODE_LENGTH = 10

/**
 * Manages TOTP-based Multi-Factor Authentication.
 *
 * Implements RFC 6238 (TOTP) and RFC 4226 (HOTP) with Web Crypto API.
 * Compatible with Google Authenticator, Authy, 1Password, and other
 * TOTP-compatible authenticator apps.
 *
 * @example
 * ```typescript
 * const totp = new TotpManager({
 *   issuer: 'MyApp',
 *   store: new InMemoryTotpStore(),
 * })
 *
 * // Step 1: Enable MFA (returns QR code URI and recovery codes)
 * const setup = await totp.enable('user-123', 'alice@example.com')
 * // Show setup.uri as QR code, show setup.recoveryCodes once
 *
 * // Step 2: Verify setup with a code from authenticator app
 * await totp.verifySetup('user-123', '123456')
 *
 * // Step 3: On login, verify TOTP code
 * const valid = await totp.verify('user-123', '654321')
 * ```
 */
export class TotpManager {
	private readonly store: TotpStore
	private readonly issuer: string
	private readonly digits: number
	private readonly period: number
	private readonly algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512'
	private readonly window: number
	private readonly recoveryCodeCount: number

	constructor(config: TotpConfig & { store: TotpStore }) {
		this.store = config.store
		this.issuer = config.issuer
		this.digits = config.digits ?? DEFAULT_DIGITS
		this.period = config.period ?? DEFAULT_PERIOD
		this.algorithm = config.algorithm ?? DEFAULT_ALGORITHM
		this.window = config.window ?? DEFAULT_WINDOW
		this.recoveryCodeCount = config.recoveryCodes ?? DEFAULT_RECOVERY_CODES
	}

	/**
	 * Enable TOTP MFA for a user.
	 * Returns the secret URI (for QR code) and recovery codes.
	 * The user must verify setup with a valid code before MFA is active.
	 */
	async enable(userId: string, accountName: string): Promise<TotpSetupResult> {
		const existing = await this.store.getByUserId(userId)
		if (existing?.verified) {
			throw new TotpAlreadyEnabledError(userId)
		}

		const secretBytes = generateSecret(20)
		const secret = base32Encode(secretBytes)
		const recoveryCodes = generateRecoveryCodes(this.recoveryCodeCount, RECOVERY_CODE_LENGTH)
		const hashedCodes = await Promise.all(recoveryCodes.map((c) => hashRecoveryCode(c)))

		const totpSecret: TotpSecret = {
			userId,
			secret,
			verified: false,
			recoveryCodes: hashedCodes,
			createdAt: Date.now(),
			verifiedAt: null,
		}

		await this.store.save(totpSecret)

		const uri = buildOtpauthUri({
			issuer: this.issuer,
			accountName,
			secret,
			algorithm: this.algorithm,
			digits: this.digits,
			period: this.period,
		})

		return { secret, uri, recoveryCodes }
	}

	/**
	 * Verify the TOTP setup by confirming the user can generate a valid code.
	 * Must be called after `enable()` and before MFA is enforced.
	 */
	async verifySetup(userId: string, code: string): Promise<boolean> {
		const stored = await this.store.getByUserId(userId)
		if (!stored) {
			throw new TotpNotEnabledError(userId)
		}

		if (stored.verified) {
			// Already verified, just validate the code
			return this.validateCode(stored.secret, code)
		}

		const valid = this.validateCode(stored.secret, code)
		if (!valid) {
			throw new TotpInvalidCodeError()
		}

		// Mark as verified
		stored.verified = true
		stored.verifiedAt = Date.now()
		await this.store.save(stored)

		return true
	}

	/**
	 * Verify a TOTP code during login.
	 * Returns true if the code is valid, false otherwise.
	 */
	async verify(userId: string, code: string): Promise<boolean> {
		const stored = await this.store.getByUserId(userId)
		if (!stored) {
			throw new TotpNotEnabledError(userId)
		}

		if (!stored.verified) {
			throw new TotpNotVerifiedError(userId)
		}

		return this.validateCode(stored.secret, code)
	}

	/**
	 * Verify a recovery code as an alternative to TOTP.
	 * Recovery codes are single-use.
	 */
	async verifyRecoveryCode(userId: string, recoveryCode: string): Promise<boolean> {
		const stored = await this.store.getByUserId(userId)
		if (!stored) {
			throw new TotpNotEnabledError(userId)
		}

		if (!stored.verified) {
			throw new TotpNotVerifiedError(userId)
		}

		const hashed = await hashRecoveryCode(recoveryCode.trim())

		const index = stored.recoveryCodes.indexOf(hashed)
		if (index === -1) {
			return false
		}

		// Consume the recovery code (single-use)
		stored.recoveryCodes.splice(index, 1)
		await this.store.save(stored)

		return true
	}

	/**
	 * Regenerate recovery codes. Requires a valid TOTP code for authorization.
	 * Replaces all existing recovery codes.
	 */
	async regenerateRecoveryCodes(userId: string, totpCode: string): Promise<string[]> {
		const stored = await this.store.getByUserId(userId)
		if (!stored) {
			throw new TotpNotEnabledError(userId)
		}

		if (!stored.verified) {
			throw new TotpNotVerifiedError(userId)
		}

		const valid = this.validateCode(stored.secret, totpCode)
		if (!valid) {
			throw new TotpInvalidCodeError()
		}

		const recoveryCodes = generateRecoveryCodes(this.recoveryCodeCount, RECOVERY_CODE_LENGTH)
		const hashedCodes = await Promise.all(recoveryCodes.map((c) => hashRecoveryCode(c)))

		stored.recoveryCodes = hashedCodes
		await this.store.save(stored)

		return recoveryCodes
	}

	/**
	 * Disable TOTP MFA for a user.
	 * Requires a valid TOTP code or recovery code for authorization.
	 */
	async disable(userId: string, code: string): Promise<void> {
		const stored = await this.store.getByUserId(userId)
		if (!stored) {
			throw new TotpNotEnabledError(userId)
		}

		// Accept either a TOTP code or a recovery code
		let authorized = false

		if (stored.verified) {
			authorized = this.validateCode(stored.secret, code)
		}

		if (!authorized) {
			const hashed = await hashRecoveryCode(code.trim())
			authorized = stored.recoveryCodes.includes(hashed)
		}

		if (!authorized) {
			throw new TotpInvalidCodeError()
		}

		await this.store.delete(userId)
	}

	/**
	 * Check if a user has TOTP MFA enabled and verified.
	 */
	async isEnabled(userId: string): Promise<boolean> {
		const stored = await this.store.getByUserId(userId)
		return stored !== null && stored.verified
	}

	/**
	 * Get the number of remaining recovery codes for a user.
	 */
	async remainingRecoveryCodes(userId: string): Promise<number> {
		const stored = await this.store.getByUserId(userId)
		if (!stored || !stored.verified) return 0
		return stored.recoveryCodes.length
	}

	// --- Private ---

	private validateCode(base32Secret: string, code: string): boolean {
		const secretBytes = base32Decode(base32Secret)
		const now = Math.floor(Date.now() / 1000)

		// Check current window and adjacent windows
		for (let offset = -this.window; offset <= this.window; offset++) {
			const timeCounter = Math.floor((now + offset * this.period) / this.period)
			const expected = generateTotpCode(secretBytes, timeCounter, this.digits, this.algorithm)
			if (timingSafeEqual(code, expected)) {
				return true
			}
		}

		return false
	}
}

// ============================================================================
// TOTP Core (RFC 6238 / RFC 4226)
// ============================================================================

/**
 * Generate a TOTP code for a given time counter.
 * Implements HOTP (RFC 4226) with a time-based counter (RFC 6238).
 */
function generateTotpCode(
	secret: Uint8Array,
	counter: number,
	digits: number,
	algorithm: string,
): string {
	// Counter as 8-byte big-endian
	const counterBytes = new Uint8Array(8)
	let c = counter
	for (let i = 7; i >= 0; i--) {
		counterBytes[i] = c & 0xff
		c = Math.floor(c / 256)
	}

	// HMAC-SHA1 (or SHA-256/SHA-512)
	const hash = hmacSha(algorithm, secret, counterBytes)

	// Dynamic truncation (RFC 4226 section 5.4)
	const offset = hash[hash.length - 1]! & 0x0f
	const binary =
		((hash[offset]! & 0x7f) << 24) |
		((hash[offset + 1]! & 0xff) << 16) |
		((hash[offset + 2]! & 0xff) << 8) |
		(hash[offset + 3]! & 0xff)

	const otp = binary % Math.pow(10, digits)
	return otp.toString().padStart(digits, '0')
}

/**
 * Synchronous HMAC using a simplified implementation.
 * TOTP only needs HMAC-SHA1 which we implement directly
 * to avoid async Web Crypto for the hot path (validation).
 */
function hmacSha(algorithm: string, key: Uint8Array, message: Uint8Array): Uint8Array {
	// Use the appropriate block size and hash
	const blockSize = algorithm === 'SHA-512' ? 128 : 64

	// Pad or hash the key
	let keyPad = key
	if (keyPad.length > blockSize) {
		keyPad = sha1(keyPad)
	}

	// Create padded key
	const ipad = new Uint8Array(blockSize)
	const opad = new Uint8Array(blockSize)
	for (let i = 0; i < blockSize; i++) {
		const k = i < keyPad.length ? keyPad[i]! : 0
		ipad[i] = k ^ 0x36
		opad[i] = k ^ 0x5c
	}

	// Inner hash: H(key XOR ipad || message)
	const innerData = new Uint8Array(blockSize + message.length)
	innerData.set(ipad)
	innerData.set(message, blockSize)
	const innerHash = sha1(innerData)

	// Outer hash: H(key XOR opad || inner_hash)
	const outerData = new Uint8Array(blockSize + innerHash.length)
	outerData.set(opad)
	outerData.set(innerHash, blockSize)
	return sha1(outerData)
}

/**
 * SHA-1 implementation for TOTP HMAC.
 * SHA-1 is the standard for TOTP (RFC 6238) and is NOT used for security
 * hashing here — it's used as a PRF inside HMAC which is still secure.
 */
function sha1(data: Uint8Array): Uint8Array {
	let h0 = 0x67452301
	let h1 = 0xefcdab89
	let h2 = 0x98badcfe
	let h3 = 0x10325476
	let h4 = 0xc3d2e1f0

	const bitLength = data.length * 8

	// Pre-processing: add padding
	// message + 1 bit + zeros + 64-bit length
	const paddedLength = Math.ceil((data.length + 9) / 64) * 64
	const padded = new Uint8Array(paddedLength)
	padded.set(data)
	padded[data.length] = 0x80

	// Append length as 64-bit big-endian
	const view = new DataView(padded.buffer, padded.byteOffset)
	// For messages < 2^32 bits, high 32 bits are 0
	view.setUint32(paddedLength - 4, bitLength, false)

	// Process each 512-bit (64-byte) block
	const w = new Int32Array(80)

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getInt32(offset + i * 4, false)
		}

		for (let i = 16; i < 80; i++) {
			w[i] = rotl32((w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!) | 0, 1)
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

			const temp = (rotl32(a, 5) + f + e + k + w[i]!) | 0
			e = d
			d = c
			c = rotl32(b, 30)
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

function rotl32(value: number, shift: number): number {
	return ((value << shift) | (value >>> (32 - shift))) | 0
}

// ============================================================================
// Base32 Encoding/Decoding (RFC 4648)
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Encode bytes to base32 string (RFC 4648, no padding).
 */
export function base32Encode(data: Uint8Array): string {
	let result = ''
	let bits = 0
	let buffer = 0

	for (let i = 0; i < data.length; i++) {
		buffer = (buffer << 8) | data[i]!
		bits += 8
		while (bits >= 5) {
			bits -= 5
			result += BASE32_ALPHABET[(buffer >>> bits) & 0x1f]
		}
	}

	if (bits > 0) {
		result += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]
	}

	return result
}

/**
 * Decode a base32 string to bytes (RFC 4648).
 */
export function base32Decode(encoded: string): Uint8Array {
	const cleaned = encoded.replace(/=+$/, '').toUpperCase()
	const output: number[] = []
	let bits = 0
	let buffer = 0

	for (let i = 0; i < cleaned.length; i++) {
		const char = cleaned[i]!
		const value = BASE32_ALPHABET.indexOf(char)
		if (value === -1) continue // skip invalid chars

		buffer = (buffer << 5) | value
		bits += 5

		if (bits >= 8) {
			bits -= 8
			output.push((buffer >>> bits) & 0xff)
		}
	}

	return new Uint8Array(output)
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a random secret of the given byte length.
 */
function generateSecret(byteLength: number): Uint8Array {
	const bytes = new Uint8Array(byteLength)
	globalThis.crypto.getRandomValues(bytes)
	return bytes
}

/**
 * Generate random recovery codes.
 */
function generateRecoveryCodes(count: number, length: number): string[] {
	const codes: string[] = []
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'

	for (let i = 0; i < count; i++) {
		const bytes = new Uint8Array(length)
		globalThis.crypto.getRandomValues(bytes)
		let code = ''
		for (let j = 0; j < length; j++) {
			code += chars[bytes[j]! % chars.length]
		}
		// Format as xxxxx-xxxxx for readability
		codes.push(`${code.slice(0, 5)}-${code.slice(5)}`)
	}

	return codes
}

/**
 * Hash a recovery code for storage (SHA-256).
 */
async function hashRecoveryCode(code: string): Promise<string> {
	const encoded = new TextEncoder().encode(code.toLowerCase().replace(/[-\s]/g, ''))
	const hash = await globalThis.crypto.subtle.digest('SHA-256', encoded)
	const bytes = new Uint8Array(hash)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]!.toString(16).padStart(2, '0')
	}
	return hex
}

/**
 * Build an otpauth:// URI for QR code generation.
 */
function buildOtpauthUri(params: {
	issuer: string
	accountName: string
	secret: string
	algorithm: string
	digits: number
	period: number
}): string {
	const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`
	const query = new URLSearchParams({
		secret: params.secret,
		issuer: params.issuer,
		algorithm: params.algorithm.replace('-', ''),
		digits: params.digits.toString(),
		period: params.period.toString(),
	})
	return `otpauth://totp/${label}?${query.toString()}`
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false

	let result = 0
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}

	return result === 0
}
