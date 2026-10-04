import type { FieldDescriptor } from '@korajs/core'
import {
	type SqliteQueryFn,
	type SqliteTableCatalog,
	collectionIndexName,
	isKoraInternalColumn,
	readSqliteTableCatalog,
	sqlDefaultLiteral,
} from '@korajs/core/internal'

/**
 * A generated migration statement that is not SQL but a directive: evolve one collection
 * table to a new set of schema fields and indexes (RT-105).
 *
 * The collection table is not Kora's alone to describe: a client store keeps `_version`
 * and `_field_versions` on it (and the relation's `REFERENCES`), each store creates its
 * own indexes, and Postgres server tables use other column types (BIGINT, DOUBLE
 * PRECISION, JSONB, BYTEA) than SQLite ones. A fixed statement list that re-creates the
 * table from the schema loses all of that. So `kora migrate --apply` expands the directive
 * against each backend's live catalog, inside the migration's transaction, and touches
 * only the schema fields and indexes it names:
 *
 * - an added field: `ALTER TABLE ... ADD COLUMN` (nothing when the column already exists)
 * - a removed field, or a field whose kind changed: Postgres `DROP COLUMN` /
 *   `ALTER COLUMN ... TYPE ... USING`; SQLite rebuilds the table from its catalog, copying
 *   every other column, primary key, foreign key, `UNIQUE` constraint, index and trigger as
 *   it is (only indexes on a removed column go)
 * - an added / removed index: `CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS`
 *
 * Expanding it on a table that already has the target shape yields nothing (idempotent).
 */
export const EVOLVE_TABLE_DIRECTIVE = '--kora:evolve-table'

/** What a directive needs to know about a field (JSON-serializable). */
export interface EvolveFieldSpec {
	kind: FieldDescriptor['kind']
	itemKind?: string
	enumValues?: string[]
	/** The field's default value (absent: no default) */
	default?: unknown
	auto?: boolean
}

/** The payload of an evolve-table directive. */
export interface EvolveTableTarget {
	/** The collection table */
	table: string
	/** Fields of the target schema that the table does not have */
	add: Record<string, EvolveFieldSpec>
	/** Fields the target schema no longer has */
	drop: string[]
	/** Fields whose kind (or array item kind) changed */
	change: Record<string, { from: EvolveFieldSpec; to: EvolveFieldSpec }>
	/** Fields that gained an index */
	addIndexes: string[]
	/** Fields that lost their index */
	removeIndexes: string[]
}

/** The spec of a schema field descriptor. */
export function evolveFieldSpec(descriptor: FieldDescriptor): EvolveFieldSpec {
	return {
		kind: descriptor.kind,
		...(descriptor.itemKind ? { itemKind: descriptor.itemKind } : {}),
		...(descriptor.enumValues ? { enumValues: [...descriptor.enumValues] } : {}),
		...(descriptor.defaultValue !== undefined ? { default: descriptor.defaultValue } : {}),
		...(descriptor.auto ? { auto: true } : {}),
	}
}

/** Render a directive statement for `target`. */
export function formatEvolveTableDirective(target: EvolveTableTarget): string {
	return `${EVOLVE_TABLE_DIRECTIVE} ${JSON.stringify(target)}`
}

/** Whether a directive changes nothing. */
export function isEmptyEvolveTarget(target: EvolveTableTarget): boolean {
	return (
		Object.keys(target.add).length === 0 &&
		target.drop.length === 0 &&
		Object.keys(target.change).length === 0 &&
		target.addIndexes.length === 0 &&
		target.removeIndexes.length === 0
	)
}

/**
 * The directive's target when `statement` is an evolve-table directive, otherwise null.
 *
 * @throws Error when the statement is a directive with a malformed payload
 */
