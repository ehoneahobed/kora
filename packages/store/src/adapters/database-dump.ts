import { quoteIdent } from '@korajs/core'
import { PersistenceError } from '../errors'

/**
 * Logical copy of every user table of a SQLite database. Used to move a
 * database between storage backends (OPFS <-> IndexedDB) explicitly, and as the
 * IndexedDB adapter's durable snapshot format.
 */
export interface DatabaseDump {
	tables: Array<{
		name: string
		/**
		 * The table's `CREATE TABLE` statement (from `sqlite_master`), so a restore can
		 * recreate a table the target database does not have yet with its constraints.
		 * Absent in dumps written before it was recorded.
		 */
		sql?: string
		columns: string[]
		rows: Array<Record<string, unknown>>
	}>
}

/** A parameterized SQL statement. */
export interface DumpStatement {
	sql: string
	params?: unknown[]
}

type QueryFn = <T>(sql: string, params?: unknown[]) => Promise<T[]>

/** Throws unless `identifier` is a plain SQL identifier (dump data is untrusted). */
export function ensureSafeIdentifier(identifier: string): string {
	if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
		throw new PersistenceError(`Unsafe SQL identifier: ${identifier}`, {
			code: 'UNSAFE_IDENTIFIER',
			identifier,
		})
	}
	return identifier
}

/**
 * Read every user table through `query`. Pass a transaction's `query` to get a
 * consistent snapshot.
 */
export async function exportDump(query: QueryFn): Promise<DatabaseDump> {
	const tableRows = await query<{ name: string; sql: string | null }>(
		"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
	)
	const tables: DatabaseDump['tables'] = []
	for (const tableRow of tableRows) {
		const tableName = ensureSafeIdentifier(tableRow.name)
		const columns = await query<{ name: string }>(`PRAGMA table_info(${quoteIdent(tableName)})`)
		const rows = await query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(tableName)}`)
		tables.push({
			name: tableName,
			...(typeof tableRow.sql === 'string' ? { sql: tableRow.sql } : {}),
			columns: columns.map((column) => column.name),
			rows,
		})
	}
	return { tables }
}

/**
 * Statements that replace the contents of each dumped table with the dump's
 * rows. Run them inside one transaction so a failure leaves the target as it was.
 *
 * A table the target does not have yet (the store creates some of its bookkeeping
 * tables after the schema DDL) is created first from the dump's recorded `CREATE TABLE`
 * statement, constraints included. A dump written before statements were recorded
 * creates it untyped, so its rows are still restored.
 *
 * @param createMissingTables - Kept for callers that restore into scratch databases
 *   with no schema; missing tables are always created now.
 */
export function restoreDumpStatements(
	dump: DatabaseDump,
	_createMissingTables = true,
): DumpStatement[] {
	const statements: DumpStatement[] = []
	for (const table of dump.tables) {
		const name = quoteIdent(ensureSafeIdentifier(table.name))
		const create = createTableIfNotExists(table.name, table.sql)
		if (create) {
			statements.push({ sql: create })
		} else {
			const columns = table.columns.map((column) => quoteIdent(ensureSafeIdentifier(column)))
			if (columns.length === 0) continue
			statements.push({ sql: `CREATE TABLE IF NOT EXISTS ${name} (${columns.join(', ')})` })
		}
		statements.push({ sql: `DELETE FROM ${name}` })
		for (const row of table.rows) {
			const columns = table.columns.filter((column) =>
				Object.prototype.hasOwnProperty.call(row, column),
			)
			if (columns.length === 0) continue
			const quotedColumns = columns
				.map((column) => quoteIdent(ensureSafeIdentifier(column)))
				.join(', ')
			statements.push({
				sql: `INSERT INTO ${name} (${quotedColumns}) VALUES (${columns.map(() => '?').join(', ')})`,
				params: columns.map((column) => row[column]),
			})
		}
	}
	return statements
}

/**
 * The recorded `CREATE TABLE` statement made idempotent, or null when there is none or
 * it is not a single plain `CREATE TABLE` of exactly this table (dump data is untrusted).
 */
function createTableIfNotExists(tableName: string, sql: string | undefined): string | null {
	if (typeof sql !== 'string' || sql.includes(';')) return null
	const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)([A-Za-z0-9_]+)\1\s*\(/i.exec(
		sql,
	)
	if (!match || match[2] !== tableName) return null
	return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} ${sql.slice(match[0].length - 1)}`
}
