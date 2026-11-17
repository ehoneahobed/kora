import { quoteIdent } from '@korajs/core'
import type { FieldDescriptor } from '@korajs/core'
import { type SqlDialect, isTextColumn } from './materialization'

/**
 * The query contract every server store follows (memory, SQLite, Postgres):
 *
 * - `where { field: value }` matches the stored value; `null` matches a field that is null
 *   or absent (`IS NULL`).
 * - `orderBy` puts nulls last in both directions; strings compare by code point (UTF-8 byte
 *   order: SQLite's BINARY collation, Postgres `COLLATE "C"`).
 * - `id` breaks every tie and is the order when none is given, so pages are stable.
 */

/** Compare two non-null values as the SQL stores order them. */
export function compareQueryValues(a: unknown, b: unknown): number {
	if (typeof a === 'string' && typeof b === 'string') {
		// Code point order (UTF-16 `<` differs from it for astral characters).
		const left = a[Symbol.iterator]()
		const right = b[Symbol.iterator]()
		for (;;) {
			const l = left.next()
			const r = right.next()
			if (l.done || r.done) return l.done === r.done ? 0 : l.done ? -1 : 1
			const diff = (l.value.codePointAt(0) as number) - (r.value.codePointAt(0) as number)
			if (diff !== 0) return diff
		}
	}
	const left = Number(a)
	const right = Number(b)
	return left < right ? -1 : left > right ? 1 : 0
}

/** Order records by the contract: `field` with nulls last, then `id`. */
export function compareRecordsForQuery(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	field: string | undefined,
	direction: 'asc' | 'desc' | undefined,
): number {
	if (field) {
		const av = a[field] ?? null
		const bv = b[field] ?? null
		if (av === null && bv !== null) return 1
		if (bv === null && av !== null) return -1
		if (av !== null && bv !== null) {
			const order = compareQueryValues(av, bv)
			if (order !== 0) return direction === 'desc' ? -order : order
		}
	}
	return compareQueryValues(a.id, b.id)
}

/** The `ORDER BY` clause of the contract, for a SQL store. */
export function orderByClause(
	dialect: SqlDialect,
	field: string | undefined,
	direction: 'asc' | 'desc' | undefined,
	descriptor: FieldDescriptor | undefined,
): string {
	const collate = dialect === 'postgres' ? ' COLLATE "C"' : ''
	const id = `${quoteIdent('id')}${collate} ASC`
	if (!field) return ` ORDER BY ${id}`
	const column = quoteIdent(field)
	const text = descriptor ? isTextColumn(descriptor, dialect) : false
	const dir = direction === 'desc' ? 'DESC' : 'ASC'
	return ` ORDER BY (${column} IS NULL), ${column}${text ? collate : ''} ${dir}, ${id}`
}
