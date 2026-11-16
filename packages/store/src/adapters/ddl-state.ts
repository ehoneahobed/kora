/**
 * The DDL fingerprint a database keeps (`_kora_ddl_state`): the SQLite WASM worker skips the
 * schema DDL when it matches, and the store clears it before any migration runs.
 */
/** Where the worker records which DDL last ran on the database (see applyDdlUnlessUnchanged). */
export const DDL_STATE_TABLE_SQL =
	'CREATE TABLE IF NOT EXISTS _kora_ddl_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)'

/** A fingerprint of the DDL statements (two FNV-1a passes; equality only, not security). */
export function ddlFingerprint(statements: readonly string[]): string {
	let a = 0x811c9dc5
	let b = 0x01000193
	for (const statement of statements) {
		for (let index = 0; index < statement.length; index += 1) {
			const code = statement.charCodeAt(index)
			a = Math.imul(a ^ code, 0x01000193) >>> 0
			b = Math.imul(b ^ code, 0x811c9dc5) >>> 0
		}
		a = Math.imul(a ^ 0x0a, 0x01000193) >>> 0
		b = Math.imul(b ^ 0x0a, 0x811c9dc5) >>> 0
	}
	return `${statements.length}:${a.toString(16)}:${b.toString(16)}`
}
