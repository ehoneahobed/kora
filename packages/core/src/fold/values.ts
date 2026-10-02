import { canonicalize } from '../operations/content-hash'
import { bytesToBase64 } from '../operations/op-data-binary'

/** A plain data object (not an array, null, Date, Uint8Array or class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === null || proto === Object.prototype
}

/**
 * Normalize a value entering the fold state into its JSON-safe form, exactly as
 * it would be after an op-log round-trip: binary values become the tagged
 * `{ $koraBytes }` form and `undefined` object members are dropped. Every replica
 * therefore holds (and materializes) the same representation whether or not its
 * copy of an operation was ever serialized.
 */
export function normalizeValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $koraBytes: bytesToBase64(value) }
	if (value instanceof ArrayBuffer) return { $koraBytes: bytesToBase64(new Uint8Array(value)) }
	if (Array.isArray(value)) return value.map(normalizeValue)
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, member] of Object.entries(value)) {
			if (member !== undefined) out[key] = normalizeValue(member)
		}
		return out
	}
	return value
}

/** Canonical JSON (sorted keys) of a normalized value: the identity used for equality. */
export function canonicalKey(value: unknown): string {
	return canonicalize(normalizeValue(value))
}

/** Structural equality by canonical JSON. */
export function sameValue(a: unknown, b: unknown): boolean {
	return a === b || canonicalKey(a) === canonicalKey(b)
}
