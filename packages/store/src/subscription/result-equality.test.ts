import type { FieldDescriptor } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { CollectionRecord } from '../types'
import { createResultsEqual, structurallyEqual } from './result-equality'

function field(kind: FieldDescriptor['kind']): FieldDescriptor {
	return {
		kind,
		required: false,
		defaultValue: undefined,
		auto: false,
		enumValues: null,
		itemKind: null,
		mergeStrategy: null,
		transitions: null,
	}
}

const rec = (extra: Record<string, unknown>): CollectionRecord => ({
	id: 'a',
	createdAt: 1,
	updatedAt: 1,
	...extra,
})

describe('structurallyEqual', () => {
	test.each([
		[1, 1, true],
		[Number.NaN, Number.NaN, true],
		['a', 'a', true],
		[null, null, true],
		[null, undefined, false],
		[[1, [2, 3]], [1, [2, 3]], true],
		[[1, 2], [2, 1], false],
		[{ a: 1, b: { c: [1] } }, { b: { c: [1] }, a: 1 }, true],
		[{ a: 1 }, { a: 1, b: undefined }, false],
		[new Uint8Array([1, 2]), new Uint8Array([1, 2]), true],
		[new Uint8Array([1, 2]), new Uint8Array([1, 3]), false],
		[new Uint8Array([1]), [1], false],
		[new Date(5), new Date(5), true],
		[[], {}, false],
	])('%j vs %j -> %s', (a, b, expected) => {
		expect(structurallyEqual(a, b)).toBe(expected)
		expect(structurallyEqual(b, a)).toBe(expected)
	})
})

describe('createResultsEqual', () => {
	const equal = createResultsEqual({
		title: field('string'),
		tags: field('array'),
		meta: field('json'),
		body: field('richtext'),
		done: field('boolean'),
	})

	test('fresh containers with the same content are equal for every field kind', () => {
		const make = () => [
			rec({
				title: 't',
				tags: ['x'],
				meta: { k: [1, { z: true }] },
				body: new Uint8Array([9, 9]),
				done: false,
			}),
		]
		expect(equal(make(), make())).toBe(true)
	})

	test('a change in any field, order or included relation is detected', () => {
		const base = rec({ title: 't', tags: ['x'], project: { id: 'p', name: 'P' } })
		expect(equal([base], [{ ...base, tags: ['y'] }])).toBe(false)
		expect(equal([base], [{ ...base, title: 'u' }])).toBe(false)
		expect(equal([base], [{ ...base, project: { id: 'p', name: 'Q' } }])).toBe(false)
		expect(equal([base, { ...base, id: 'b' }], [{ ...base, id: 'b' }, base])).toBe(false)
		expect(equal([base], [])).toBe(false)
	})

	test('scalar kinds compare by value, not by structure', () => {
		expect(equal([rec({ done: false })], [rec({ done: 0 })])).toBe(false)
	})
})
