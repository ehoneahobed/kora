import type { CollectionDefinition, FieldDescriptor } from '@korajs/core'
import { quoteIdent } from '@korajs/core'
import { QueryError } from '../errors'
import { lwwVersionWhereClause } from '../lww/row-version'
import { encodeStoredFilterValue } from '../serialization/serializer'
import type { QueryDescriptor, WhereOperators } from '../types'

/**
 * Result of building a SQL query: the parameterized SQL string and its bound values.
 */
export interface SqlQuery {
	sql: string
	params: unknown[]
}

/**
 * Build a SELECT query from a QueryDescriptor.
 * Automatically adds `WHERE _deleted = 0` to exclude soft-deleted records.
 *
 * @param descriptor - The query descriptor
 * @param fields - The field descriptors from the collection schema
 * @returns A parameterized SQL query
 */
export function buildSelectQuery(
	descriptor: QueryDescriptor,
	fields: Record<string, FieldDescriptor>,
): SqlQuery {
	const params: unknown[] = []
	const parts = [`SELECT * FROM ${quoteIdent(descriptor.collection)}`]

	const whereClause = buildWhereClauseParts(descriptor.where, fields, params)
	// Always filter out soft-deleted records
	const deletedFilter = '_deleted = 0'
	if (whereClause) {
		parts.push(`WHERE ${deletedFilter} AND ${whereClause}`)
	} else {
		parts.push(`WHERE ${deletedFilter}`)
	}

	if (descriptor.orderBy.length > 0) {
		const orderParts = descriptor.orderBy.map((o) => {
			validateFieldName(o.field, fields)
			// SEC-7: the direction is whitelisted to a fixed keyword, never spliced from
			// the caller's string (a runtime value cast to the type is untrusted input).
			return `${quoteIdent(resolveColumnName(o.field, fields))} ${sqlSortDirection(o.direction, o.field)}`
		})
		parts.push(`ORDER BY ${orderParts.join(', ')}`)
	}

	// SEC-7: LIMIT / OFFSET are bound as parameters after a safe-integer check, so a
	// value that only claims to be a number can never become SQL text.
	const limit = descriptor.limit !== undefined ? assertQueryCount(descriptor.limit, 'limit') : null
	const offset =
		descriptor.offset !== undefined ? assertQueryCount(descriptor.offset, 'offset') : null
	if (limit !== null) {
		parts.push('LIMIT ?')
		params.push(limit)
	}
	if (offset !== null) {
		// SQLite accepts OFFSET only after LIMIT; LIMIT -1 means "no limit".
		if (limit === null) parts.push('LIMIT -1')
		parts.push('OFFSET ?')
		params.push(offset)
	}

	return { sql: parts.join(' '), params }
}

/**
 * Build a COUNT query from a QueryDescriptor.
 * Automatically adds `WHERE _deleted = 0`.
 *
 * @param descriptor - The query descriptor
 * @param fields - The field descriptors from the collection schema
 * @returns A parameterized SQL query that returns { count: number }
 */
export function buildCountQuery(
	descriptor: QueryDescriptor,
	fields: Record<string, FieldDescriptor>,
): SqlQuery {
	const params: unknown[] = []
	const parts = [`SELECT COUNT(*) as count FROM ${quoteIdent(descriptor.collection)}`]

	const whereClause = buildWhereClauseParts(descriptor.where, fields, params)
	const deletedFilter = '_deleted = 0'
	if (whereClause) {
		parts.push(`WHERE ${deletedFilter} AND ${whereClause}`)
	} else {
		parts.push(`WHERE ${deletedFilter}`)
	}

	return { sql: parts.join(' '), params }
}

/**
 * Build an INSERT query for a collection record.
 *
 * @param collection - The collection name
 * @param record - The record data (already serialized with id, _created_at, _updated_at)
 * @returns A parameterized SQL query
 */
