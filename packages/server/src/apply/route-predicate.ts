/**
 * Predicate evaluation for conditional route mutations.
 *
 * A predicate is a small, total comparison language evaluated against the current
 * materialized state of a single record at admission time. It is deliberately not
 * a general query language: it exists so a server route can express an atomic
 * admission guard (for example "accept this response only while the form is still
 * below its cap") without pulling a query DSL into the write path.
 */

/**
 * Comparison operators applied to one field. All operators present on a field
 * must hold for the field to match. Numeric operators (`$lt`, `$lte`, `$gt`,
 * `$gte`) require the record value to be a number; a non-numeric value fails.
 */
export interface RoutePredicateOperators {
	$eq?: unknown
	$ne?: unknown
	$lt?: number
	$lte?: number
	$gt?: number
	$gte?: number
	$in?: readonly unknown[]
}

/** A predicate: every listed field must satisfy all of its operators. */
export type RoutePredicate = Record<string, RoutePredicateOperators>

function evaluateField(actual: unknown, operators: RoutePredicateOperators): boolean {
	if ('$eq' in operators && !Object.is(actual, operators.$eq)) {
		return false
	}
	if ('$ne' in operators && Object.is(actual, operators.$ne)) {
		return false
	}
	if (
		operators.$in !== undefined &&
		!operators.$in.some((candidate) => Object.is(actual, candidate))
	) {
		return false
	}

	const numericChecks: [keyof RoutePredicateOperators, (a: number, b: number) => boolean][] = [
		['$lt', (a, b) => a < b],
		['$lte', (a, b) => a <= b],
		['$gt', (a, b) => a > b],
		['$gte', (a, b) => a >= b],
	]
	for (const [operator, compare] of numericChecks) {
		const bound = operators[operator]
		if (bound === undefined) {
			continue
		}
		if (typeof actual !== 'number' || typeof bound !== 'number') {
			return false
		}
		if (!compare(actual, bound)) {
			return false
		}
	}

	return true
}

/**
 * Evaluates a predicate against a record. A `null` record (the target does not
 * exist) satisfies only an empty predicate; any field condition fails, since a
 * missing record cannot meet a comparison.
 *
 * @param record - The current materialized record, or `null` if absent
 * @param predicate - The field conditions that must all hold
 * @returns `true` when every field condition is satisfied
 */
export function evaluateRoutePredicate(
	record: Record<string, unknown> | null,
	predicate: RoutePredicate,
): boolean {
	const fields = Object.keys(predicate)
	if (fields.length === 0) {
		return true
	}
	if (record === null) {
		return false
	}
	for (const field of fields) {
		const operators = predicate[field]
		if (operators && !evaluateField(record[field], operators)) {
			return false
		}
	}
	return true
}
