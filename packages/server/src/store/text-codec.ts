/**
 * Lossless string encoding at the SQL boundary of the server stores (RT-65).
 *
 * Every JavaScript string must round-trip through the Postgres server store exactly as
 * it does through the memory and SQLite stores and every client store. Postgres cannot
 * hold two kinds of JS string content:
 *
 * - U+0000: TEXT refuses it (`invalid byte sequence for encoding "UTF8": 0x00`) and
 *   JSONB refuses the `\u0000` escape.
 * - A lone UTF-16 surrogate: the driver encodes it to UTF-8 as U+FFFD (silent
 *   corruption) and JSONB refuses the unpaired `\uD800` escape.
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
 * SQLite (better-sqlite3 binds strings as UTF-8) loses lone surrogates the same way,
 * so its raw-string columns use the same codec; its array/object/json columns hold
 * `JSON.stringify` text, which escapes both.
 *
 * Every other string is stored unchanged, so existing rows, equality filters and
 * ordering are unaffected for ordinary text. The map is injective, and decode(encode(s))
 * is s for every JS string. Rows written before the codec that contain U+FFFF are
 * re-encoded once per table by {@link pgTextCodecMigrationSql}.
 *
 * Operation columns hold `JSON.stringify` output, which already escapes U+0000 and
 * lone surrogates (well-formed JSON.stringify), so they need no codec.
 */

import type { FieldDescriptor } from '@korajs/core'
import { deserializeFieldValue, serializeFieldValue } from './materialization'

/** The escape introducer: U+FFFF, a noncharacter. */
export const PG_TEXT_ESCAPE = '\uffff'

/** `kora_server_meta` key prefix marking a table whose legacy U+FFFF rows were re-encoded. */
export const PG_TEXT_CODEC_MIGRATION_KEY = 'pg_text_codec_v1:'

// NUL, the escape, or any surrogate (paired ones are filtered in the loop).
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is exactly what the codec escapes (RT-65)
const NEEDS_ENCODING = /[\u0000\uffff\ud800-\udfff]/

/** True when `s` contains a code unit Postgres cannot store as is. */
export function needsPgTextEncoding(s: string): boolean {
	return NEEDS_ENCODING.test(s)
}

/** Encode a JS string for a Postgres TEXT (or JSONB string) value. */
export function encodePgText(s: string): string {
	if (!NEEDS_ENCODING.test(s)) return s
	let out = ''
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i)
		if (code === 0) {
			out += `${PG_TEXT_ESCAPE}0`
		} else if (code === 0xffff) {
			out += `${PG_TEXT_ESCAPE}F`
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = s.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += s.slice(i, i + 2)
				i++
			} else {
				out += `${PG_TEXT_ESCAPE}s${code.toString(16)}`
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			out += `${PG_TEXT_ESCAPE}s${code.toString(16)}`
		} else {
			out += s.charAt(i)
		}
	}
	return out
}

/** Decode a string written by {@link encodePgText}. */
export function decodePgText(s: string): string {
	if (!s.includes(PG_TEXT_ESCAPE)) return s
	let out = ''
	for (let i = 0; i < s.length; i++) {
		const char = s[i]
		if (char !== PG_TEXT_ESCAPE) {
			out += char
			continue
		}
		const tag = s[i + 1]
		if (tag === '0') {
			out += '\u0000'
			i += 1
		} else if (tag === 'F') {
			out += PG_TEXT_ESCAPE
			i += 1
		} else if (tag === 's') {
			const hex = s.slice(i + 2, i + 6)
			const code = Number.parseInt(hex, 16)
			if (hex.length === 4 && Number.isInteger(code) && code >= 0xd800 && code <= 0xdfff) {
				out += String.fromCharCode(code)
				i += 5
			} else {
				// Not written by the codec (a legacy row the migration did not reach): keep it.
				out += char
			}
		} else {
			out += char
		}
	}
	return out
}

/** Encode every string (and object key) inside a JSON value. */
export function encodePgJsonValue(value: unknown): unknown {
	return mapStrings(value, encodePgText)
}

