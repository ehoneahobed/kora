import { describe, expect, test } from 'vitest'
import type { QueryDescriptor } from '../types'
import { normalizeWhere, queryKey } from './query-key'

function d(where: Record<string, unknown>, extra: Partial<QueryDescriptor> = {}): QueryDescriptor {
	return { collection: 'todos', where, orderBy: [], ...extra }
}

describe('normalizeWhere (RT-102)', () => {
	test('undefined means no condition', () => {
		expect(normalizeWhere({ projectId: undefined, done: false })).toEqual({ done: false })
		expect(normalizeWhere({ n: { $gt: undefined, $lt: 5 } })).toEqual({ n: { $lt: 5 } })
		expect(normalizeWhere({ n: { $gt: undefined } })).toEqual({})
	})

	test('null is kept (IS NULL)', () => {
		expect(normalizeWhere({ projectId: null })).toEqual({ projectId: null })
		expect(normalizeWhere({ projectId: { $ne: null } })).toEqual({ projectId: { $ne: null } })
	})

	test('non-finite numbers and undefined $in elements are refused', () => {
		expect(() => normalizeWhere({ n: Number.NaN })).toThrow(/finite/)
		expect(() => normalizeWhere({ n: { $gt: Number.POSITIVE_INFINITY } })).toThrow(/finite/)
		expect(() => normalizeWhere({ n: { $in: [1, Number.NaN] } })).toThrow(/finite/)
		expect(() => normalizeWhere({ n: { $in: [1, undefined] } })).toThrow(/undefined/)
	})

	test('dates and bytes are values, not operator objects', () => {
		const at = new Date(5)
		expect(normalizeWhere({ at })).toEqual({ at })
	})
})

describe('queryKey (RT-102)', () => {
	test('equal for queries that run the same SQL', () => {
		expect(queryKey(d({ projectId: undefined }))).toBe(queryKey(d({})))
		expect(queryKey(d({ a: 1, b: 2 }))).toBe(queryKey(d({ b: 2, a: 1 })))
	})

	test('distinct for queries that differ', () => {
		const keys = [
			d({}),
			d({ projectId: null }),
			d({ projectId: 'null' }),
			d({ n: 0 }),
			d({ n: '0' }),
			d({ n: false }),
			d({ at: new Date(5) }),
			d({ at: '1970-01-01T00:00:00.005Z' }),
			d({}, { limit: 1 }),
			d({}, { offset: 1 }),
			d({}, { orderBy: [{ field: 'a', direction: 'asc' }] }),
			d({}, { orderBy: [{ field: 'a', direction: 'desc' }] }),
			d({}, { include: ['project'] }),
			{ ...d({}), collection: 'other' },
		].map(queryKey)
		expect(new Set(keys).size).toBe(keys.length)
	})
})
