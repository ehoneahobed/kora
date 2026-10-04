import {
	type SqliteQueryFn,
	planPostgresConstraintRelaxation,
	planSqliteConstraintRelaxation,
} from '@korajs/core/internal'

/**
 * A generated migration statement that is not SQL but a directive: relax the value-domain
 * constraints (enum `CHECK`, `NOT NULL` on schema fields) of one collection table (RT-101).
 * Table constraints cannot be written portably (SQLite needs a table rebuild that depends
 * on the live table, Postgres an `ALTER TABLE ... DROP CONSTRAINT` by the constraint's
 * name), so `kora migrate --apply` expands the directive against each backend's catalog,
 * inside the migration's transaction. Expanding it on a relaxed table yields nothing.
 */
export const RELAX_VALUE_DOMAIN_DIRECTIVE = '--kora:relax-value-domain'

/** The payload of a relax-value-domain directive. */
export interface RelaxValueDomainTarget {
	/** The collection table */
	table: string
	/** The collection's schema fields (before and after the change) */
	fields: string[]
}

/** Render a directive statement for `target`. */
export function formatRelaxValueDomainDirective(target: RelaxValueDomainTarget): string {
	return `${RELAX_VALUE_DOMAIN_DIRECTIVE} ${JSON.stringify(target)}`
}

/**
 * The directive's target when `statement` is a relax-value-domain directive, otherwise null.
 *
 * @throws Error when the statement is a directive with a malformed payload
 */
export function parseRelaxValueDomainDirective(statement: string): RelaxValueDomainTarget | null {
	const trimmed = statement.trimStart()
	if (!trimmed.startsWith(RELAX_VALUE_DOMAIN_DIRECTIVE)) return null
	const payload = trimmed.slice(RELAX_VALUE_DOMAIN_DIRECTIVE.length).trim()
	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		parsed = null
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as { table?: unknown }).table !== 'string' ||
		!Array.isArray((parsed as { fields?: unknown }).fields) ||
		!(parsed as { fields: unknown[] }).fields.every((field) => typeof field === 'string')
	) {
		throw new Error(
			`Malformed migration directive "${statement}": expected ${RELAX_VALUE_DOMAIN_DIRECTIVE} {"table": "...", "fields": ["..."]}. Regenerate the migration with \`kora migrate\`.`,
		)
	}
	const target = parsed as RelaxValueDomainTarget
	return { table: target.table, fields: [...target.fields] }
}

/** The SQLite statements a directive expands to (a table rebuild, or nothing). */
export async function expandRelaxValueDomainForSqlite(
	target: RelaxValueDomainTarget,
	query: SqliteQueryFn,
): Promise<string[]> {
	return planSqliteConstraintRelaxation(query, [target.table])
}

/** The Postgres statements a directive expands to (`ALTER TABLE ... DROP ...`, or nothing). */
export async function expandRelaxValueDomainForPostgres(
	target: RelaxValueDomainTarget,
	query: SqliteQueryFn,
): Promise<string[]> {
	return planPostgresConstraintRelaxation(query, { [target.table]: target.fields })
}
