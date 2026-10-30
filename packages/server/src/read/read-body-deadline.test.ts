import { describe, expect, test } from 'vitest'
import { READ_BODY_TIMEOUT_MS, readBodyDeadlineMs } from './read-body-deadline'

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
