import type { RandomSource } from '../types'

const defaultRandom: RandomSource = globalThis.crypto as RandomSource

/**
 * Generates a UUID v7 per RFC 9562.
 * UUID v7 encodes a Unix timestamp in milliseconds in the most significant 48 bits,
 * making UUIDs time-sortable while remaining globally unique.
 *
 * @param timestamp - Unix timestamp in milliseconds (defaults to Date.now())
 * @param randomSource - Injectable random source for deterministic testing
 * @returns A UUID v7 string in standard 8-4-4-4-12 format
 *
 * @example
 * ```typescript
 * const id = generateUUIDv7()
 * // "018f3a5c-7e00-7123-abcd-1234567890ab"
 * ```
 */
export function generateUUIDv7(
	timestamp: number = Date.now(),
	randomSource: RandomSource = defaultRandom,
): string {
	const bytes = new Uint8Array(16)
	randomSource.getRandomValues(bytes)

	// Encode 48-bit timestamp in bytes 0-5
	const ms = Math.max(0, Math.floor(timestamp))
	bytes[0] = (ms / 2 ** 40) & 0xff
	bytes[1] = (ms / 2 ** 32) & 0xff
	bytes[2] = (ms / 2 ** 24) & 0xff
	bytes[3] = (ms / 2 ** 16) & 0xff
	bytes[4] = (ms / 2 ** 8) & 0xff
	bytes[5] = ms & 0xff

	// Set version 7 (0111) in bits 48-51
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70

	// Set variant 10 in bits 64-65
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

	return formatUUID(bytes)
}

/**
 * Extracts the Unix timestamp in milliseconds from a UUID v7.
 *
 * @param uuid - A UUID v7 string
 * @returns The encoded Unix timestamp in milliseconds
 */
export function extractTimestamp(uuid: string): number {
	const hex = uuid.replace(/-/g, '')
	// First 12 hex chars = 48 bits of timestamp
	const high = Number.parseInt(hex.slice(0, 8), 16)
	const low = Number.parseInt(hex.slice(8, 12), 16)
	return high * 2 ** 16 + low
}

/**
 * Validates whether a string is a valid UUID v7.
 * Checks format, version (7), and variant (10xx).
 *
 * @param uuid - String to validate
 * @returns true if the string is a valid UUID v7
 */
export function isValidUUIDv7(uuid: string): boolean {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
		return false
	}
	const hex = uuid.replace(/-/g, '')
	// Version must be 7 (nibble at position 12)
	if (hex[12] !== '7') return false
	// Variant must be 10xx (nibble at position 16 must be 8, 9, a, or b)
	const variantNibble = Number.parseInt(hex[16] ?? '0', 16)
	return variantNibble >= 0x8 && variantNibble <= 0xb
}

function formatUUID(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
