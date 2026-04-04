import { describe, expect, test } from 'vitest'
import { addWinsSet } from './add-wins-set'

describe('addWinsSet', () => {
	test('disjoint additions from both sides are preserved', () => {
		const base = ['a', 'b']
		const local = ['a', 'b', 'c']
		const remote = ['a', 'b', 'd']

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['a', 'b', 'c', 'd'])
	})

	test('overlapping additions are deduped', () => {
		const base = ['a']
		const local = ['a', 'b']
		const remote = ['a', 'b']

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['a', 'b'])
	})

	test('add wins over remove (one adds, one removes different element)', () => {
		const base = ['a', 'b']
		const local = ['a', 'b', 'c'] // added c
		const remote = ['a'] // removed b

		const result = addWinsSet(local, remote, base)

		// b was only removed by remote, not local → b stays (add-wins)
		// c was added by local → c stays
		expect(result).toEqual(['a', 'b', 'c'])
	})

	test('element removed by only one side stays (add-wins semantics)', () => {
		const base = ['a', 'b', 'c']
		const local = ['a', 'c'] // removed b
		const remote = ['a', 'b', 'c'] // no changes

		const result = addWinsSet(local, remote, base)

		// b removed only by local → stays
		expect(result).toEqual(['a', 'b', 'c'])
	})

	test('element removed by BOTH sides is actually removed', () => {
		const base = ['a', 'b', 'c']
		const local = ['a', 'c'] // removed b
		const remote = ['a', 'c'] // removed b

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['a', 'c'])
	})

	test('both add same element (dedup)', () => {
		const base: string[] = []
		const local = ['x']
		const remote = ['x']

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['x'])
	})

	test('empty arrays', () => {
		expect(addWinsSet([], [], [])).toEqual([])
	})

	test('empty base with additions', () => {
		const base: string[] = []
		const local = ['a', 'b']
		const remote = ['c']

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['a', 'b', 'c'])
	})

	test('base is null-like: treats as empty', () => {
		// The field merger will pass [] when base is null/undefined
		const result = addWinsSet(['a'], ['b'], [])

		expect(result).toEqual(['a', 'b'])
	})

	test('works with number elements', () => {
		const base = [1, 2, 3]
		const local = [1, 2, 3, 4]
		const remote = [1, 2, 3, 5]

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual([1, 2, 3, 4, 5])
	})

	test('works with object elements (compared by JSON serialization)', () => {
		const base = [{ id: 1 }]
		const local = [{ id: 1 }, { id: 2 }]
		const remote = [{ id: 1 }, { id: 3 }]

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
	})

	test('preserves base element order', () => {
		const base = ['c', 'a', 'b']
		const local = ['c', 'a', 'b', 'x']
		const remote = ['c', 'a', 'b', 'y']

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['c', 'a', 'b', 'x', 'y'])
	})

	test('one side empties the array, other adds — additions survive', () => {
		const base = ['a', 'b']
		const local: string[] = [] // removed everything
		const remote = ['a', 'b', 'c'] // added c

		const result = addWinsSet(local, remote, base)

		// a and b: removed only by local (not both) → stays
		// c: added by remote → stays
		expect(result).toEqual(['a', 'b', 'c'])
	})

	test('complex scenario: mixed adds and removes', () => {
		const base = ['a', 'b', 'c', 'd']
		const local = ['a', 'c', 'e'] // removed b,d; added e
		const remote = ['a', 'b', 'f'] // removed c,d; added f

		const result = addWinsSet(local, remote, base)

		// a: in all → stays
		// b: removed by local only → stays (add-wins)
		// c: removed by remote only → stays (add-wins)
		// d: removed by both → actually removed
		// e: added by local → stays
		// f: added by remote → stays
		expect(result).toEqual(['a', 'b', 'c', 'e', 'f'])
	})
})