export function buildInsertQuery(collection: string, record: Record<string, unknown>): SqlQuery {
	const columns = Object.keys(record)
	const placeholders = columns.map(() => '?')
	const params = Object.values(record)

	const quotedColumns = columns.map((col) => quoteIdent(col))
	const sql = `INSERT INTO ${quoteIdent(collection)} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')})`
	return { sql, params }
}

/**
 * Build an UPDATE query for a collection record.
 *
 * @param collection - The collection name
 * @param id - The record ID
 * @param changes - The fields to update (already serialized)
 * @returns A parameterized SQL query
 */
export function buildUpdateQuery(
	collection: string,
	id: string,
	changes: Record<string, unknown>,
): SqlQuery {
	const setClauses = Object.keys(changes).map((col) => `${quoteIdent(col)} = ?`)
	const params = [...Object.values(changes), id]

	const sql = `UPDATE ${quoteIdent(collection)} SET ${setClauses.join(', ')} WHERE id = ?`
	return { sql, params }
}

/**
 * Build a field-level fast-forward UPDATE: writes the changed field values
 * unconditionally (the caller has already proven per-field that the local value
 * still equals the base the remote wrote from, so the remote is the newest known
 * writer of those fields), while advancing the row's `_version` / `_updated_at`
 * watermark MONOTONICALLY — never regressing it below its current value.
 *
 * This is what makes per-field LWW correct on a per-row `_version` column: a
 * concurrent edit to a different field may have pushed `_version` past this
 * operation's timestamp, but that must not cause this operation's own field
 * change to be dropped, nor may materializing it move the watermark backward
 * (which would let a genuinely stale later operation win).
 *
 * @param collection - The collection name
 * @param id - The record ID
 * @param fieldChanges - Serialized field values to write unconditionally (must NOT include _version / _updated_at)
 * @param remoteVersion - The operation's serialized row version (lexicographically comparable)
 * @param wallTime - The operation's wall-clock time in ms
 * @param options - Optional extras. `maxCreatedAt` advances `_created_at` to the
 *   greater of its current value and the given wall time — used for insert
 *   collisions so every node converges on the max insert wall time regardless
 *   of arrival order.
 */
export function buildFieldFastForwardUpdateQuery(
	collection: string,
	id: string,
	fieldChanges: Record<string, unknown>,
	remoteVersion: string,
	wallTime: number,
	options?: { maxCreatedAt?: number },
): SqlQuery {
	const fieldClauses = Object.keys(fieldChanges).map((col) => `${quoteIdent(col)} = ?`)
	// _version is a lexicographically-sortable string; _updated_at is a number.
	// Keep the greater of the current and incoming value for each (monotonic).
	const setClauses = [
		...fieldClauses,
		'_version = CASE WHEN _version >= ? THEN _version ELSE ? END',
		'_updated_at = CASE WHEN _updated_at >= ? THEN _updated_at ELSE ? END',
	]
	const params: unknown[] = [
		...Object.values(fieldChanges),
		remoteVersion,
		remoteVersion,
		wallTime,
		wallTime,
	]
	if (options?.maxCreatedAt !== undefined) {
		setClauses.push('_created_at = CASE WHEN _created_at >= ? THEN _created_at ELSE ? END')
		params.push(options.maxCreatedAt, options.maxCreatedAt)
	}
	params.push(id)
	const sql = `UPDATE ${quoteIdent(collection)} SET ${setClauses.join(', ')} WHERE id = ?`
	return { sql, params }
}

/**
 * Build a soft-delete query (SET _deleted = 1).
 *
 * @param collection - The collection name
 * @param id - The record ID
 * @param updatedAt - The timestamp to set on _updated_at
 * @returns A parameterized SQL query
 */
export function buildSoftDeleteQuery(
	collection: string,
	id: string,
	updatedAt: number,
	version?: string,
): SqlQuery {
	if (version !== undefined) {
		return {
			sql: `UPDATE ${quoteIdent(collection)} SET _deleted = 1, _updated_at = ?, _version = ? WHERE id = ?`,
			params: [updatedAt, version, id],
		}
	}
	return {
		sql: `UPDATE ${quoteIdent(collection)} SET _deleted = 1, _updated_at = ? WHERE id = ?`,
		params: [updatedAt, id],
	}
}

