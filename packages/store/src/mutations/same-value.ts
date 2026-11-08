/** Structural equality of two field values (arrays by element, `null` and absent differ). */
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
	if (a instanceof Uint8Array || b instanceof Uint8Array) {
		if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
			return false
		}
		return a.every((byte, index) => byte === b[index])
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
		return a.every((item, index) => sameValue(item, b[index]))
	}
	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	const keys = new Set([...Object.keys(left), ...Object.keys(right)])
	for (const key of keys) if (!sameValue(left[key], right[key])) return false
	return true
}
