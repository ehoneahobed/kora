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
	const tableRows = await query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
	)
	const tables: DatabaseDump['tables'] = []
	for (const tableRow of tableRows) {
		const tableName = ensureSafeIdentifier(tableRow.name)
		const columns = await query<{ name: string }>(`PRAGMA table_info(${quoteIdent(tableName)})`)
		const rows = await query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(tableName)}`)
		tables.push({ name: tableName, columns: columns.map((column) => column.name), rows })
	}
	return { tables }
}

/**
 * Statements that replace the contents of each dumped table with the dump's
 * rows. Run them inside one transaction so a failure leaves the target as it was.
 *
 * @param createMissingTables - Also create untyped tables first (for scratch
 *   databases that have no schema, such as the unsynced-data check before a delete).
 */
export function restoreDumpStatements(
	dump: DatabaseDump,
	createMissingTables = false,
): DumpStatement[] {
	const statements: DumpStatement[] = []
	for (const table of dump.tables) {
		const name = quoteIdent(ensureSafeIdentifier(table.name))
		if (createMissingTables) {
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