export function parseEvolveTableDirective(statement: string): EvolveTableTarget | null {
	const trimmed = statement.trimStart()
	if (!trimmed.startsWith(EVOLVE_TABLE_DIRECTIVE)) return null
	const payload = trimmed.slice(EVOLVE_TABLE_DIRECTIVE.length).trim()
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		parsed = null
	}
	const target = parsed as Partial<EvolveTableTarget> | null
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === 'object' && value !== null && !Array.isArray(value)
	const isStrings = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((item) => typeof item === 'string')
	const isSpec = (value: unknown): value is EvolveFieldSpec =>
		isRecord(value) && typeof value.kind === 'string'
	if (
		!isRecord(target) ||
		typeof target.table !== 'string' ||
		!isRecord(target.add) ||
		!Object.values(target.add).every(isSpec) ||
		!isStrings(target.drop) ||
		!isRecord(target.change) ||
		!Object.values(target.change).every(
			(change) => isRecord(change) && isSpec(change.from) && isSpec(change.to),
		) ||
		!isStrings(target.addIndexes) ||
		!isStrings(target.removeIndexes)
	) {
		throw new Error(
			`Malformed migration directive "${statement}": expected ${EVOLVE_TABLE_DIRECTIVE} {"table", "add", "drop", "change", "addIndexes", "removeIndexes"}. Regenerate the migration with \`kora migrate\`.`,
		)
	}
	return {
		table: target.table,
		add: target.add as Record<string, EvolveFieldSpec>,
		drop: [...target.drop],
		change: target.change as EvolveTableTarget['change'],
		addIndexes: [...target.addIndexes],
		removeIndexes: [...target.removeIndexes],
	}
}

/**
 * The SQLite statements a directive expands to. Every column the directive does not name
 * (Kora's `id`, `_created_at`, `_updated_at`, `_version`, `_field_versions`, `_deleted`,
 * and anything else on the table) keeps its type, constraints, default and values.
 *
 * @param target - The directive's payload
 * @param query - Reads the catalog, inside the migration's transaction
 * @param now - Milliseconds since the epoch for `auto` timestamps of existing rows
 */
export async function expandEvolveTableForSqlite(
	target: EvolveTableTarget,
	query: SqliteQueryFn,
	now: number,
): Promise<string[]> {
	const catalog = await readSqliteTableCatalog(query, target.table)
	if (!catalog) return []
	const table = quoteIdentifier(target.table)
	const existing = new Map(
		catalog.columns.map((column) => [column.name, column.type.toUpperCase()]),
	)
	const plan = planColumns(target, existing, sqliteType)
	const statements: string[] = []

	const presentIndexes = await indexColumnsByName(query, target.table)
	const removedIndexNames = new Set(
		target.removeIndexes
			.flatMap((field) => koraIndexNames(target.table, field))
			.filter((name) => presentIndexes.has(name)),
	)
	for (const name of removedIndexNames) {
		statements.push(`DROP INDEX IF EXISTS ${quoteIdentifier(name)}`)
	}

	if (plan.drop.length > 0 || plan.change.length > 0) {
		statements.push(
			...(await sqliteRebuildStatements(catalog, plan, query, removedIndexNames, now)),
		)
	} else {
		for (const [field, spec] of plan.add) {
			statements.push(
				`ALTER TABLE ${table} ADD COLUMN ${quoteIdentifier(field)} ${sqliteType(spec)}${defaultClause(spec)}`,
			)
			if (spec.auto && spec.kind === 'timestamp' && spec.default === undefined) {
				statements.push(`UPDATE ${table} SET ${quoteIdentifier(field)} = ${now}`)
			}
		}
	}

	const indexed = await singleColumnIndexes(query, target.table, removedIndexNames)
	for (const field of target.addIndexes) {
		if (indexed.has(field)) continue
		statements.push(
			`CREATE INDEX IF NOT EXISTS ${koraIndexNames(target.table, field)[0]} ON ${table} (${quoteIdentifier(field)})`,
		)
	}
	return statements
}

/**
 * The Postgres statements a directive expands to (a server store's table: its types are
 * the server's, see `@korajs/server` materialization). Columns the directive does not
 * name are never touched.
 *
 * @param target - The directive's payload
 * @param query - Reads the catalog, inside the migration's transaction
 * @param now - Milliseconds since the epoch for `auto` timestamps of existing rows
 */
