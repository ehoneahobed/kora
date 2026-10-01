import { fc, test as propTest } from '@fast-check/vitest'
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

	// MERGE-1: the old rule kept an element unless BOTH sides removed it, so a
	// one-sided removal was silently undone by the other side's unchanged copy.
	test('one side adds, the other removes a different element: both changes apply', () => {
		const base = ['a', 'b']
		const local = ['a', 'b', 'c'] // added c
		const remote = ['a'] // removed b

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['a', 'c'])
	})

	test('an element removed by only one side is removed (unchanged does not resurrect it)', () => {
		const base = ['a', 'b', 'c']
		const local = ['a', 'c'] // removed b
		const remote = ['a', 'b', 'c'] // no changes

		const result = addWinsSet(local, remote, base)

		expect(result).toEqual(['a', 'c'])
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

	test('one side empties the array, other adds — removals apply, additions survive', () => {
		const base = ['a', 'b']
		const local: string[] = [] // removed everything
		const remote = ['a', 'b', 'c'] // added c

		const result = addWinsSet(local, remote, base)

		// a and b: removed by local → removed
		// c: added by remote → stays
		expect(result).toEqual(['c'])
	})

	test('complex scenario: mixed adds and removes', () => {
		const base = ['a', 'b', 'c', 'd']
		const local = ['a', 'c', 'e'] // removed b,d; added e
		const remote = ['a', 'b', 'f'] // removed c,d; added f

		const result = addWinsSet(local, remote, base)

		// a: in all → stays
		// b: removed by local → removed
		// c: removed by remote → removed
		// d: removed by both → removed
		// e: added by local → stays
		// f: added by remote → stays
		expect(result).toEqual(['a', 'e', 'f'])
	})

	// The two devices performing this merge call OPPOSITE sides "local", so the
	// result must be identical — including ELEMENT ORDER — when the roles swap.
	// Divergent order is divergent state: reactive queries and UIs render it.
	propTest.prop([
		fc.array(fc.string({ maxLength: 4 }), { maxLength: 6 }),
		fc.array(fc.string({ maxLength: 4 }), { maxLength: 6 }),
		fc.array(fc.string({ maxLength: 4 }), { maxLength: 6 }),
	])('is commutative including element order', (base, local, remote) => {
		const ab = addWinsSet(local, remote, base)
		const ba = addWinsSet(remote, local, base)
		expect(ab).toEqual(ba)
	})

	propTest.prop([
		fc.array(fc.string({ maxLength: 4 }), { maxLength: 6 }),
		fc.array(fc.string({ maxLength: 4 }), { maxLength: 6 }),
	])('is idempotent: re-merging the merged result is stable', (base, side) => {
		const result = addWinsSet(side, side, base)
		const again = addWinsSet(result, result, base)
		expect(again).toEqual(result)
	})

	test('an element added on one side and also present on the other is kept once', () => {
		expect(addWinsSet(['a', 'x'], ['x'], ['a'])).toEqual(['x'])
	})

	const elements = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 6 })

	propTest.prop([elements, elements, elements])(
		'matches (local ∩ remote) ∪ (local − base) ∪ (remote − base) as a set',
		(base, local, remote) => {
			const result = new Set(addWinsSet(local, remote, base))
			const B = new Set(base)
			const L = new Set(local)
			const R = new Set(remote)
			const expected = new Set([...L, ...R].filter((x) => (L.has(x) && R.has(x)) || !B.has(x)))
			expect(result).toEqual(expected)
		},
	)

	propTest.prop([elements, elements])(
		'removal beats unchanged: a base element one side removed never survives against an unchanged side',
		(base, local) => {
			// remote left the array untouched
			const result = addWinsSet(local, base, base)
			for (const x of base) {
				if (!local.includes(x)) {
					expect(result).not.toContain(x)
				}
			}
			// and nothing the editing side kept or added is lost
			expect(new Set(result)).toEqual(new Set(local))
		},
	)

	propTest.prop([elements, elements, elements])(
		'is commutative on the corrected rule, including element order',
		(base, local, remote) => {
			expect(addWinsSet(local, remote, base)).toEqual(addWinsSet(remote, local, base))
		},
	)
})
