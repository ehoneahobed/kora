import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	MAX_LIVE_VIEW_VERSIONS,
	advanceLiveViews,
	emptyLiveViews,
	liveViewFieldsCover,
	liveViewFieldsKey,
	liveViewsCurrent,
	liveViewsHeldBefore,
	parseLiveViewCursor,
	parseLiveViewFields,
	parseLiveViews,
	serializeLiveViews,
} from './live-views'

function op(id: string, type: Operation['type'], wallTime = 1): Operation {
	return {
		id,
		nodeId: 'n',
		type,
		collection: 'lessons',
		recordId: 'r',
		data: null,
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function step(
	views: ReturnType<typeof emptyLiveViews>,
	seq: number,
	type: Operation['type'],
	values: Record<string, unknown> | null,
	live = true,
	wallTime = seq,
) {
	return advanceLiveViews(views, { seq, op: op(`op-${seq}`, type, wallTime), live, values })
}

describe('live-view summaries', () => {
	test('versions are projections of live values, with the ranges they were live', () => {
		let views = emptyLiveViews(['school'])
		views = step(views, 1, 'insert', { school: 's0', title: 'a' })
		views = step(views, 2, 'update', { school: 's0', title: 'b' })
		views = step(views, 3, 'update', { school: 's1', title: 'b' })
		views = step(views, 4, 'delete', { school: 's1', title: 'b' }, false)
		views = step(views, 5, 'update', { school: 's0', title: 'c' }, false, 2)
		expect(views.versions).toEqual([
			{ values: { school: 's0' }, ranges: [[1, 3]] },
			{ values: { school: 's1' }, ranges: [[3, 4]] },
		])
		expect(views.newestDelete?.id).toBe('op-4')
		expect(views.throughSeq).toBe(5)
		expect(views.throughId).toBe('op-5')
	})

	test('advancing with an included operation changes nothing (idempotent)', () => {
		const views = step(emptyLiveViews(['school']), 3, 'insert', { school: 's0' })
		expect(step(views, 3, 'update', { school: 's1' })).toBe(views)
		expect(step(views, 2, 'update', { school: 's1' })).toBe(views)
	})

	test('a revival opens a new range of an earlier version', () => {
		let views = emptyLiveViews(['school'])
		views = step(views, 1, 'insert', { school: 's0' })
		views = step(views, 2, 'delete', { school: 's0' }, false)
		views = step(views, 3, 'update', { school: 's0' })
		expect(views.versions).toEqual([
			{
				values: { school: 's0' },
				ranges: [
					[1, 2],
					[3, null],
				],
			},
		])
	})

	test('held-before only counts ranges that began before the sequence, up to it', () => {
		let views = emptyLiveViews(['school'])
		views = step(views, 1, 'insert', { school: 's0' })
		views = step(views, 5, 'update', { school: 's1' })
		views = step(views, 9, 'delete', { school: 's1' }, false)
		const asked: Array<[string, number]> = []
		const admits = (values: Record<string, unknown>, lastSeq: number): boolean => {
			asked.push([String(values.school), lastSeq])
			return values.school === 's1'
		}
		expect(liveViewsHeldBefore(views, 5, admits)).toBe(false)
		expect(asked).toEqual([['s0', 4]])
		asked.length = 0
		expect(liveViewsHeldBefore(views, 20, admits)).toBe(true)
		expect(asked).toEqual([
			['s0', 4],
			['s1', 8],
		])
	})

	test('the newest delete is chosen by HLC, not by arrival', () => {
		let views = emptyLiveViews(['school'])
		views = step(views, 1, 'insert', { school: 's0' })
		views = step(views, 2, 'delete', null, false, 50)
		views = step(views, 3, 'delete', null, false, 10)
		expect(views.newestDelete?.id).toBe('op-2')
	})

	test('too many distinct versions overflow: the summary proves nothing any more', () => {
		let views = emptyLiveViews(['school'])
		for (let i = 0; i <= MAX_LIVE_VIEW_VERSIONS; i++) {
			views = step(views, i + 1, 'update', { school: `s${i}` })
		}
		expect(views.overflow).toBe(true)
		// A live record whose values are unknown overflows too.
		expect(step(emptyLiveViews(['school']), 1, 'insert', null).overflow).toBe(true)
	})

	test('current only when the newest operation (sequence and id) is included', () => {
		const views = step(emptyLiveViews(['school']), 7, 'insert', { school: 's0' })
		expect(liveViewsCurrent(views, { seq: 7, id: 'op-7' })).toBe(true)
		expect(liveViewsCurrent(views, { seq: 8, id: 'op-8' })).toBe(false)
		expect(liveViewsCurrent(views, { seq: 7, id: 'other' })).toBe(false)
		expect(liveViewsCurrent(views, null)).toBe(false)
	})

	test('serialized summaries round-trip; malformed ones read as absent', () => {
		const views = step(emptyLiveViews(['b', 'a', 'a']), 1, 'insert', { a: 1, b: 2 })
		expect(views.fields).toEqual(['a', 'b'])
		expect(parseLiveViews(serializeLiveViews(views))).toEqual(views)
		expect(parseLiveViews('{')).toBeNull()
		expect(parseLiveViews(JSON.stringify({ ...views, throughId: 3 }))).toBeNull()
		expect(parseLiveViews(null)).toBeNull()
	})

	test('field sets: canonical keys, coverage, parsing', () => {
		expect(liveViewFieldsKey(['b', 'a', 'b'])).toBe('["a","b"]')
		expect(liveViewFieldsCover(['a', 'b'], ['b'])).toBe(true)
		expect(liveViewFieldsCover(['a'], ['a', 'b'])).toBe(false)
		expect(parseLiveViewFields('["b","a"]')).toEqual(['a', 'b'])
		expect(parseLiveViewFields('nope')).toEqual([])
		expect(parseLiveViewCursor('{"fields":"[]","after":null}')).toEqual({
			fields: '[]',
			after: null,
		})
		expect(parseLiveViewCursor('{"fields":1}')).toBeNull()
	})
})