export async function expandEvolveTableForPostgres(
	target: EvolveTableTarget,
	query: SqliteQueryFn,
	now: number,
): Promise<string[]> {
	const columns = await query(
		`SELECT column_name::text AS name, upper(data_type::text) AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${sqlText(target.table)}`,
	)
	if (columns.length === 0) return []
	const table = quoteIdentifier(target.table)
	const existing = new Map(columns.map((row) => [String(row.name), String(row.type)]))
	const plan = planColumns(target, existing, postgresType)
	const statements: string[] = []

	const indexNames = new Set(
		(
			await query(
				`SELECT indexname::text AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ${sqlText(target.table)}`,
			)
		).map((row) => String(row.name)),
	)
	for (const field of target.removeIndexes) {
		// The server store creates `idx_<table>_<field>` unquoted, which Postgres folds to
		// lower case.
		const [serverName, clientName] = koraIndexNames(target.table, field)
		if (indexNames.has(serverName.toLowerCase())) {
			statements.push(`DROP INDEX IF EXISTS ${serverName}`)
		}
		if (indexNames.has(clientName)) {
			statements.push(`DROP INDEX IF EXISTS ${quoteIdentifier(clientName)}`)
		}
	}
	for (const field of plan.drop) {
		// Postgres drops the column's indexes and constraints with it.
		statements.push(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${quoteIdentifier(field)}`)
	}
	for (const [field, change] of plan.change) {
		const column = quoteIdentifier(field)
		const type = postgresType(change.to)
		statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`)
		statements.push(
			`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING CAST((${postgresProjection(column, change.from, change.to, now)}) AS ${type})`,
		)
		if (change.to.default !== undefined) {
			statements.push(
				`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${sqlDefaultLiteral(change.to.default)}`,
			)
		}
	}
	for (const [field, spec] of plan.add) {
		statements.push(
			`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(field)} ${postgresType(spec)}${defaultClause(spec)}`,
		)
		if (spec.auto && spec.kind === 'timestamp' && spec.default === undefined) {
			statements.push(`UPDATE ${table} SET ${quoteIdentifier(field)} = ${now}`)
		}
	}
	for (const field of target.addIndexes) {
		const name = koraIndexNames(target.table, field)[0]
		if (indexNames.has(name.toLowerCase())) continue
		statements.push(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${quoteIdentifier(field)})`)
	}
	return statements
}

interface ColumnPlan {
	add: Array<[string, EvolveFieldSpec]>
	drop: string[]
	change: Array<[string, { from: EvolveFieldSpec; to: EvolveFieldSpec }]>
}

/**
 * What to do with each named column, given the columns the table has now (name -> its
 * declared type, upper case). A column that already has the target shape is left alone,
 * so expanding the directive again yields nothing.
 */
function planColumns(
	target: EvolveTableTarget,
	existing: ReadonlyMap<string, string>,
	typeOf: (spec: EvolveFieldSpec) => string,
): ColumnPlan {
	const plan: ColumnPlan = { add: [], drop: [], change: [] }
	for (const [field, spec] of Object.entries(target.add)) {
		// A server that already started on the new schema added the column itself.
		if (!existing.has(field)) plan.add.push([field, spec])
	}
	for (const [field, change] of Object.entries(target.change)) {
		const current = existing.get(field)
		if (current === undefined) {
			plan.add.push([field, change.to])
			continue
		}
		const from = typeOf(change.from)
		const to = typeOf(change.to)
		// Already converted (the stored type is the target's and differs from the source's).
		if (from !== to && current === to) continue
		plan.change.push([field, change])
	}
	for (const field of target.drop) {
		if (existing.has(field) && !(field in target.add) && !(field in target.change)) {
			if (isKoraInternalColumn(field)) {
				throw new Error(
					`Migration directive refuses to drop Kora's own column "${field}" of "${target.table}".`,
				)
			}
			plan.drop.push(field)
		}
	}
	return plan
}

/**
 * SQLite's documented "other kinds of table schema changes" procedure, driven by the
 * live catalog: every column, constraint, index and trigger the directive does not name
 * is copied as it is.
 */
