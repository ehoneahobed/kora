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

import {
	STORED_TEXT_ESCAPE,
	decodeStoredJsonValue,
	decodeStoredText,
	encodeStoredJsonValue,
	encodeStoredText,
	needsStoredTextEncoding,
} from '@korajs/core'
import type { FieldDescriptor } from '@korajs/core'
import { deserializeFieldValue, serializeFieldValue } from './materialization'

// The codec itself is core's (`@korajs/core` stored-text), shared with the client
// stores, so a value escapes identically on every device and server.

/** The escape introducer: U+FFFF, a noncharacter. */
export const PG_TEXT_ESCAPE = STORED_TEXT_ESCAPE

/** `kora_server_meta` key prefix marking a table whose legacy U+FFFF rows were re-encoded. */
export const PG_TEXT_CODEC_MIGRATION_KEY = 'pg_text_codec_v1:'

/** True when `s` contains a code unit Postgres cannot store as is. */
export const needsPgTextEncoding: (s: string) => boolean = needsStoredTextEncoding

/** Encode a JS string for a Postgres TEXT (or JSONB string) value. */
export const encodePgText: (s: string) => string = encodeStoredText

/** Decode a string written by {@link encodePgText}. */
export const decodePgText: (s: string) => string = decodeStoredText

/** Encode every string (and object key) inside a JSON value. */
export const encodePgJsonValue: (value: unknown) => unknown = encodeStoredJsonValue

/** Decode every string (and object key) inside a JSON value. */
export const decodePgJsonValue: (value: unknown) => unknown = decodeStoredJsonValue

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
