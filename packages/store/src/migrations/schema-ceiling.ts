/**
 * The schema-version ceiling (RT-109): a build never runs against a database a newer
 * build already migrated.
 *
 * `generateFullDDL` emits `--kora:schema-ceiling <version>` right after `_kora_meta`, before
 * any other DDL. It is a SQL comment; Kora's DDL executors (the native adapter, the SQLite
 * WASM worker, the test bridge) stop there with {@link schemaAheadMessage} when the
 * database's stored schema version is newer, so not even this build's additive DDL touches
 * it. The store then maps the failure to `SchemaVersionAheadError` and checks again after
 * every open (adapters that restore data after their DDL, such as the IndexedDB fallback).
 *
 * No imports: the SQLite WASM worker bundles this file.
 */

const DIRECTIVE = /^--kora:schema-ceiling (\d+)$/
const AHEAD = /KORA_SCHEMA_VERSION_AHEAD stored=(\d+) code=(\d+)/

/** The version a `--kora:schema-ceiling <version>` DDL statement names, or null. */
export function parseSchemaCeiling(sql: string): number | null {
	const match = DIRECTIVE.exec(sql.trim())
	return match ? Number(match[1]) : null
}

/** The stored version from a `_kora_meta` row read, or 0 when none is stored. */
export function storedSchemaVersion(rows: ReadonlyArray<{ value: unknown }>): number {
	const value = Number(rows[0]?.value ?? 0)
	return Number.isFinite(value) ? value : 0
}

/** The message a DDL executor throws when the database is ahead (parsed back by the store). */
export function schemaAheadMessage(stored: number, code: number): string {
	return `KORA_SCHEMA_VERSION_AHEAD stored=${stored} code=${code}: the database was migrated by a newer build (schema version ${stored}); this build's schema version is ${code}.`
}

/** The versions in an error raised by {@link schemaAheadMessage}, wherever it was wrapped. */
export function parseSchemaAhead(error: unknown): { stored: number; code: number } | null {
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current !== null && current !== undefined && !seen.has(current)) {
		seen.add(current)
		const text =
			current instanceof Error ? current.message : typeof current === 'string' ? current : ''
		const match = AHEAD.exec(text)
		if (match) return { stored: Number(match[1]), code: Number(match[2]) }
		current = current instanceof Error ? (current as { cause?: unknown }).cause : null
	}
	return null
}

/** Query the stored schema version through a synchronous runner (DDL executors). */
export const STORED_SCHEMA_VERSION_SQL = "SELECT value FROM _kora_meta WHERE key = 'schema_version'"
