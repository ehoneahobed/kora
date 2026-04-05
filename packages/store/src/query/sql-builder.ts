import type { CollectionDefinition, FieldDescriptor } from '@korajs/core'
import { QueryError } from '../errors'
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
	const parts = [`SELECT * FROM ${descriptor.collection}`]

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
			return `${o.field} ${o.direction.toUpperCase()}`
		})
		parts.push(`ORDER BY ${orderParts.join(', ')}`)
	}

	if (descriptor.limit !== undefined) {
		parts.push(`LIMIT ${descriptor.limit}`)
	}

	if (descriptor.offset !== undefined) {
		parts.push(`OFFSET ${descriptor.offset}`)
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
	const parts = [`SELECT COUNT(*) as count FROM ${descriptor.collection}`]

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

	const sql = `INSERT INTO ${collection} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
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
	const setClauses = Object.keys(changes).map((col) => `${col} = ?`)
	const params = [...Object.values(changes), id]

	const sql = `UPDATE ${collection} SET ${setClauses.join(', ')} WHERE id = ?`
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
export function buildSoftDeleteQuery(collection: string, id: string, updatedAt: number): SqlQuery {
	return {
		sql: `UPDATE ${collection} SET _deleted = 1, _updated_at = ? WHERE id = ?`,
		params: [updatedAt, id],
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
				conditions.push(buildOperatorCondition(fieldName, op, opValue, descriptor, params))
			}
		} else {
			// Shorthand: { completed: false } means { completed: { $eq: false } }
			conditions.push(buildOperatorCondition(fieldName, '$eq', value, descriptor, params))
		}
	}

	if (conditions.length === 0) return null
	return conditions.join(' AND ')
}

function buildOperatorCondition(
	fieldName: string,
	operator: string,
	value: unknown,
	descriptor: FieldDescriptor | undefined,
	params: unknown[],
): string {
	// Serialize boolean values to 0/1 for SQL comparison
	const sqlValue =
		descriptor?.kind === 'boolean' && typeof value === 'boolean' ? (value ? 1 : 0) : value

	switch (operator) {
		case '$eq':
			if (sqlValue === null) {
				return `${fieldName} IS NULL`
			}
			params.push(sqlValue)
			return `${fieldName} = ?`
		case '$ne':
			if (sqlValue === null) {
				return `${fieldName} IS NOT NULL`
			}
			params.push(sqlValue)
			return `${fieldName} != ?`
		case '$gt':
			params.push(sqlValue)
			return `${fieldName} > ?`
		case '$gte':
			params.push(sqlValue)
			return `${fieldName} >= ?`
		case '$lt':
			params.push(sqlValue)
			return `${fieldName} < ?`
		case '$lte':
			params.push(sqlValue)
			return `${fieldName} <= ?`
		case '$in': {
			if (!Array.isArray(sqlValue)) {
				throw new QueryError(`$in operator requires an array value for field "${fieldName}"`, {
					field: fieldName,
					received: typeof sqlValue,
				})
			}
			const placeholders = sqlValue.map(() => '?')
			for (const item of sqlValue) {
				params.push(
					descriptor?.kind === 'boolean' && typeof item === 'boolean' ? (item ? 1 : 0) : item,
				)
			}
			return `${fieldName} IN (${placeholders.join(', ')})`
		}
		default:
			throw new QueryError(`Unknown operator "${operator}"`, { operator })
	}
}

function validateFieldName(fieldName: string, fields: Record<string, FieldDescriptor>): void {
	// Allow schema fields plus metadata fields that map to query-able columns
	const allowedFields = new Set([
		...Object.keys(fields),
		'id',
		'createdAt',
		'updatedAt',
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
