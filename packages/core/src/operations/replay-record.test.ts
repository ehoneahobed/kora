import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { type ReplayOperation, mergeArraySet, replayOperationsForRecord } from './replay-record'

const element = fc.constantFrom('a', 'b', 'c', 'd', 'e')
const set = fc.uniqueArray(element, { maxLength: 5 })

describe('mergeArraySet', () => {
	test('applies a one-sided removal and a concurrent addition', () => {
		expect(mergeArraySet([], ['urgent', 'billing'], ['urgent'])).toEqual(['billing'])
	})

	test('keeps base order, then additions in a role-independent order', () => {
		expect(mergeArraySet(['c', 'a', 'x'], ['c', 'a', 'b', 'y'], ['c', 'a', 'b'])).toEqual([
			'c',
			'a',
			'x',
			'y',
		])
	})

	propTest.prop([set, set, set])('is commutative, including element order', (base, l, r) => {
		expect(mergeArraySet(l, r, base)).toEqual(mergeArraySet(r, l, base))
	})

	propTest.prop([set, set])(
		'removal beats unchanged: against an untouched side, the editing side wins exactly',
		(base, edited) => {
			const merged = mergeArraySet(edited, base, base)
			expect(new Set(merged)).toEqual(new Set(edited))
			for (const x of base) {
				if (!edited.includes(x)) expect(merged).not.toContain(x)
			}
		},
	)

	propTest.prop([set, set, set])(
		'equals (local ∩ remote) ∪ (local − base) ∪ (remote − base) as a set',
		(base, l, r) => {
			const B = new Set(base)
			const expected = new Set(
				[...new Set([...l, ...r])].filter((x) => (l.includes(x) && r.includes(x)) || !B.has(x)),
			)
			expect(new Set(mergeArraySet(l, r, base))).toEqual(expected)
		},
	)

	propTest.prop([set, set])('is idempotent', (base, side) => {
		const once = mergeArraySet(side, side, base)
		expect(mergeArraySet(once, once, base)).toEqual(once)
	})
})

describe('replayOperationsForRecord array fields', () => {
	const insert: ReplayOperation = { type: 'insert', data: { title: 't', tags: ['urgent'] } }
	const removeUrgent: ReplayOperation = {
		type: 'update',
		data: { tags: [] },
		previousData: { tags: ['urgent'] },
	}
	const addBilling: ReplayOperation = {
		type: 'update',
		data: { tags: ['urgent', 'billing'] },
		previousData: { tags: ['urgent'] },
	}

	test('two concurrent edits from the same base merge as a set, in either HLC order', () => {
		expect(replayOperationsForRecord([insert, removeUrgent, addBilling])?.tags).toEqual(['billing'])
		expect(replayOperationsForRecord([insert, addBilling, removeUrgent])?.tags).toEqual(['billing'])
	})

	test('an update that restates the array unchanged does not undo a removal (NEW-MERGE-1)', () => {
		const saveTitleOnly: ReplayOperation = {
			type: 'update',
			data: { title: 'renamed', tags: ['urgent'] },
			previousData: { title: 't', tags: ['urgent'] },
		}
		const folded = replayOperationsForRecord([insert, removeUrgent, saveTitleOnly])
		expect(folded).toEqual({ title: 'renamed', tags: [] })
	})

	test('a sequential write fast-forwards and keeps the writer’s element order', () => {
		const reorder: ReplayOperation = {
			type: 'update',
			data: { tags: ['z', 'urgent', 'a'] },
			previousData: { tags: ['urgent'] },
		}
		expect(replayOperationsForRecord([insert, reorder])?.tags).toEqual(['z', 'urgent', 'a'])
	})

	test('without previousData an array write stays last-write-wins', () => {
		const legacy: ReplayOperation = { type: 'update', data: { tags: ['x'] } }
		expect(replayOperationsForRecord([insert, removeUrgent, legacy])?.tags).toEqual(['x'])
	})

	test('scalars stay last-write-wins even with previousData', () => {
		const a: ReplayOperation = {
			type: 'update',
			data: { title: 'a' },
			previousData: { title: 't' },
		}
		const b: ReplayOperation = {
			type: 'update',
			data: { title: 'b' },
			previousData: { title: 't' },
		}
		expect(replayOperationsForRecord([insert, a, b])?.title).toBe('b')
	})
})
