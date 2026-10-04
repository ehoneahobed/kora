import { quoteIdent } from './quote-ident'

/**
 * Value-domain rules live in validation only (RT-101).
 *
 * Kora's generated DDL used to restate two schema rules as storage constraints: an enum
 * field's `CHECK (col IN (...))` and a required field's `NOT NULL`. The value domain
 * already enforces both at write time on every replica, and storage constraints cannot
 * evolve with the schema (SQLite cannot alter a column constraint): an enum value added
 * by a schema upgrade was valid everywhere but refused by every existing table. The DDL
 * no longer emits them, and existing tables are relaxed once, by these helpers.
 *
 * Kora's own bookkeeping columns (`id` and every `_`-prefixed column) keep their
 * constraints: they are written by Kora only and never evolve with the app schema.
 */

/** A row of `PRAGMA table_info(<table>)`. */
export interface SqliteColumnInfo {
	cid: number
	name: string
	type: string
	notnull: number
	dflt_value: string | null
	pk: number
}

/** A row of `PRAGMA foreign_key_list(<table>)`. */
export interface SqliteForeignKeyInfo {
	id: number
	seq: number
	table: string
	from: string
	to: string | null
	on_update: string
	on_delete: string
	match?: string
}

/** What a SQLite table looks like, read from its catalog. */
export interface SqliteTableCatalog {
	/** Table name */
	table: string
	/** The table's `CREATE TABLE` statement (`sqlite_master.sql`) */
	sql: string
	columns: readonly SqliteColumnInfo[]
	foreignKeys: readonly SqliteForeignKeyInfo[]
	/** Column lists of the table's `UNIQUE` constraints (`index_list` origin `u`) */
	uniqueConstraints: readonly (readonly string[])[]
	/** `CREATE INDEX` / `CREATE TRIGGER` statements on the table (`sqlite_master.sql`) */
	dependents: readonly string[]
}

/** Columns Kora writes itself; their constraints are kept. */
export function isKoraInternalColumn(name: string): boolean {
	return name === 'id' || name.startsWith('_')
}

/**
 * The SQL with string literals and quoted identifiers blanked out, so a default value
 * or a column name that contains the text `CHECK (` is never mistaken for a constraint.
 */
function stripQuoted(sql: string): string {
	return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, ' ')
}

/**
 * Whether a table still carries a value-domain constraint: a `CHECK`, or `NOT NULL` on a
 * column that is not Kora's own.
 */
export function sqliteTableNeedsRelaxation(catalog: SqliteTableCatalog): boolean {
	if (/\bCHECK\s*\(/i.test(stripQuoted(catalog.sql))) return true
	return catalog.columns.some(
		(column) => column.notnull === 1 && !isKoraInternalColumn(column.name),
	)
}

/**
 * Statements that rebuild a SQLite table without value-domain constraints (SQLite's
 * documented "make other kinds of table schema changes" procedure), keeping every row,
 * column (types and defaults), primary key, foreign key, `UNIQUE` constraint, index and
 * trigger. Run them in ONE transaction, with foreign key enforcement off when the
 * database enforces foreign keys (the drop of a referenced table would otherwise fail
 * or fire its actions). Returns an empty list when the table needs nothing, so running
 * it again is a no-op (idempotent); a rebuild interrupted mid-way rolls back with its
 * transaction and runs again at the next open (resumable).
 *
 * @param catalog - The table as read from SQLite's catalog
 * @returns The rebuild statements, or `[]`
 */
export function sqliteConstraintRelaxationStatements(catalog: SqliteTableCatalog): string[] {
	if (!sqliteTableNeedsRelaxation(catalog)) return []
	const table = catalog.table
	const temp = `_kora_relax_${table}`
	const ordered = [...catalog.columns].sort((a, b) => a.cid - b.cid)
	const pkColumns = ordered.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)

	const fkGroups = new Map<number, SqliteForeignKeyInfo[]>()
	for (const fk of catalog.foreignKeys) {
		const group = fkGroups.get(fk.id) ?? []
		group.push(fk)
		fkGroups.set(fk.id, group)
	}
	const columnReferences = new Map<string, string>()
	const tableConstraints: string[] = []
	for (const group of fkGroups.values()) {
		group.sort((a, b) => a.seq - b.seq)
		const first = group[0]
		if (!first) continue
		const actions = foreignKeyActions(first)
		const target = group.every((fk) => fk.to !== null && fk.to !== '')
			? `${quoteIdent(first.table)}(${group.map((fk) => quoteIdent(fk.to ?? '')).join(', ')})`
			: quoteIdent(first.table)
		if (group.length === 1) {
			columnReferences.set(first.from, `REFERENCES ${target}${actions}`)
		} else {
			tableConstraints.push(
				`FOREIGN KEY (${group.map((fk) => quoteIdent(fk.from)).join(', ')}) REFERENCES ${target}${actions}`,
			)
		}
	}
	if (pkColumns.length > 1) {
		tableConstraints.unshift(`PRIMARY KEY (${pkColumns.map((c) => quoteIdent(c.name)).join(', ')})`)
	}
	for (const unique of catalog.uniqueConstraints) {
		tableConstraints.push(`UNIQUE (${unique.map(quoteIdent).join(', ')})`)
	}

	const definitions = ordered.map((column) => {
		const parts = [quoteIdent(column.name)]
		if (column.type) parts.push(column.type)
		if (pkColumns.length === 1 && column.pk === 1) parts.push('PRIMARY KEY')
		if (column.notnull === 1 && isKoraInternalColumn(column.name)) parts.push('NOT NULL')
		if (column.dflt_value !== null) parts.push(`DEFAULT (${column.dflt_value})`)
		const reference = columnReferences.get(column.name)
		if (reference) parts.push(reference)
		return parts.join(' ')
	})

	const columnList = ordered.map((column) => quoteIdent(column.name)).join(', ')
	return [
		`DROP TABLE IF EXISTS ${quoteIdent(temp)}`,
		`CREATE TABLE ${quoteIdent(temp)} (\n  ${[...definitions, ...tableConstraints].join(',\n  ')}\n)`,
		`INSERT INTO ${quoteIdent(temp)} (${columnList}) SELECT ${columnList} FROM ${quoteIdent(table)}`,
		`DROP TABLE ${quoteIdent(table)}`,
		`ALTER TABLE ${quoteIdent(temp)} RENAME TO ${quoteIdent(table)}`,
		...catalog.dependents,
	]
}

