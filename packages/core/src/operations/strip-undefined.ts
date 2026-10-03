/**
 * The JSON shape of a value: object members whose value is `undefined` are removed
 * (deeply), and `undefined` array elements become `null`, exactly as `JSON.stringify`
 * writes them. Every other value (binary, sentinels, class instances) is kept as is.
 *
 * The op log and the wire are JSON, so an operation's content is its JSON shape. Hashing
 * (and storing) the in-memory value with `undefined` members would let the id cover
 * members no receiver ever sees (RT-72): one rule, applied before an id is computed,
 * keeps the hashed content and the stored content identical.
 *
 * Returns the same reference when nothing changes, so callers can cheaply detect a
 * normalization.
 *
 * @param value - Any operation data value
 * @returns The value without `undefined` members
 */
export function stripUndefinedMembers<T>(value: T): T {
	return strip(value) as T
}

function strip(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false
		const out = value.map((item) => {
			if (item === undefined) {
				changed = true
				return null
			}
			const next = strip(item)
			if (next !== item) changed = true
			return next
		})
		return changed ? out : value
	}
	if (!isPlainObject(value)) return value
	let changed = false
	const out: Record<string, unknown> = {}
	for (const [key, member] of Object.entries(value)) {
		if (member === undefined) {
			changed = true
			continue
		}
		const next = strip(member)
		if (next !== member) changed = true
		out[key] = next
	}
	return changed ? out : value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}
