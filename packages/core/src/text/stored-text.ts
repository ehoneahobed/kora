/**
 * Lossless string encoding for SQL text columns (RT-65), shared by every store that
 * binds JavaScript strings into a database: the server's Postgres and SQLite stores
 * and the client's SQLite stores (better-sqlite3, SQLite WASM on OPFS, and the
 * IndexedDB fallback, which runs SQLite WASM in memory).
 *
 * A JavaScript string is a sequence of UTF-16 code units. SQL text is UTF-8, which
 * cannot hold two kinds of code unit sequence a JS string can:
 *
 * - A lone UTF-16 surrogate: better-sqlite3, SQLite WASM (TextEncoder) and the
 *   Postgres driver all encode it as U+FFFD: silent corruption.
 * - U+0000: Postgres TEXT refuses it; SQLite WASM reads a TEXT column up to the first
 *   NUL.
 *
 * The codec maps those code units to an escape introduced by U+FFFF, a Unicode
 * noncharacter (valid UTF-8, never assigned):
 *
 * | Input | Stored |
 * |---|---|
 * | U+0000 | U+FFFF `0` |
 * | U+FFFF | U+FFFF `F` |
 * | lone surrogate `\uXXXX` | U+FFFF `s` + 4 lowercase hex digits |
 *
 * Every other string is stored unchanged, so existing rows, equality filters and
 * ordering are unaffected for ordinary text. The map is injective, and
 * `decodeStoredText(encodeStoredText(s)) === s` for every JS string. Equality is
 * preserved: `encode(a) === encode(b)` iff `a === b`, so an equality filter binds the
 * encoded value.
 *
 * Columns holding `JSON.stringify` output need no codec: well-formed `JSON.stringify`
 * escapes U+0000 and lone surrogates as `\u` sequences.
 */

/** The escape introducer: U+FFFF, a noncharacter. */
export const STORED_TEXT_ESCAPE = '￿'

// NUL, the escape, or any surrogate (paired ones are filtered in the loop).
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is exactly what the codec escapes (RT-65)
const NEEDS_ENCODING = /[\u0000￿\ud800-\udfff]/

/** True when `s` contains a code unit a SQL text column cannot hold as is. */
export function needsStoredTextEncoding(s: string): boolean {
	return NEEDS_ENCODING.test(s)
}

/**
 * Encode a JS string for a SQL TEXT column (or a string inside a JSONB value).
 *
 * @param s - Any JavaScript string
 * @returns `s` itself when it holds no NUL, U+FFFF or lone surrogate; otherwise the escaped form
 */
export function encodeStoredText(s: string): string {
	if (!NEEDS_ENCODING.test(s)) return s
	let out = ''
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i)
		if (code === 0) {
			out += `${STORED_TEXT_ESCAPE}0`
		} else if (code === 0xffff) {
			out += `${STORED_TEXT_ESCAPE}F`
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = s.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += s.slice(i, i + 2)
				i++
			} else {
				out += `${STORED_TEXT_ESCAPE}s${code.toString(16)}`
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			out += `${STORED_TEXT_ESCAPE}s${code.toString(16)}`
		} else {
			out += s.charAt(i)
		}
	}
	return out
}

/**
 * Decode a string written by {@link encodeStoredText}.
 *
 * @param s - A stored string
 * @returns The original JavaScript string. A U+FFFF not followed by a valid tag is kept as is.
 */
export function decodeStoredText(s: string): string {
	if (!s.includes(STORED_TEXT_ESCAPE)) return s
	let out = ''
	for (let i = 0; i < s.length; i++) {
		const char = s[i]
		if (char !== STORED_TEXT_ESCAPE) {
			out += char
			continue
		}
		const tag = s[i + 1]
		if (tag === '0') {
			out += '\u0000'
			i += 1
		} else if (tag === 'F') {
			out += STORED_TEXT_ESCAPE
			i += 1
		} else if (tag === 's') {
			const hex = s.slice(i + 2, i + 6)
			const code = Number.parseInt(hex, 16)
			if (hex.length === 4 && Number.isInteger(code) && code >= 0xd800 && code <= 0xdfff) {
				out += String.fromCharCode(code)
				i += 5
			} else {
				// Not written by the codec (a legacy row a migration did not reach): keep it.
				out += char
			}
		} else {
			out += char
		}
	}
	return out
}

/**
 * Apply {@link encodeStoredText} to every string (and object key) inside a JSON value.
 *
 * @param value - A JSON-compatible value
 */
export function encodeStoredJsonValue(value: unknown): unknown {
	return mapStrings(value, encodeStoredText)
}

/**
 * Apply {@link decodeStoredText} to every string (and object key) inside a JSON value.
 *
 * @param value - A JSON-compatible value
 */
export function decodeStoredJsonValue(value: unknown): unknown {
	return mapStrings(value, decodeStoredText)
}

function mapStrings(value: unknown, map: (s: string) => string): unknown {
	if (typeof value === 'string') return map(value)
	if (Array.isArray(value)) return value.map((member) => mapStrings(member, map))
	if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
		const out: Record<string, unknown> = {}
		for (const [key, member] of Object.entries(value)) out[map(key)] = mapStrings(member, map)
		return out
	}
	return value
}