/**
 * Build an UPDATE that applies only when the row is missing or older than `remoteVersion`
 * (serialized HLC). Prevents stale remote sync from overwriting newer local materialized state.
 */
export function buildLwwUpdateQuery(
	collection: string,
	id: string,
	changes: Record<string, unknown>,
	remoteVersion: string,
): SqlQuery {
	const setClauses = Object.keys(changes).map((col) => `${quoteIdent(col)} = ?`)
	const lww = lwwVersionWhereClause(remoteVersion)
	const sql = `UPDATE ${quoteIdent(collection)} SET ${setClauses.join(', ')} WHERE id = ? AND ${lww.sql}`
	const params = [...Object.values(changes), id, ...lww.params]
	return { sql, params }
}

/**
 * Build a soft-delete that applies only when the row is older than `remoteVersion`.
 */
export function buildLwwSoftDeleteQuery(
	collection: string,
	id: string,
	updatedAt: number,
	version: string,
): SqlQuery {
	const lww = lwwVersionWhereClause(version)
	return {
		sql: `UPDATE ${quoteIdent(collection)} SET _deleted = 1, _updated_at = ?, _version = ? WHERE id = ? AND ${lww.sql}`,
		params: [updatedAt, version, id, ...lww.params],
	}
}

/**
 * Build a WHERE clause from conditions, validating field names against the schema.
 *
 * @param where - The where conditions
 * @param fields - The field descriptors from the collection schema
 * @returns The SQL WHERE clause string and params, or null if no conditions
 */
export function buildWhereClause(
	where: Record<string, unknown>,
	fields: Record<string, FieldDescriptor>,
): SqlQuery | null {
	const params: unknown[] = []
	const result = buildWhereClauseParts(where, fields, params)
	if (!result) return null
	return { sql: result, params }
}

// --- Internal helpers ---

const VALID_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in'])

function buildWhereClauseParts(
	where: Record<string, unknown>,
	fields: Record<string, FieldDescriptor>,
	params: unknown[],
): string | null {
	const conditions: string[] = []

	for (const [fieldName, value] of Object.entries(where)) {
		validateFieldName(fieldName, fields)
		const descriptor = fields[fieldName]
		const column = resolveColumnName(fieldName, fields)

		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			// Operator object: { $gt: 5, $lt: 10 }
			const ops = value as WhereOperators
			for (const [op, opValue] of Object.entries(ops)) {
				if (!VALID_OPERATORS.has(op)) {
					throw new QueryError(`Unknown operator "${op}" on field "${fieldName}"`, {
						field: fieldName,
						operator: op,
						validOperators: [...VALID_OPERATORS],
					})
				}
				conditions.push(buildOperatorCondition(fieldName, column, op, opValue, descriptor, params))
			}
		} else {
			// Shorthand: { completed: false } means { completed: { $eq: false } }
			conditions.push(buildOperatorCondition(fieldName, column, '$eq', value, descriptor, params))
		}
	}

	if (conditions.length === 0) return null
	return conditions.join(' AND ')
}

function buildOperatorCondition(
	fieldName: string,
	columnName: string,
	operator: string,
	value: unknown,
	descriptor: FieldDescriptor | undefined,
	params: unknown[],
): string {
	// Serialize boolean values to 0/1 and raw strings to their stored form (RT-65)
	const sqlValue = toSqlFilterValue(value, descriptor)

	const column = quoteIdent(columnName)

	switch (operator) {
		case '$eq':
			if (sqlValue === null) {
				return `${column} IS NULL`
			}
			params.push(sqlValue)
			return `${column} = ?`
		case '$ne':
			if (sqlValue === null) {
				return `${column} IS NOT NULL`
			}
			params.push(sqlValue)
			return `${column} != ?`
		case '$gt':
			params.push(sqlValue)
			return `${column} > ?`
		case '$gte':
			params.push(sqlValue)
			return `${column} >= ?`
		case '$lt':
			params.push(sqlValue)
			return `${column} < ?`
		case '$lte':
			params.push(sqlValue)
			return `${column} <= ?`
		case '$in': {
			if (!Array.isArray(sqlValue)) {
				throw new QueryError(`$in operator requires an array value for field "${fieldName}"`, {
					field: fieldName,
					received: typeof sqlValue,
				})
			}
			const placeholders = sqlValue.map(() => '?')
			for (const item of sqlValue) {
				params.push(toSqlFilterValue(item, descriptor))
			}
			return `${column} IN (${placeholders.join(', ')})`
		}
		default:
			throw new QueryError(`Unknown operator "${operator}"`, { operator })
	}
}

