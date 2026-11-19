import { describe, expect, test } from 'vitest'
import {
	READ_BODY_TIMEOUT_MS,
	readBodyDeadlineMs,
	routeBodyCeilingMs,
	routeBodyDeadlineMs,
} from './read-body-deadline'

describe('readBodyDeadlineMs', () => {
	test('a small declared body gets a short deadline', () => {
		expect(readBodyDeadlineMs(0)).toBe(2_000)
		expect(readBodyDeadlineMs(1_000)).toBe(3_000)
		expect(readBodyDeadlineMs(1_025)).toBe(4_000)
	})

	test('a large declared body is capped at the full deadline', () => {
		expect(readBodyDeadlineMs(512 * 1024)).toBe(READ_BODY_TIMEOUT_MS)
		expect(readBodyDeadlineMs(8 * 1024)).toBe(10_000)
		expect(readBodyDeadlineMs(7 * 1024)).toBe(9_000)
	})

	test('no or invalid length (chunked) gets the full deadline', () => {
		expect(readBodyDeadlineMs(Number.NaN)).toBe(READ_BODY_TIMEOUT_MS)
		expect(readBodyDeadlineMs(-1)).toBe(READ_BODY_TIMEOUT_MS)
		expect(readBodyDeadlineMs(Number.POSITIVE_INFINITY)).toBe(READ_BODY_TIMEOUT_MS)
	})
})

describe('routeBodyDeadlineMs: the ceiling follows the body limit', () => {
	test('the default ceiling lets the largest allowed body arrive at 16 KiB/s', () => {
		// 1 MiB (the default limit): 2 s grace + 64 s at 16 KiB/s.
		expect(routeBodyCeilingMs(1024 * 1024)).toBe(66_000)
		// 10 MiB: 2 s + 640 s.
		expect(routeBodyCeilingMs(10 * 1024 * 1024)).toBe(642_000)
		// A small limit never goes below 30 s.
		expect(routeBodyCeilingMs(64 * 1024)).toBe(30_000)
	})

	test('a 1 MiB body near the default limit is allowed its 66 s, not a flat 30 s', () => {
		const ceiling = routeBodyCeilingMs(1024 * 1024)
		expect(routeBodyDeadlineMs(1024 * 1024, ceiling)).toBe(66_000)
	})

	test('the minimum-rate rule is unchanged for small bodies', () => {
		expect(routeBodyDeadlineMs(512, routeBodyCeilingMs(1024 * 1024))).toBe(3_000)
		expect(routeBodyDeadlineMs(10 * 1024, routeBodyCeilingMs(1024 * 1024))).toBe(12_000)
	})

	test('a configured ceiling is used as given, for every body', () => {
		expect(routeBodyDeadlineMs(1024 * 1024, 120_000)).toBe(120_000)
		expect(routeBodyDeadlineMs(512, 1_000)).toBe(1_000)
		// No or invalid length (chunked): the ceiling.
		expect(routeBodyDeadlineMs(Number.NaN, 120_000)).toBe(120_000)
	})
})

describe('routeBodyCeilingMs stays within what a timer can wait (review of #323)', () => {
	// Node fires a setTimeout above 2^31-1 ms after ~1 ms: an unclamped ceiling would answer
	// every body 408 at once.
	test('a huge body limit gives at most 2^31-1 ms', () => {
		expect(routeBodyCeilingMs(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(2 ** 31 - 1)
		expect(routeBodyCeilingMs(64 * 1024 ** 3)).toBeLessThanOrEqual(2 ** 31 - 1)
	})
})