function foreignKeyActions(fk: SqliteForeignKeyInfo): string {
	let out = ''
	const onDelete = fk.on_delete?.toUpperCase()
	const onUpdate = fk.on_update?.toUpperCase()
	if (onDelete && onDelete !== 'NO ACTION') out += ` ON DELETE ${onDelete}`
	if (onUpdate && onUpdate !== 'NO ACTION') out += ` ON UPDATE ${onUpdate}`
	return out
}

/**
 * Whether a Postgres `CHECK` constraint definition (`pg_get_constraintdef`) is a Kora enum
 * check: one column compared to a literal list. Postgres stores `col IN ('a', 'b')` as
 * `CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))`. Other checks (added by hand) are
 * left alone.
 *
 * @param definition - The constraint definition text
 */
export function isPostgresEnumCheckDefinition(definition: string): boolean {
	return /^CHECK\s*\(\(*\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\)?::text)?\s*=\s*ANY\s*\(\s*(?:\(\s*)?ARRAY\[/i.test(
		definition.trim(),
	)
}

/** Runs a read-only SQL statement and returns its rows (an adapter's or a transaction's query). */
export type SqliteQueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>

function sqlText(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

/**
 * Read a SQLite table's catalog through `query`, or null when the table does not exist.
 *
 * @param query - Runs a SELECT/PRAGMA and returns rows
 * @param table - The table name
 */
export async function readSqliteTableCatalog(
	query: SqliteQueryFn,
	table: string,
): Promise<SqliteTableCatalog | null> {
	const master = await query(
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${sqlText(table)}`,
	)
	const tableSql = master[0]?.sql
	if (typeof tableSql !== 'string') return null
	const columns = await query(
		`SELECT cid, name, type, "notnull" AS "notnull", dflt_value, pk FROM pragma_table_info(${sqlText(table)})`,
	)
	const foreignKeys = await query(
		`SELECT id, seq, "table" AS "table", "from" AS "from", "to" AS "to", on_update, on_delete FROM pragma_foreign_key_list(${sqlText(table)})`,
	)
	const uniqueConstraints: string[][] = []
	const indexes = await query(
		`SELECT name FROM pragma_index_list(${sqlText(table)}) WHERE origin = 'u'`,
	)
	for (const index of indexes) {
		const info = await query(
			`SELECT name FROM pragma_index_info(${sqlText(String(index.name))}) ORDER BY seqno`,
		)
		uniqueConstraints.push(info.map((row) => String(row.name)))
	}
	const dependents = await query(
		`SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ${sqlText(table)} AND sql IS NOT NULL ORDER BY type, name`,
	)
	return {
		table,
		sql: tableSql,
		columns: columns.map((c) => ({
			cid: Number(c.cid),
			name: String(c.name),
			type: typeof c.type === 'string' ? c.type : '',
			notnull: Number(c.notnull),
			dflt_value: typeof c.dflt_value === 'string' ? c.dflt_value : null,
			pk: Number(c.pk),
		})),
		foreignKeys: foreignKeys.map((fk) => ({
			id: Number(fk.id),
			seq: Number(fk.seq),
			table: String(fk.table),
			from: String(fk.from),
			to: typeof fk.to === 'string' ? fk.to : null,
			on_update: String(fk.on_update ?? 'NO ACTION'),
			on_delete: String(fk.on_delete ?? 'NO ACTION'),
		})),
		uniqueConstraints,
		dependents: dependents.map((row) => String(row.sql)),
	}
}

/**
 * Every statement that relaxes the given SQLite tables (one rebuild per table that still
 * carries a value-domain constraint; tables that do not exist or need nothing are
 * skipped). Run them in one transaction; see {@link sqliteConstraintRelaxationStatements}.
 *
 * @param query - Runs a SELECT/PRAGMA and returns rows (inside the caller's transaction)
 * @param tables - The collection tables to check
 * @returns The statements, or `[]` when every table is already relaxed (idempotent)
 */
export async function planSqliteConstraintRelaxation(
	query: SqliteQueryFn,
	tables: readonly string[],
): Promise<string[]> {
	const statements: string[] = []
	for (const table of tables) {
		const catalog = await readSqliteTableCatalog(query, table)
		if (catalog) statements.push(...sqliteConstraintRelaxationStatements(catalog))
	}
	return statements
}

/**
 * The `ALTER TABLE` statements that relax Postgres collection tables: drop every Kora enum
 * `CHECK` (one column compared to a literal list, see {@link isPostgresEnumCheckDefinition})
 * and every `NOT NULL` on a schema field. Kora's own columns, multi-column checks and
 * checks of any other shape (added by hand) are kept. Reads the catalog of the current
 * schema through `query`, so run it and the statements in one transaction.
 *
 * @param query - Runs a SELECT and returns rows
 * @param fieldsByTable - Collection table name to its schema field names
 * @returns The statements, or `[]` when nothing is left to relax (idempotent)
 */
export async function planPostgresConstraintRelaxation(
	query: SqliteQueryFn,
	fieldsByTable: Readonly<Record<string, readonly string[]>>,
): Promise<string[]> {
	const tables = Object.keys(fieldsByTable)
	if (tables.length === 0) return []
	const tableList = tables.map(sqlText).join(', ')
	const statements: string[] = []
	const checks = await query(
		`SELECT rel.relname::text AS table_name, con.conname::text AS name, pg_get_constraintdef(con.oid) AS definition,
			(SELECT array_agg(att.attname::text) FROM pg_attribute att WHERE att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)) AS columns
		FROM pg_constraint con
		JOIN pg_class rel ON rel.oid = con.conrelid
		JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
		WHERE con.contype = 'c' AND nsp.nspname = current_schema() AND rel.relname IN (${tableList})
		ORDER BY rel.relname, con.conname`,
	)
	for (const check of checks) {
		const columns = Array.isArray(check.columns) ? check.columns.map(String) : []
		const column = columns[0]
		if (columns.length !== 1 || column === undefined || isKoraInternalColumn(column)) continue
		if (!isPostgresEnumCheckDefinition(String(check.definition))) continue
		statements.push(
			`ALTER TABLE ${quoteIdent(String(check.table_name))} DROP CONSTRAINT IF EXISTS ${quoteIdent(String(check.name))}`,
		)
	}
	const notNull = await query(
		`SELECT rel.relname::text AS table_name, att.attname::text AS column_name
		FROM pg_attribute att
		JOIN pg_class rel ON rel.oid = att.attrelid
		JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
		WHERE att.attnotnull AND att.attnum > 0 AND NOT att.attisdropped
			AND rel.relkind = 'r' AND nsp.nspname = current_schema() AND rel.relname IN (${tableList})
		ORDER BY rel.relname, att.attnum`,
	)
	for (const row of notNull) {
		const table = String(row.table_name)
		const column = String(row.column_name)
		if (isKoraInternalColumn(column)) continue
		if (!(fieldsByTable[table] ?? []).includes(column)) continue
		statements.push(
			`ALTER TABLE ${quoteIdent(table)} ALTER COLUMN ${quoteIdent(column)} DROP NOT NULL`,
		)
	}
	return statements
}
