import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { operationMatchesQuerySubsets } from './query-subset'
import { operationMatchesScope } from './scope-filter'
import {
	buildScopeSnapshot,
	matchesScopePredicate,
	recordMatchesScopePredicates,
} from './scope-snapshot'

function createOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'update',
		collection: 'courses',
		recordId: 'victim',
		data: { title: 'new' },
		previousData: { title: 'old' },
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('buildScopeSnapshot', () => {
	test('layers fullRecord < previousData < data', () => {
		const snapshot = buildScopeSnapshot(
			createOp({ data: { a: 3 }, previousData: { a: 2, b: 2 } }),
			{ a: 1, b: 1, c: 1 },
		)
		expect(snapshot).toEqual({ a: 3, b: 2, c: 1, id: 'victim' })
	})

	test('id always comes from recordId, even when data, previousData or the record disagree', () => {
		const op = createOp({ data: { id: 'allowed' }, previousData: { id: 'allowed' } })
		expect(buildScopeSnapshot(op, { id: 'other' }).id).toBe('victim')
	})

	test('a fieldless operation still has an identity', () => {
		expect(
			buildScopeSnapshot(createOp({ type: 'delete', data: null, previousData: null })),
		).toEqual({ id: 'victim' })
	})

	test('ignores non-object data shapes', () => {
		const op = createOp({ data: ['x'] as unknown as Record<string, unknown>, previousData: null })
		expect(buildScopeSnapshot(op)).toEqual({ id: 'victim' })
	})
})

describe('matchesScopePredicate / recordMatchesScopePredicates', () => {
	test('exact values use Object.is', () => {
		expect(matchesScopePredicate('a', 'a')).toBe(true)
		expect(matchesScopePredicate(1, '1')).toBe(false)
		expect(matchesScopePredicate(Number.NaN, Number.NaN)).toBe(true)
	})

	test('$in matches any listed value and rejects a malformed list', () => {
		expect(matchesScopePredicate('b', { $in: ['a', 'b'] })).toBe(true)
		expect(matchesScopePredicate('c', { $in: ['a', 'b'] })).toBe(false)
		expect(matchesScopePredicate('a', { $in: 'a' })).toBe(false)
	})

	test('every predicate must match', () => {
		expect(recordMatchesScopePredicates({ a: 1, b: 2 }, { a: 1, b: { $in: [2, 3] } })).toBe(true)
		expect(recordMatchesScopePredicates({ a: 1, b: 4 }, { a: 1, b: { $in: [2, 3] } })).toBe(false)
	})
})

describe('id-forgery is closed in the client matchers (NEW-SEC-2)', () => {
	const idScope = { courses: { id: { $in: ['allowed'] } } }

	test('previousData.id cannot put another record in an id scope', () => {
		const forged = createOp({ previousData: { id: 'allowed', title: 'old' } })
		expect(operationMatchesScope(forged, idScope, { id: 'victim' })).toBe(false)
	})

	test('a record whose own id is in an id scope matches without a stored row', () => {
		const insert = createOp({ type: 'insert', recordId: 'allowed', previousData: null })
		expect(operationMatchesScope(insert, idScope)).toBe(true)
	})

	test('query subsets on id are judged by recordId as well', () => {
		const forged = createOp({ data: { id: 'allowed' } })
		expect(
			operationMatchesQuerySubsets(forged, [{ collection: 'courses', where: { id: 'allowed' } }]),
		).toBe(false)
	})
})