async function sqliteRebuildStatements(
	catalog: SqliteTableCatalog,
	plan: ColumnPlan,
	query: SqliteQueryFn,
	removedIndexNames: ReadonlySet<string>,
	now: number,
): Promise<string[]> {
	const table = catalog.table
	const temp = `_kora_evolve_${table}`
	const dropped = new Set(plan.drop)
	const changed = new Map(plan.change)
	const ordered = [...catalog.columns]
		.sort((a, b) => a.cid - b.cid)
		.filter((column) => !dropped.has(column.name))
	const pkColumns = ordered.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)

	const fkGroups = new Map<number, SqliteTableCatalog['foreignKeys'][number][]>()
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
		if (!first || group.some((fk) => dropped.has(fk.from))) continue
		const actions = foreignKeyActions(first)
		const targetRef = group.every((fk) => fk.to !== null && fk.to !== '')
			? `${quoteIdentifier(first.table)}(${group.map((fk) => quoteIdentifier(fk.to ?? '')).join(', ')})`
			: quoteIdentifier(first.table)
		if (group.length === 1) {
			columnReferences.set(first.from, `REFERENCES ${targetRef}${actions}`)
		} else {
			tableConstraints.push(
				`FOREIGN KEY (${group.map((fk) => quoteIdentifier(fk.from)).join(', ')}) REFERENCES ${targetRef}${actions}`,
			)
		}
	}
	if (pkColumns.length > 1) {
		tableConstraints.unshift(
			`PRIMARY KEY (${pkColumns.map((c) => quoteIdentifier(c.name)).join(', ')})`,
		)
	}
	for (const unique of catalog.uniqueConstraints) {
		if (unique.some((column) => dropped.has(column))) continue
		tableConstraints.push(`UNIQUE (${unique.map(quoteIdentifier).join(', ')})`)
	}

	const definitions: string[] = []
	const targetColumns: string[] = []
	const selections: string[] = []
	for (const column of ordered) {
		const change = changed.get(column.name)
		const parts = [quoteIdentifier(column.name)]
		if (change) {
			parts.push(sqliteType(change.to))
		} else if (column.type) {
			parts.push(column.type)
		}
		if (pkColumns.length === 1 && column.pk === 1) parts.push('PRIMARY KEY')
		if (column.notnull === 1) parts.push('NOT NULL')
		if (change) {
			if (change.to.default !== undefined) {
				parts.push(`DEFAULT ${sqlDefaultLiteral(change.to.default)}`)
			}
		} else if (column.dflt_value !== null) {
			parts.push(`DEFAULT (${column.dflt_value})`)
		}
		const reference = columnReferences.get(column.name)
		if (reference) parts.push(reference)
		definitions.push(parts.join(' '))
		targetColumns.push(quoteIdentifier(column.name))
		selections.push(
			change
				? sqliteProjection(quoteIdentifier(column.name), change.from, change.to, now)
				: quoteIdentifier(column.name),
		)
	}
	for (const [field, spec] of plan.add) {
		definitions.push(`${quoteIdentifier(field)} ${sqliteType(spec)}${defaultClause(spec)}`)
		targetColumns.push(quoteIdentifier(field))
		selections.push(fallbackLiteral(spec, now))
	}

	// Indexes on a dropped column cannot be re-created; the directive's removed indexes
	// are gone already. Every other index and trigger comes back exactly as it was.
	const indexColumns = await indexColumnsByName(query, table)
	const dependents: string[] = []
	for (const row of await query(
		`SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ${sqlText(table)} AND sql IS NOT NULL ORDER BY type, name`,
	)) {
		const name = String(row.name)
		if (row.type === 'index') {
			if (removedIndexNames.has(name)) continue
			if ((indexColumns.get(name) ?? []).some((column) => dropped.has(column))) continue
		}
		dependents.push(String(row.sql))
	}

	return [
		`DROP TABLE IF EXISTS ${quoteIdentifier(temp)}`,
		`CREATE TABLE ${quoteIdentifier(temp)} (\n  ${[...definitions, ...tableConstraints].join(',\n  ')}\n)`,
		`INSERT INTO ${quoteIdentifier(temp)} (${targetColumns.join(', ')}) SELECT ${selections.join(', ')} FROM ${quoteIdentifier(table)}`,
		`DROP TABLE ${quoteIdentifier(table)}`,
		`ALTER TABLE ${quoteIdentifier(temp)} RENAME TO ${quoteIdentifier(table)}`,
		...dependents,
	]
}

