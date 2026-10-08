import { fc, test } from '@fast-check/vitest'
import { expect } from 'vitest'
import {
	type CollectionScope,
	type ScopeConjunction,
	narrowCollectionScope,
	recordMatchesCollectionScope,
} from '../../src/scopes/scope-predicate'

// Small domains so random records often hit the predicates.
const FIELDS = ['a', 'b', 'c'] as const
const value = fc.constantFrom('x', 'y', 'z', 1, 2)
const predicate = fc.oneof(
	value,
	fc.uniqueArray(value, { minLength: 0, maxLength: 3 }).map(($in) => ({ $in })),
)
const conjunction: fc.Arbitrary<ScopeConjunction> = fc.dictionary(
	fc.constantFrom(...FIELDS),
	predicate,
	{ maxKeys: 3 },
)
const scope: fc.Arbitrary<CollectionScope> = fc.oneof(
	conjunction,
	fc.array(conjunction, { minLength: 1, maxLength: 4 }).map(($or) => ({ $or })),
)
const record = fc.record({ a: value, b: value, c: value })

test.prop([scope, conjunction, record])(
	'narrowing never admits a record the grant does not',
	(grant, requested, row) => {
		const narrowed = narrowCollectionScope(grant, requested)
		if (recordMatchesCollectionScope(row, narrowed)) {
			expect(recordMatchesCollectionScope(row, grant)).toBe(true)
		}
	},
)

test.prop([fc.array(conjunction, { minLength: 1, maxLength: 4 }), record])(
	'a disjunction matches exactly when one of its branches does',
	(branches, row) => {
		const any = branches.some((branch) => recordMatchesCollectionScope(row, branch))
		expect(recordMatchesCollectionScope(row, { $or: branches })).toBe(any)
	},
)

test.prop([fc.array(conjunction, { minLength: 1, maxLength: 4 }), record])(
	'branch order does not change the decision',
	(branches, row) => {
		const reversed = [...branches].reverse()
		expect(recordMatchesCollectionScope(row, { $or: branches })).toBe(
			recordMatchesCollectionScope(row, { $or: reversed }),
		)
	},
)
