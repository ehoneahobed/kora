import { describe, expect, test } from 'vitest'
import {
	MAX_SCOPE_BRANCHES,
	isUnrestrictedScope,
	matchesFieldPredicate,
	narrowCollectionScope,
	recordMatchesCollectionScope,
	scopeBranches,
	scopeFieldNames,
} from './scope-predicate'

const own = { ownerId: 'u1' }
const shared = { spaceId: { $in: ['s1', 's2'] } }

describe('recordMatchesCollectionScope', () => {
	test('a conjunction needs every field predicate', () => {
		expect(
			recordMatchesCollectionScope({ ownerId: 'u1', status: 'a' }, { ownerId: 'u1', status: 'a' }),
		).toBe(true)
		expect(
			recordMatchesCollectionScope({ ownerId: 'u1', status: 'b' }, { ownerId: 'u1', status: 'a' }),
		).toBe(false)
	})

	test('a disjunction needs one branch', () => {
		const scope = { $or: [own, shared] }
		expect(recordMatchesCollectionScope({ ownerId: 'u1', spaceId: 'x' }, scope)).toBe(true)
		expect(recordMatchesCollectionScope({ ownerId: 'u2', spaceId: 's2' }, scope)).toBe(true)
		expect(recordMatchesCollectionScope({ ownerId: 'u2', spaceId: 'x' }, scope)).toBe(false)
	})

	test('an empty conjunction admits every record; an empty branch makes the scope unrestricted', () => {
		expect(recordMatchesCollectionScope({ any: 1 }, {})).toBe(true)
		expect(isUnrestrictedScope({})).toBe(true)
		expect(isUnrestrictedScope({ $or: [own, {}] })).toBe(true)
		expect(isUnrestrictedScope({ $or: [own, shared] })).toBe(false)
	})

	test.each([
		['empty $or', { $or: [] }],
		['$or not an array', { $or: own }],
		['$or with a sibling field', { $or: [own], status: 'a' }],
		['nested $or', { $or: [{ $or: [own] }] }],
		['branch not an object', { $or: ['u1'] }],
		['branch is an array', { $or: [[own]] }],
		['too many branches', { $or: Array.from({ length: MAX_SCOPE_BRANCHES + 1 }, () => own) }],
	])('a malformed scope (%s) matches nothing and is never unrestricted', (_name, scope) => {
		const record = { ownerId: 'u1', status: 'a', spaceId: 's1' }
		expect(scopeBranches(scope as never)).toEqual([])
		expect(recordMatchesCollectionScope(record, scope as never)).toBe(false)
		expect(isUnrestrictedScope(scope as never)).toBe(false)
	})

	test('null and undefined scopes match nothing', () => {
		expect(recordMatchesCollectionScope({ a: 1 }, null)).toBe(false)
		expect(recordMatchesCollectionScope({ a: 1 }, undefined)).toBe(false)
	})
})

describe('matchesFieldPredicate', () => {
	test('exact values and $in', () => {
		expect(matchesFieldPredicate('a', 'a')).toBe(true)
		expect(matchesFieldPredicate('a', { $in: ['b', 'a'] })).toBe(true)
		expect(matchesFieldPredicate('c', { $in: ['b', 'a'] })).toBe(false)
	})

	test('fails closed on null, undefined, malformed $in and unknown operators', () => {
		expect(matchesFieldPredicate(undefined, undefined)).toBe(false)
		expect(matchesFieldPredicate(null, null)).toBe(false)
		expect(matchesFieldPredicate(null, { $in: [null] })).toBe(false)
		expect(matchesFieldPredicate('a', { $in: 'a' })).toBe(false)
		expect(matchesFieldPredicate('a', { $in: ['a'], $nin: ['a'] })).toBe(false)
		expect(matchesFieldPredicate('a', { $ne: 'b' })).toBe(false)
		expect(matchesFieldPredicate(['a'], ['a'])).toBe(false)
	})

	test('large frozen lists use a set but keep Object.is semantics for 0 and -0', () => {
		const values = Object.freeze([...Array.from({ length: 40 }, (_, i) => i + 1), 0])
		expect(matchesFieldPredicate(5, { $in: values })).toBe(true)
		expect(matchesFieldPredicate(0, { $in: values })).toBe(true)
		expect(matchesFieldPredicate(-0, { $in: values })).toBe(false)
	})
})

describe('scopeFieldNames', () => {
	test('collects the fields of every branch, sorted', () => {
		expect(scopeFieldNames({ $or: [{ b: 1, a: 1 }, { c: 1 }] })).toEqual(['a', 'b', 'c'])
		expect(scopeFieldNames({ $or: [] })).toEqual([])
	})
})

describe('narrowCollectionScope', () => {
	test('adds predicates on open fields of every branch', () => {
		expect(narrowCollectionScope({ $or: [own, shared] }, { status: 'a' })).toEqual({
			$or: [
				{ ownerId: 'u1', status: 'a' },
				{ spaceId: { $in: ['s1', 's2'] }, status: 'a' },
			],
		})
	})

	test('narrows an $in to a subset, never widens a granted field', () => {
		expect(narrowCollectionScope(shared, { spaceId: 's2' })).toEqual({ spaceId: 's2' })
		expect(narrowCollectionScope(shared, { spaceId: 's9' })).toEqual(shared)
		expect(narrowCollectionScope(own, { ownerId: 'u2' })).toEqual(own)
		expect(narrowCollectionScope(shared, { spaceId: { $in: ['s1', 's9'] } })).toEqual(shared)
	})

	test('a requested disjunction is ignored', () => {
		expect(narrowCollectionScope(own, { $or: [{ ownerId: 'u2' }] } as never)).toEqual(own)
	})
})