/** Decode every string (and object key) inside a JSON value. */
export function decodePgJsonValue(value: unknown): unknown {
	return mapStrings(value, decodePgText)
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

/**
 * The one-time statements re-encoding rows written before the codec: every U+FFFF in
 * a TEXT or JSONB column becomes U+FFFF `F`, so the decoder returns it unchanged.
 *
 * @param table - Quoted table name
 * @param textColumns - Quoted TEXT columns holding raw strings
 * @param jsonbColumns - Quoted JSONB columns
 */
export function pgTextCodecMigrationSql(
	table: string,
	textColumns: string[],
	jsonbColumns: string[],
): string[] {
	const esc = "U&'\\FFFF'"
	const statements: string[] = []
	for (const column of textColumns) {
		statements.push(
			`UPDATE ${table} SET ${column} = replace(${column}, ${esc}, ${esc} || 'F') WHERE strpos(${column}, ${esc}) > 0`,
		)
	}
	for (const column of jsonbColumns) {
		statements.push(
			`UPDATE ${table} SET ${column} = replace(${column}::text, ${esc}, ${esc} || 'F')::jsonb WHERE strpos(${column}::text, ${esc}) > 0`,
		)
	}
	return statements
}

/** Field kinds stored as raw strings in TEXT columns (encoded with {@link encodePgText}). */
const RAW_TEXT_KINDS = new Set(['string', 'enum', 'secret'])
/** Field kinds stored in JSONB columns (strings inside encoded with {@link encodePgJsonValue}). */
const JSONB_KINDS = new Set(['array', 'object', 'json'])

/** True for a field kind whose Postgres column holds raw strings. */
export function isPgRawTextKind(kind: string): boolean {
	return RAW_TEXT_KINDS.has(kind)
}

/** True for a field kind whose Postgres column is JSONB. */
export function isPgJsonbKind(kind: string): boolean {
	return JSONB_KINDS.has(kind)
}

/** {@link serializeFieldValue} for a Postgres column: lossless for every JS string. */
export function serializePgFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (value === null || value === undefined) return null
	if (RAW_TEXT_KINDS.has(descriptor.kind) && typeof value === 'string') {
		return encodePgText(value)
	}
	if (JSONB_KINDS.has(descriptor.kind) && typeof value !== 'string') {
		return JSON.stringify(encodePgJsonValue(value))
	}
	return serializeFieldValue(value, descriptor)
}

/** {@link deserializeFieldValue} for a Postgres column written by {@link serializePgFieldValue}. */
export function deserializePgFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (value === null || value === undefined) return null
	if (RAW_TEXT_KINDS.has(descriptor.kind) && typeof value === 'string') {
		return decodePgText(value)
	}
	const parsed = deserializeFieldValue(value, descriptor)
	return JSONB_KINDS.has(descriptor.kind) ? decodePgJsonValue(parsed) : parsed
}

/** {@link serializeFieldValue} for a SQLite column: lossless for every JS string. */
export function serializeSqliteFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (RAW_TEXT_KINDS.has(descriptor.kind) && typeof value === 'string') return encodePgText(value)
	return serializeFieldValue(value, descriptor)
}

/** {@link deserializeFieldValue} for a SQLite column written by {@link serializeSqliteFieldValue}. */
export function deserializeSqliteFieldValue(value: unknown, descriptor: FieldDescriptor): unknown {
	if (RAW_TEXT_KINDS.has(descriptor.kind) && typeof value === 'string') return decodePgText(value)
	return deserializeFieldValue(value, descriptor)
}

/**
 * SQLite form of {@link pgTextCodecMigrationSql}: re-encode the U+FFFF of rows written
 * before the codec in raw-string columns.
 */
export function sqliteTextCodecMigrationSql(table: string, textColumns: string[]): string[] {
	return textColumns.map(
		(column) =>
			`UPDATE ${table} SET ${column} = replace(${column}, char(65535), char(65535) || 'F') WHERE instr(${column}, char(65535)) > 0`,
	)
}
