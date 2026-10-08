import { KoraError } from '@korajs/core'
import { isScopeDisjunction, scopeBranches } from '@korajs/core/internal'

/**
 * Thrown when a sync scope predicate value is `undefined` or `null` (also inside a
 * `$in` list). Such a value matches every record that lacks the field, so a grant
 * built from a failed lookup (for example `{ orgId: user.orgId }` with no org)
 * would expose every unowned record. Kora refuses it instead (fail closed).
 */
export class InvalidScopePredicateError extends KoraError {
	constructor(
		readonly collection: string,
		readonly field: string,
	) {
		super(
			`Sync scope predicate for "${collection}.${field}" is undefined or null. A missing value would match every record without "${field}", so the grant is refused.`,
			'INVALID_SCOPE_PREDICATE',
			{
				collection,
				field,
				fix: 'Return a concrete value for this field from your auth provider, or leave the collection out of the grant to deny it.',
			},
		)
		this.name = 'InvalidScopePredicateError'
	}
}

/** Thrown when a `$in` scope predicate is malformed or larger than the configured limit. */
export class ScopePredicateLimitError extends KoraError {
	constructor(message: string, context: Record<string, unknown>) {
		super(message, 'SCOPE_PREDICATE_LIMIT', context)
		this.name = 'ScopePredicateLimitError'
	}
}

/**
 * Refuse any `undefined`/`null` predicate value in a scope map (fail closed).
 *
 * @param scopes - Per-collection predicates
 * @throws {InvalidScopePredicateError} On the first undefined/null value found
 */
export function assertScopeValuesDefined(
	scopes: Record<string, Record<string, unknown> | undefined> | undefined,
): void {
	if (!scopes) return
	for (const [collection, scope] of Object.entries(scopes)) {
		// Every branch of a `$or` is checked; a malformed `$or` is refused by the
		// normalizer, never treated as a field.
		const branches = isScopeDisjunction(scope) ? scopeBranches(scope) : [scope ?? {}]
		for (const predicate of branches) {
			for (const [field, expected] of Object.entries(predicate)) {
				if (expected === undefined || expected === null) {
					throw new InvalidScopePredicateError(collection, field)
				}
				if (typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
					const values = (expected as { $in?: unknown }).$in
					if (
						Array.isArray(values) &&
						values.some((value) => value === undefined || value === null)
					) {
						throw new InvalidScopePredicateError(collection, field)
					}
				}
			}
		}
	}
}
