import { OperationError } from '../errors/errors'

/**
 * Canonical JSON-safe encoding of binary bytes stored inside `op.data` /
 * `op.previousData` (currently richtext field values). A raw Uint8Array
 * JSON-serializes to a numeric-key object and an ArrayBuffer to `{}` (silent
 * data loss), which breaks content-hash stability, persistence round-trips,
 * remote application, and merge. Tagging the bytes as base64 at
 * operation-creation time makes the hashed value, the persisted JSON, the wire
 * payload, and the value the merge engine sees the identical canonical value.
 *
 * This convention lives in `@korajs/core` because `op.data` is a core concept:
 * both `@korajs/store` (persistence, creation) and `@korajs/merge` (CRDT merge)
 * must agree on it, and neither may depend on the other.
 */
export interface KoraBytesValue {
	$koraBytes: string
}

/**
 * Type guard for the tagged binary form. Requires exactly the single
 * `$koraBytes` key so arbitrary user objects that happen to contain the key
 * are never silently reinterpreted as bytes.
 */
export function isKoraBytesValue(value: unknown): value is KoraBytesValue {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const record = value as Record<string, unknown>
	return Object.keys(record).length === 1 && typeof record.$koraBytes === 'string'
}

/**
 * Detects the numeric-key object shape a raw Uint8Array produced when
 * JSON-serialized before the tagged encoding existed ({"0":1,"1":2,...}).
 */
export function isLegacyNumericByteObject(value: unknown): value is Record<string, number> {
	if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) {
		return false
	}
	const record = value as Record<string, unknown>
	const keys = Object.keys(record)
	if (keys.length === 0) {
		return false
	}
	for (let i = 0; i < keys.length; i++) {
		const byte = record[String(i)]
		if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
			return false
		}
	}
	return true
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const BASE64_REVERSE: ReadonlyMap<string, number> = new Map(
	Array.from(BASE64_ALPHABET, (char, index) => [char, index]),
)

/**
 * Dependency-free base64 encoder. btoa is unavailable for bytes in Node and
 * Buffer is unavailable in browsers, so a manual implementation is the only
 * deterministic option that works in every runtime Kora targets.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0
		const b1 = bytes[i + 1] ?? 0
		const b2 = bytes[i + 2] ?? 0
		const triple = (b0 << 16) | (b1 << 8) | b2
		out += BASE64_ALPHABET[(triple >> 18) & 63] ?? ''
		out += BASE64_ALPHABET[(triple >> 12) & 63] ?? ''
		out += i + 1 < bytes.length ? (BASE64_ALPHABET[(triple >> 6) & 63] ?? '') : '='
		out += i + 2 < bytes.length ? (BASE64_ALPHABET[triple & 63] ?? '') : '='
	}
	return out
}

/**
 * Inverse of {@link bytesToBase64}.
 */
export function base64ToBytes(base64: string): Uint8Array {
	const cleaned = base64.replace(/=+$/, '')
	const out = new Uint8Array(Math.floor((cleaned.length * 6) / 8))
	let buffer = 0
	let bits = 0
	let index = 0
	for (const char of cleaned) {
		const value = BASE64_REVERSE.get(char)
		if (value === undefined) {
			throw new OperationError(`Invalid base64 character "${char}" in tagged binary value.`, {
				char,
			})
		}
		buffer = (buffer << 6) | value
		bits += 6
		if (bits >= 8) {
			bits -= 8
			out[index] = (buffer >> bits) & 0xff
			index += 1
		}
	}
	return out
}

/**
 * Normalize a validated binary-or-string value into the canonical form stored
 * in `op.data`: strings pass through unchanged (backward compatible with every
 * existing operation), binary values become the tagged base64 form.
 */
export function encodeBytesForOpData(
	value: string | Uint8Array | ArrayBuffer,
): string | KoraBytesValue {
	if (typeof value === 'string') {
		return value
	}
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
	return { $koraBytes: bytesToBase64(bytes) }
}

/**
 * Reverse of {@link encodeBytesForOpData}, tolerant of every shape a binary
 * op-data value has ever taken: canonical strings and tagged bytes, in-memory
 * Uint8Array/ArrayBuffer (ops that never round-tripped through JSON), and
 * pre-fix numeric-key objects.
 */
export function decodeBytesFromOpData(value: unknown): string | Uint8Array {
	if (typeof value === 'string') {
		return value
	}
	if (value instanceof Uint8Array) {
		return value
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value)
	}
	if (isKoraBytesValue(value)) {
		return base64ToBytes(value.$koraBytes)
	}
	// Pre-fix era: a raw Uint8Array in op.data JSON-serialized to a numeric-key
	// object. Nothing shipped relies on that shape, but dev databases may still
	// contain such operations — reconstructing the bytes here is cheap and
	// prevents those databases from crashing on replay/apply/merge. No migration
	// is written for this; new operations always use the tagged form.
	if (isLegacyNumericByteObject(value)) {
		const keys = Object.keys(value)
		const bytes = new Uint8Array(keys.length)
		for (let i = 0; i < keys.length; i++) {
			bytes[i] = value[String(i)] ?? 0
		}
		return bytes
	}
	throw new OperationError(
		'Binary op-data value must be a string, Uint8Array, ArrayBuffer, tagged { $koraBytes } object, or legacy numeric-key byte object.',
		{ receivedType: typeof value },
	)
}