function toSqlFilterValue(value: unknown, descriptor: FieldDescriptor | undefined): unknown {
	if (descriptor?.kind === 'boolean' && typeof value === 'boolean') return value ? 1 : 0
	return encodeStoredFilterValue(value, descriptor)
}

/**
 * Record metadata exposed on every record under a camelCase name and backed by a
 * system column (STORE-11): `where({ updatedAt: { $gt: t } })` and
 * `orderBy('createdAt', 'desc')` filter and sort on these columns. A schema field
 * declared with the same name wins and its own column is used instead.
 */
export const VIRTUAL_TIMESTAMP_FIELDS = Object.freeze({
	createdAt: '_created_at',
	updatedAt: '_updated_at',
} as const)

/** Name of a virtual record-metadata field usable in `where` and `orderBy`. */
export type VirtualTimestampField = keyof typeof VIRTUAL_TIMESTAMP_FIELDS

/** Every virtual record-metadata field name, for typing `where` / `orderBy` keys. */
export const VIRTUAL_TIMESTAMP_FIELD_NAMES: readonly VirtualTimestampField[] = Object.freeze([
	'createdAt',
	'updatedAt',
] as const)

const SORT_DIRECTIONS: Readonly<Record<string, 'ASC' | 'DESC'>> = Object.freeze({
	asc: 'ASC',
	desc: 'DESC',
})

/** Map a query field name to the column it reads (STORE-11 virtual fields). */
function resolveColumnName(fieldName: string, fields: Record<string, FieldDescriptor>): string {
	if (Object.hasOwn(fields, fieldName)) return fieldName
	if (fieldName === 'createdAt' || fieldName === 'updatedAt') {
		return VIRTUAL_TIMESTAMP_FIELDS[fieldName]
	}
	return fieldName
}

function sqlSortDirection(direction: unknown, field: string): 'ASC' | 'DESC' {
	const key = typeof direction === 'string' ? direction.toLowerCase() : ''
	const keyword = Object.hasOwn(SORT_DIRECTIONS, key) ? SORT_DIRECTIONS[key] : undefined
	if (keyword === undefined) {
		throw new QueryError(`Invalid sort direction for field "${field}". Use 'asc' or 'desc'.`, {
			field,
			direction: typeof direction === 'string' ? direction.slice(0, 64) : typeof direction,
		})
	}
	return keyword
}

function assertQueryCount(value: unknown, clause: 'limit' | 'offset'): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new QueryError(
			`Invalid ${clause}: expected a non-negative safe integer. Pass a whole number, for example .${clause}(10).`,
			{ clause, received: typeof value === 'number' ? value : typeof value },
		)
	}
	return value
}

function validateFieldName(fieldName: string, fields: Record<string, FieldDescriptor>): void {
	// Allow schema fields plus metadata fields that map to query-able columns
	const allowedFields = new Set([
		...Object.keys(fields),
		'id',
		...VIRTUAL_TIMESTAMP_FIELD_NAMES,
		'_created_at',
		'_updated_at',
	])
	if (!allowedFields.has(fieldName)) {
		throw new QueryError(
			`Unknown field "${fieldName}" in query. Available fields: ${[...allowedFields].join(', ')}`,
			{ field: fieldName },
		)
	}
}
