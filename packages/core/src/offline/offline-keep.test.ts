import { describe, expect, test } from 'vitest'
import {
	OFFLINE_PIN_LIMIT,
	OfflineKeepError,
	canonicalOfflinePinKey,
	offlinePinId,
	toOfflinePinSpec,
} from './offline-keep'

const query = (
	where: Record<string, unknown>,
	extra: { limit?: number; offset?: number; include?: string[]; orderBy?: unknown[] } = {},
) => ({ getDescriptor: () => ({ collection: 'lessons', where, ...extra }) })

describe('toOfflinePinSpec', () => {
	test('reduces a single-collection where to a pin', () => {
		expect(toOfflinePinSpec(query({ courseId: 'c1' }), { files: true })).toEqual({
			collection: 'lessons',
			where: { courseId: 'c1' },
			files: true,
		})
		expect(toOfflinePinSpec(query({})).files).toBe(false)
	})

	test('ignores orderBy', () => {
		expect(() => toOfflinePinSpec(query({}, { orderBy: [{ field: 'title' }] }))).not.toThrow()
	})

	test.each([
		['limit', { limit: 3 }],
		['offset', { offset: 1 }],
		['include', { include: ['course'] }],
	])('refuses %s with OFFLINE_KEEP_UNSUPPORTED_QUERY and a fix', (name, extra) => {
		try {
			toOfflinePinSpec(query({}, extra))
			expect.unreachable()
		} catch (error) {
			expect(error).toBeInstanceOf(OfflineKeepError)
			expect((error as OfflineKeepError).code).toBe('OFFLINE_KEEP_UNSUPPORTED_QUERY')
			expect((error as OfflineKeepError).message).toContain(name)
			expect((error as OfflineKeepError).fix).toBeTruthy()
		}
	})

	test('an empty include list is not an include', () => {
		expect(() => toOfflinePinSpec(query({}, { include: [] }))).not.toThrow()
	})

	test('refuses something that is not a query', () => {
		expect(() => toOfflinePinSpec({} as never)).toThrow(OfflineKeepError)
		expect(() => toOfflinePinSpec(null as never)).toThrow(OfflineKeepError)
	})
})

describe('offlinePinId', () => {
	test('is stable across key order, and differs by collection, where and files', async () => {
		const a = await offlinePinId(toOfflinePinSpec(query({ a: 1, b: { $gt: 2, $lt: 5 } })))
		const b = await offlinePinId(toOfflinePinSpec(query({ b: { $lt: 5, $gt: 2 }, a: 1 })))
		expect(a).toBe(b)
		expect(a).toMatch(/^pin_[0-9a-f]{32}$/)
		const files = await offlinePinId(
			toOfflinePinSpec(query({ a: 1, b: { $gt: 2, $lt: 5 } }), { files: true }),
		)
		const other = await offlinePinId(toOfflinePinSpec(query({ a: 2 })))
		expect(new Set([a, files, other]).size).toBe(3)
	})

	test('canonical text is order independent', () => {
		expect(
			canonicalOfflinePinKey({
				collection: 'x',
				where: { b: 1, a: [2, { d: 1, c: 2 }] },
				files: false,
			}),
		).toBe(
			canonicalOfflinePinKey({
				collection: 'x',
				where: { a: [2, { c: 2, d: 1 }], b: 1 },
				files: false,
			}),
		)
	})
})

test('the pin limit is 64', () => {
	expect(OFFLINE_PIN_LIMIT).toBe(64)
})
