import { QueryError } from '../errors'
import type { QueryDescriptor, WhereClause } from '../types'

/**
 * Normalise a `where` clause to its canonical form (RT-102). This is the ONE place that
 * decides what a where value means, so the SQL the store runs, the descriptor and the
 * query key (store cache, React/Vue/Svelte bindings) always agree:
 *
 * - `undefined` means "no condition": `where({ projectId: undefined })` is `where({})`
 *   (the usual "nothing selected yet" pattern), and an operator whose operand is
 *   `undefined` (`{ $gt: undefined }`) is dropped; a field left with no operator is
 *   dropped. A later `.where({ x: undefined })` therefore does not remove an earlier
 *   condition on `x`.
 * - `null` means SQL `IS NULL` (`$ne: null` means `IS NOT NULL`).
 * - Non-finite numbers (`NaN`, `Infinity`) have no stored representation: refused.
 * - `undefined` inside a `$in` list is refused (ambiguous: no condition cannot be one
 *   element of a list).
 *
 * @param where - The clause as the developer wrote it
 * @returns A new clause with the rules above applied
 * @throws {QueryError} For a non-finite number or an `undefined` `$in` element
 */
export function normalizeWhere(where: WhereClause): WhereClause {
	const out: WhereClause = {}
	for (const [field, value] of Object.entries(where)) {
		if (value === undefined) continue
		if (isOperatorObject(value)) {
			const operators: Record<string, unknown> = {}
			for (const [operator, operand] of Object.entries(value)) {
				if (operand === undefined) continue
				operators[operator] = normalizeOperand(field, operator, operand)
			}
			if (Object.keys(operators).length === 0) continue
			out[field] = operators
			continue
		}
		out[field] = normalizeOperand(field, '$eq', value)
	}
	return out
}

function normalizeOperand(field: string, operator: string, operand: unknown): unknown {
	if (Array.isArray(operand)) {
		return operand.map((item) => {
			if (item === undefined) {
				throw new QueryError(
					`Invalid ${operator} list for field "${field}": it contains undefined. Remove the undefined element, or use null to match missing values.`,
					{ field, operator },
				)
			}
			return assertFinite(field, operator, item)
		})
	}
	return assertFinite(field, operator, operand)
}

function assertFinite(field: string, operator: string, value: unknown): unknown {
	if (typeof value === 'number' && !Number.isFinite(value)) {
		throw new QueryError(
			`Invalid value for field "${field}" (${operator}): ${String(value)} is not a finite number and cannot match a stored value.`,
			{ field, operator, value: String(value) },
		)
	}
	return value
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	if (value instanceof Date || ArrayBuffer.isView(value)) return false
	return true
}

/**
 * The canonical identity of a query: equal keys if and only if the descriptors run the
 * same query (RT-102). Used by the store's query-store cache and by every framework
 * binding to decide when to share a store or re-subscribe.
 *
 * Unlike `JSON.stringify`, nothing is dropped or conflated: `where` keys are sorted
 * (their order does not change the query), `undefined` is dropped exactly as
 * {@link normalizeWhere} drops it, and `NaN`, `Date` and byte values keep distinct,
 * typed encodings.
 *
 * @param descriptor - The query descriptor (`queryBuilder.getDescriptor()`)
 * @returns A string key
 */
export function queryKey(descriptor: QueryDescriptor): string {
	return canonical({
		collection: descriptor.collection,
		where: normalizeWhere(descriptor.where),
		orderBy: descriptor.orderBy.map((clause) => [clause.field, clause.direction]),
		limit: descriptor.limit,
		offset: descriptor.offset,
		include: descriptor.include,
	})
}

function canonical(value: unknown): string {
	if (value === undefined) return 'u'
	if (value === null) return 'n'
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value)
		case 'number':
			// Distinguishes NaN, Infinity and -0 (never equal to another stored number).
			return Object.is(value, -0) ? 'num:-0' : `num:${String(value)}`
		case 'boolean':
			return value ? 'true' : 'false'
		case 'bigint':
			return `big:${value.toString()}`
		default:
			break
	}
	if (value instanceof Date) return `date:${value.getTime()}`
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		return `bytes:${Array.from(bytes).join(',')}`
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
	}
	return `?:${typeof value}`
}
