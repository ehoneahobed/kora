import { describe, expect, test } from 'vitest'
import { evaluateRoutePredicate } from './route-predicate'

describe('evaluateRoutePredicate', () => {
	test('empty predicate always matches, even against a null record', () => {
		expect(evaluateRoutePredicate({ a: 1 }, {})).toBe(true)
		expect(evaluateRoutePredicate(null, {})).toBe(true)
	})

	test('any field condition fails against a null record', () => {
		expect(evaluateRoutePredicate(null, { status: { $eq: 'published' } })).toBe(false)
	})

	test('$eq and $ne use identity comparison', () => {
		expect(evaluateRoutePredicate({ status: 'published' }, { status: { $eq: 'published' } })).toBe(
			true,
		)
		expect(evaluateRoutePredicate({ status: 'draft' }, { status: { $eq: 'published' } })).toBe(
			false,
		)
		expect(evaluateRoutePredicate({ status: 'draft' }, { status: { $ne: 'published' } })).toBe(true)
	})

	test('numeric comparisons enforce the bound and require a number', () => {
		expect(evaluateRoutePredicate({ count: 4 }, { count: { $lt: 5 } })).toBe(true)
		expect(evaluateRoutePredicate({ count: 5 }, { count: { $lt: 5 } })).toBe(false)
		expect(evaluateRoutePredicate({ count: 5 }, { count: { $lte: 5 } })).toBe(true)
		expect(evaluateRoutePredicate({ count: 6 }, { count: { $gt: 5 } })).toBe(true)
		expect(evaluateRoutePredicate({ count: 5 }, { count: { $gte: 5 } })).toBe(true)
		// A non-numeric field value fails a numeric comparison rather than coercing.
		expect(evaluateRoutePredicate({ count: '4' }, { count: { $lt: 5 } })).toBe(false)
	})

	test('$in checks membership', () => {
		expect(evaluateRoutePredicate({ role: 'editor' }, { role: { $in: ['owner', 'editor'] } })).toBe(
			true,
		)
		expect(evaluateRoutePredicate({ role: 'viewer' }, { role: { $in: ['owner', 'editor'] } })).toBe(
			false,
		)
	})

	test('all operators on a field, and all fields, must hold', () => {
		const predicate = {
			status: { $eq: 'published' },
			responseCount: { $gte: 0, $lt: 100 },
		}
		expect(evaluateRoutePredicate({ status: 'published', responseCount: 99 }, predicate)).toBe(true)
		expect(evaluateRoutePredicate({ status: 'published', responseCount: 100 }, predicate)).toBe(
			false,
		)
		expect(evaluateRoutePredicate({ status: 'draft', responseCount: 10 }, predicate)).toBe(false)
	})
})