/** Index name -> its columns (null entries for expression columns are skipped). */
async function indexColumnsByName(
	query: SqliteQueryFn,
	table: string,
): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>()
	for (const index of await query(`SELECT name FROM pragma_index_list(${sqlText(table)})`)) {
		const name = String(index.name)
		const info = await query(`SELECT name FROM pragma_index_info(${sqlText(name)}) ORDER BY seqno`)
		out.set(
			name,
			info.filter((row) => typeof row.name === 'string').map((row) => String(row.name)),
		)
	}
	return out
}

/** Columns that already have a single-column index (any name, any store). */
async function singleColumnIndexes(
	query: SqliteQueryFn,
	table: string,
	ignore: ReadonlySet<string>,
): Promise<Set<string>> {
	const out = new Set<string>()
	for (const [name, columns] of await indexColumnsByName(query, table)) {
		if (ignore.has(name)) continue
		const only = columns[0]
		if (columns.length === 1 && only !== undefined) out.add(only)
	}
	return out
}

/**
 * Names Kora gives the index on `field`: the server stores' (and earlier CLI's)
 * `idx_<table>_<field>`, which a new index gets, and the client store's
 * collision-free name (STORE-15).
 */
function koraIndexNames(table: string, field: string): [string, string] {
	quoteIdentifier(table)
	quoteIdentifier(field)
	return [`idx_${table}_${field}`, collectionIndexName(table, field)]
}

function defaultClause(spec: EvolveFieldSpec): string {
	return spec.default !== undefined ? ` DEFAULT ${sqlDefaultLiteral(spec.default)}` : ''
}

/** The SQLite column type of a field (client and server stores agree). */
export function sqliteType(spec: EvolveFieldSpec): string {
	switch (spec.kind) {
		case 'number':
			return 'REAL'
		case 'boolean':
		case 'timestamp':
			return 'INTEGER'
		case 'richtext':
			return 'BLOB'
		default:
			return 'TEXT'
	}
}

/** The Postgres column type of a field (the Postgres server store's mapping). */
export function postgresType(spec: EvolveFieldSpec): string {
	switch (spec.kind) {
		case 'number':
			return 'DOUBLE PRECISION'
		case 'boolean':
			return 'INTEGER'
		case 'timestamp':
			return 'BIGINT'
		case 'array':
		case 'object':
		case 'json':
			return 'JSONB'
		case 'richtext':
			return 'BYTEA'
		default:
			return 'TEXT'
	}
}

function fallbackLiteral(target: EvolveFieldSpec, now: number): string {
	if (target.auto && target.kind === 'timestamp') return String(now)
	if (target.default !== undefined) return sqlDefaultLiteral(target.default)
	return 'NULL'
}

const NUMERIC_SOURCES: ReadonlySet<string> = new Set(['number', 'timestamp', 'boolean'])
const TEXT_SOURCES: ReadonlySet<string> = new Set(['string', 'enum'])
const TRUE_WORDS = "('1','true','t','yes','y','on')"
const FALSE_WORDS = "('0','false','f','no','n','off')"

/** The SQLite expression that converts a stored value of `source` kind to `target`. */
export function sqliteProjection(
	column: string,
	source: EvolveFieldSpec,
	target: EvolveFieldSpec,
	now: number,
): string {
	if (source.kind === target.kind && source.itemKind === target.itemKind) return column
	const fallback = fallbackLiteral(target, now)
	if (target.kind === 'string') return `CAST(${column} AS TEXT)`
	if (target.kind === 'number' || target.kind === 'timestamp') {
		if (NUMERIC_SOURCES.has(source.kind) || TEXT_SOURCES.has(source.kind)) {
			const castType = target.kind === 'number' ? 'REAL' : 'INTEGER'
			return `CASE WHEN ${column} IS NULL THEN NULL ELSE CAST(${column} AS ${castType}) END`
		}
	}
	if (target.kind === 'boolean') {
		if (NUMERIC_SOURCES.has(source.kind)) {
			return `CASE WHEN ${column} IS NULL THEN NULL WHEN CAST(${column} AS REAL) = 0 THEN 0 ELSE 1 END`
		}
		if (TEXT_SOURCES.has(source.kind)) {
			const word = `LOWER(TRIM(CAST(${column} AS TEXT)))`
			return `CASE WHEN ${column} IS NULL THEN NULL WHEN ${word} IN ${TRUE_WORDS} THEN 1 WHEN ${word} IN ${FALSE_WORDS} THEN 0 ELSE ${fallback} END`
		}
	}
	if (target.kind === 'enum' && target.enumValues && target.enumValues.length > 0) {
		if (TEXT_SOURCES.has(source.kind)) {
			const allowed = target.enumValues.map((value) => sqlDefaultLiteral(value)).join(', ')
			return `CASE WHEN ${column} IN (${allowed}) THEN ${column} ELSE ${fallback} END`
		}
	}
	return fallback
}

/** The Postgres expression (for `USING`) that converts `source` kind to `target`. */
export function postgresProjection(
	column: string,
	source: EvolveFieldSpec,
	target: EvolveFieldSpec,
	now: number,
): string {
	if (source.kind === target.kind && source.itemKind === target.itemKind) return column
	const fallback = fallbackLiteral(target, now)
	const text = `(${column})::text`
	if (target.kind === 'string') return text
	if (target.kind === 'number' || target.kind === 'timestamp') {
		const toTarget = (value: string): string =>
			target.kind === 'number' ? value : `round(${value})::bigint`
		if (NUMERIC_SOURCES.has(source.kind)) {
			return `CASE WHEN ${column} IS NULL THEN NULL ELSE ${toTarget(`(${column})::double precision`)} END`
		}
		if (TEXT_SOURCES.has(source.kind)) {
			const trimmed = `btrim(${text})`
			return `CASE WHEN ${column} IS NULL THEN NULL WHEN ${trimmed} ~ '^[-+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][-+]?[0-9]+)?$' THEN ${toTarget(`(${trimmed})::double precision`)} ELSE ${fallback} END`
		}
	}
	if (target.kind === 'boolean') {
		if (NUMERIC_SOURCES.has(source.kind)) {
			return `CASE WHEN ${column} IS NULL THEN NULL WHEN (${column})::double precision = 0 THEN 0 ELSE 1 END`
		}
		if (TEXT_SOURCES.has(source.kind)) {
			const word = `lower(btrim(${text}))`
			return `CASE WHEN ${column} IS NULL THEN NULL WHEN ${word} IN ${TRUE_WORDS} THEN 1 WHEN ${word} IN ${FALSE_WORDS} THEN 0 ELSE ${fallback} END`
		}
	}
	if (target.kind === 'enum' && target.enumValues && target.enumValues.length > 0) {
		if (TEXT_SOURCES.has(source.kind)) {
			const allowed = target.enumValues.map((value) => sqlDefaultLiteral(value)).join(', ')
			return `CASE WHEN ${text} IN (${allowed}) THEN ${text} ELSE ${fallback} END`
		}
	}
	return fallback
}

function foreignKeyActions(fk: SqliteTableCatalog['foreignKeys'][number]): string {
	let out = ''
	const onDelete = fk.on_delete?.toUpperCase()
	const onUpdate = fk.on_update?.toUpperCase()
	if (onDelete && onDelete !== 'NO ACTION') out += ` ON DELETE ${onDelete}`
	if (onUpdate && onUpdate !== 'NO ACTION') out += ` ON UPDATE ${onUpdate}`
	return out
}

function sqlText(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

function quoteIdentifier(identifier: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
		throw new Error(`Invalid SQL identifier: ${identifier}`)
	}
	return `"${identifier}"`
}
